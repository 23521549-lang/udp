import { z } from "zod";
import { createPipelineStepAdapter } from "../../adapter-base/pipeline-steps.js";
import { repoPathSchema } from "../../adapter-base/state-backend.js";

/**
 * Adapter Ansible (§5.5 Infrastructure IaC, Plan #37) — họ bước pipeline: chạy playbook trước khi
 * dựng image. Agentless nên không có state; mặc định `--check --diff` (xem trước), chạy thật khi
 * người dùng bật.
 *
 * Khoá SSH (và mật khẩu vault nếu dùng) là biến bí mật của CI — bước ghi chúng ra tệp tạm TRONG
 * container của bước, không bao giờ vào template hay repo.
 */

export const ansibleConfigSchema = z.object({
  playbook: repoPathSchema.default("ansible/site.yml"),
  inventory: repoPathSchema.default("ansible/inventory"),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default("2.18.1"),
  useVault: z.boolean().default(false),
  checkOnly: z.boolean().default(true),
});

const { adapter, pipelineSteps } = createPipelineStepAdapter({
  domainType: "INFRA",
  toolId: "ansible",
  version: "1.0.0",
  provides: "infra.provision",
  attributes: { provider: "ansible" },
  configSchema: ansibleConfigSchema,
  describe: (config) => {
    const parsed = ansibleConfigSchema.parse(config);
    return {
      playbook: parsed.playbook,
      inventory: parsed.inventory,
      version: parsed.version,
      mode: parsed.checkOnly ? "check" : "apply",
    };
  },
  steps: (config) => {
    const parsed = ansibleConfigSchema.parse(config);
    const run = [
      `ansible-playbook -i ${parsed.inventory} ${parsed.playbook}`,
      "--private-key /tmp/udp_ssh_key",
      '-e "udp_environment=$UDP_ENVIRONMENT"',
      ...(parsed.useVault ? ["--vault-password-file /tmp/udp_vault"] : []),
      ...(parsed.checkOnly ? ["--check --diff"] : []),
    ].join(" ");
    return [
      {
        name: parsed.checkOnly ? "check" : "playbook",
        phase: "before-build",
        image: `alpine/ansible:${parsed.version}`,
        commands: [
          'echo "$ANSIBLE_SSH_PRIVATE_KEY" > /tmp/udp_ssh_key',
          "chmod 600 /tmp/udp_ssh_key",
          ...(parsed.useVault
            ? ['echo "$ANSIBLE_VAULT_PASSWORD" > /tmp/udp_vault']
            : []),
          run,
        ],
        env: { ANSIBLE_HOST_KEY_CHECKING: "True", ANSIBLE_FORCE_COLOR: "0" },
        secretEnv: [
          "ANSIBLE_SSH_PRIVATE_KEY",
          ...(parsed.useVault ? ["ANSIBLE_VAULT_PASSWORD"] : []),
        ],
      },
    ];
  },
});

export { pipelineSteps };
export default adapter;

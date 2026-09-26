import { z } from "zod";
import { createPipelineStepAdapter } from "../../adapter-base/pipeline-steps.js";
import {
  backendCredentialEnv,
  describeBackend,
  repoPathSchema,
  stateBackendSchema,
  stateKey,
  type StateBackend,
} from "../../adapter-base/state-backend.js";

/**
 * Adapter Terraform (§5.5 Infrastructure IaC, Plan #37) — họ bước pipeline: không "bật" gì trong
 * cluster, góp bước `plan` (và `apply` khi bật) vào pipeline của CI đang bật, TRƯỚC khi dựng image.
 *
 * Backend do UDP cấu hình (QĐ-4): mã HCL của khách khai một khối backend RỖNG cùng loại
 * (`backend "s3" {}`), bước điền bucket, khoá theo project và environment, và khoá chống ghi đồng
 * thời bằng `-backend-config`. Mặc định chỉ `plan`: áp hạ tầng từ mỗi lần push là quyết định của
 * người dùng, không của nền tảng.
 */

export const terraformConfigSchema = z.object({
  workingDirectory: repoPathSchema.default("infra"),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default("1.9.8"),
  backend: stateBackendSchema,
  autoApply: z.boolean().default(false),
});

function backendArgs(backend: StateBackend, key: string): string[] {
  switch (backend.kind) {
    case "s3":
      return [
        `bucket=${backend.bucket}`,
        `key=${key}/terraform.tfstate`,
        `region=${backend.region}`,
        "use_lockfile=true",
      ];
    case "gcs":
      return [`bucket=${backend.bucket}`, `prefix=${key}`];
    case "azurerm":
      return [
        `storage_account_name=${backend.storageAccount}`,
        `container_name=${backend.container}`,
        `resource_group_name=${backend.resourceGroup}`,
        `key=${key}.tfstate`,
        "use_oidc=true",
      ];
  }
}

const { adapter, pipelineSteps } = createPipelineStepAdapter({
  domainType: "INFRA",
  toolId: "terraform",
  version: "1.0.0",
  provides: "infra.provision",
  attributes: { provider: "terraform" },
  configSchema: terraformConfigSchema,
  describe: (config) => {
    const parsed = terraformConfigSchema.parse(config);
    return {
      workingDirectory: parsed.workingDirectory,
      version: parsed.version,
      backend: describeBackend(parsed.backend),
      mode: parsed.autoApply ? "plan+apply" : "plan",
    };
  },
  steps: (config, project) => {
    const parsed = terraformConfigSchema.parse(config);
    const dir = `-chdir=${parsed.workingDirectory}`;
    const init = [
      `terraform ${dir} init -input=false`,
      ...backendArgs(parsed.backend, stateKey(project.slug)).map(
        (arg) => `-backend-config="${arg}"`,
      ),
    ].join(" ");
    return [
      {
        name: "plan",
        phase: "before-build",
        image: `hashicorp/terraform:${parsed.version}`,
        commands: [
          init,
          `terraform ${dir} plan -input=false -var="environment=$UDP_ENVIRONMENT" -out=tfplan`,
          ...(parsed.autoApply
            ? [`terraform ${dir} apply -input=false tfplan`]
            : []),
        ],
        env: { TF_IN_AUTOMATION: "1" },
        secretEnv: backendCredentialEnv(parsed.backend),
      },
    ];
  },
});

export { pipelineSteps };
export default adapter;

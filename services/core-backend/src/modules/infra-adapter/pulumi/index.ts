import { stepImage } from "@udp/config";
import { z } from "zod";
import {
  createPipelineStepAdapter,
  stepVersionSchema,
} from "../../adapter-base/pipeline-steps.js";
import {
  backendCredentialEnv,
  describeBackend,
  repoPathSchema,
  stateBackendSchema,
  type StateBackend,
} from "../../adapter-base/state-backend.js";

/**
 * Adapter Pulumi (§5.5 Infrastructure IaC, Plan #37) — họ bước pipeline, cùng khuôn Terraform:
 * `preview` (và `up` khi bật) trước khi dựng image, backend TỰ QUẢN do UDP cấu hình (QĐ-4).
 *
 * Backend tự quản mã hoá cấu hình bí mật của stack bằng passphrase — biến bí mật
 * `PULUMI_CONFIG_PASSPHRASE` của CI, không bao giờ trong template. Stack = environment; đường
 * backend có tiền tố `udp/<project>` nên hai project dùng chung bucket không thấy stack của nhau.
 */

const RUNTIMES = ["nodejs", "python", "go"] as const;

/** Cài phụ thuộc của chương trình Pulumi theo runtime */
const INSTALL: Record<(typeof RUNTIMES)[number], string | null> = {
  nodejs: "npm ci",
  python: "pip install -r requirements.txt",
  go: null,
};

export const pulumiConfigSchema = z.object({
  workingDirectory: repoPathSchema.default("infra"),
  runtime: z.enum(RUNTIMES).default("nodejs"),
  // Ba runtime cùng một tập phiên bản ghim (test của @udp/config giữ điều đó)
  version: stepVersionSchema("pulumi-nodejs"),
  backend: stateBackendSchema,
  autoApply: z.boolean().default(false),
});

function backendUrl(backend: StateBackend, projectSlug: string): string {
  const prefix = `udp/${projectSlug}`;
  switch (backend.kind) {
    case "s3":
      return `s3://${backend.bucket}/${prefix}?region=${backend.region}&awssdk=v2`;
    case "gcs":
      return `gs://${backend.bucket}/${prefix}`;
    case "azurerm":
      return `azblob://${backend.container}/${prefix}?storage_account=${backend.storageAccount}`;
  }
}

const { adapter, pipelineSteps } = createPipelineStepAdapter({
  domainType: "INFRA",
  toolId: "pulumi",
  version: "1.0.0",
  provides: "infra.provision",
  attributes: { provider: "pulumi" },
  configSchema: pulumiConfigSchema,
  describe: (config) => {
    const parsed = pulumiConfigSchema.parse(config);
    return {
      workingDirectory: parsed.workingDirectory,
      runtime: parsed.runtime,
      version: parsed.version,
      backend: describeBackend(parsed.backend),
      mode: parsed.autoApply ? "preview+up" : "preview",
    };
  },
  steps: (config, project) => {
    const parsed = pulumiConfigSchema.parse(config);
    const cwd = `--cwd ${parsed.workingDirectory}`;
    const install = INSTALL[parsed.runtime];
    return [
      {
        name: parsed.autoApply ? "up" : "preview",
        phase: "before-build",
        image: stepImage(`pulumi-${parsed.runtime}`, parsed.version),
        commands: [
          ...(install === null
            ? []
            : [`cd ${parsed.workingDirectory}`, install, "cd -"]),
          `pulumi login "${backendUrl(parsed.backend, project.slug)}"`,
          `pulumi ${cwd} stack select --create "$UDP_ENVIRONMENT"`,
          parsed.autoApply
            ? `pulumi ${cwd} up --yes --non-interactive`
            : `pulumi ${cwd} preview --non-interactive`,
        ],
        env: { PULUMI_SKIP_UPDATE_CHECK: "true" },
        secretEnv: [
          "PULUMI_CONFIG_PASSPHRASE",
          ...backendCredentialEnv(parsed.backend),
        ],
      },
    ];
  },
});

export { pipelineSteps };
export default adapter;

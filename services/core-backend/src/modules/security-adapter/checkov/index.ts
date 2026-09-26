import { z } from "zod";
import { createPipelineStepAdapter } from "../../adapter-base/pipeline-steps.js";
import { repoPathSchema } from "../../adapter-base/state-backend.js";

/**
 * Adapter Checkov (§5.5 Security Scanning, Plan #37) — họ bước pipeline: quét IaC (Terraform,
 * manifest Kubernetes, Helm chart, Dockerfile) TRƯỚC khi dựng image; cấu hình sai chặn pipeline,
 * trừ khi người dùng chọn chỉ báo (`softFail`).
 */

const FRAMEWORKS = [
  "terraform",
  "kubernetes",
  "helm",
  "dockerfile",
  "cloudformation",
] as const;

export const checkovConfigSchema = z.object({
  directory: repoPathSchema.default("."),
  frameworks: z
    .array(z.enum(FRAMEWORKS))
    .min(1)
    .refine((f) => new Set(f).size === f.length, "framework lặp")
    .default(["terraform", "kubernetes", "dockerfile"]),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default("3.2.255"),
  softFail: z.boolean().default(false),
});

/** Thứ tự chuẩn — cùng tập framework thì cùng lệnh, drift không báo giả */
const frameworksOf = (chosen: readonly string[]): string =>
  FRAMEWORKS.filter((f) => chosen.includes(f)).join(",");

const { adapter, pipelineSteps } = createPipelineStepAdapter({
  domainType: "SECURITY",
  toolId: "checkov",
  version: "1.0.0",
  provides: "security.scan",
  attributes: { provider: "checkov", kinds: "iac" },
  configSchema: checkovConfigSchema,
  describe: (config) => {
    const parsed = checkovConfigSchema.parse(config);
    return {
      directory: parsed.directory,
      frameworks: frameworksOf(parsed.frameworks),
      version: parsed.version,
      onFinding: parsed.softFail ? "report" : "fail",
    };
  },
  steps: (config) => {
    const parsed = checkovConfigSchema.parse(config);
    return [
      {
        name: "quet-iac",
        phase: "before-build",
        image: `bridgecrew/checkov:${parsed.version}`,
        commands: [
          [
            `checkov -d ${parsed.directory}`,
            `--framework ${frameworksOf(parsed.frameworks)}`,
            "--compact --quiet",
            ...(parsed.softFail ? ["--soft-fail"] : []),
          ].join(" "),
        ],
        env: {},
        secretEnv: [],
      },
    ];
  },
});

export { pipelineSteps };
export default adapter;

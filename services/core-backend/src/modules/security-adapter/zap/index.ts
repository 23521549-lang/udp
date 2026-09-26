import { z } from "zod";
import { createPipelineStepAdapter } from "../../adapter-base/pipeline-steps.js";

/**
 * Adapter OWASP ZAP (§5.5 Security Scanning, Plan #37) — họ bước pipeline: DAST baseline (quét
 * thụ động, không tấn công) trên URL của environment đích, SAU khi dựng image.
 *
 * Deploy là bất đồng bộ (§8.3 — pipeline không chờ UDP áp image), nên bước quét bản ĐANG phục vụ
 * ở environment đó, không phải image vừa dựng (QĐ-9). Environment không có URL mục tiêu ⇒ bước
 * bỏ qua với một dòng nói rõ, không hỏng pipeline.
 */

const envName = z.string().regex(/^[a-z0-9-]{1,50}$/);
/** URL mục tiêu — cấm ký tự mà template của sáu CI không chở được nguyên văn */
const targetUrl = z
  .string()
  .url()
  .regex(/^https?:\/\/[^\s'"\\%$`;|&<>()]+$/);

export const zapConfigSchema = z.object({
  targets: z
    .record(envName, targetUrl)
    .refine((t) => Object.keys(t).length > 0, "cần ít nhất một mục tiêu"),
  failOnWarnings: z.boolean().default(false),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default("2.15.0"),
});

const { adapter, pipelineSteps } = createPipelineStepAdapter({
  domainType: "SECURITY",
  toolId: "zap",
  version: "1.0.0",
  provides: "security.scan",
  attributes: { provider: "zap", kinds: "dast" },
  configSchema: zapConfigSchema,
  describe: (config) => {
    const parsed = zapConfigSchema.parse(config);
    return {
      targets: Object.entries(parsed.targets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([env, url]) => `${env}=${url}`)
        .join(" "),
      onWarning: parsed.failOnWarnings ? "fail" : "report",
      version: parsed.version,
    };
  },
  steps: (config) => {
    const parsed = zapConfigSchema.parse(config);
    const cases = Object.entries(parsed.targets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([env, url]) => `${env}) TARGET=${url} ;;`)
      .join(" ");
    return [
      {
        name: "quet-dast",
        phase: "after-build",
        image: `ghcr.io/zaproxy/zaproxy:${parsed.version}`,
        commands: [
          `case "$UDP_ENVIRONMENT" in ${cases} *) TARGET= ;; esac`,
          '[ -n "$TARGET" ] || { echo "ZAP: environment $UDP_ENVIRONMENT không có URL mục tiêu"; exit 0; }',
          [
            'zap-baseline.py -t "$TARGET"',
            ...(parsed.failOnWarnings ? [] : ["-I"]),
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

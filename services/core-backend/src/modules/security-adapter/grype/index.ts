import { stepImage } from "@udp/config";
import { z } from "zod";
import {
  createPipelineStepAdapter,
  stepVersionSchema,
} from "../../adapter-base/pipeline-steps.js";

/**
 * Adapter Grype (§5.5 Security Scanning, Plan #37) — họ bước pipeline: quét lỗ hổng của ĐÚNG image
 * vừa đẩy (`$IMAGE_REF`) SAU khi dựng; lỗ hổng từ mức đã chọn trở lên làm pipeline hỏng, nên bước
 * "báo UDP" gửi `failure` và image đó không bao giờ được deploy.
 *
 * Registry riêng: Grype đọc thông tin đăng nhập từ ba biến `GRYPE_REGISTRY_AUTH_*` của CI.
 */

export const grypeConfigSchema = z.object({
  failOn: z.enum(["critical", "high", "medium", "low"]).default("high"),
  onlyFixed: z.boolean().default(true),
  version: stepVersionSchema("grype"),
});

const { adapter, pipelineSteps } = createPipelineStepAdapter({
  domainType: "SECURITY",
  toolId: "grype",
  version: "1.0.0",
  provides: "security.scan",
  attributes: { provider: "grype", kinds: "image" },
  configSchema: grypeConfigSchema,
  describe: (config) => {
    const parsed = grypeConfigSchema.parse(config);
    return {
      failOn: parsed.failOn,
      onlyFixed: String(parsed.onlyFixed),
      version: parsed.version,
    };
  },
  steps: (config) => {
    const parsed = grypeConfigSchema.parse(config);
    return [
      {
        name: "quet-image",
        phase: "after-build",
        image: stepImage("grype", parsed.version),
        commands: [
          [
            'grype "registry:$IMAGE_REF"',
            `--fail-on ${parsed.failOn}`,
            ...(parsed.onlyFixed ? ["--only-fixed"] : []),
          ].join(" "),
        ],
        env: {},
        secretEnv: [
          "GRYPE_REGISTRY_AUTH_AUTHORITY",
          "GRYPE_REGISTRY_AUTH_USERNAME",
          "GRYPE_REGISTRY_AUTH_PASSWORD",
        ],
      },
    ];
  },
});

export { pipelineSteps };
export default adapter;

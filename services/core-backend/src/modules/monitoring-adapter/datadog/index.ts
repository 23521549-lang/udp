import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createSaaSAdapter } from "../../adapter-base/saas.js";

/**
 * [v4.10] Adapter THẬT thứ hai — Datadog, họ SaaS.
 *
 * Nó tồn tại trong plan này không phải để "có thêm một tool" mà để trả lời một câu hỏi về
 * kiến trúc: **hai họ adapter khác nhau về căn bản có đi qua CÙNG một bộ hợp đồng không?**
 * Prometheus cài một Helm chart và không gọi ra ngoài; Datadog không cài gì và chỉ gọi
 * API. Nếu cả hai qua đủ 42 phép mà không phải nới lỏng phép nào, luận điểm pluggable
 * được chứng minh bằng thực nghiệm — và số nới lỏng là 0, khớp `docs/E1-relaxations.json`.
 *
 * **`metrics.query` là 1.0.0, KHÔNG phải 2.0.0**, và đó là ví dụ của chính §5.3: version
 * của capability phân biệt NGÔN NGỮ truy vấn. Datadog nói DQL, Prometheus nói PromQL.
 * Flagger khai `constraint: "^2"` nên Datadog **không thoả** — validator báo
 * `VERSION_MISMATCH` thay vì bind một provider nói thứ tiếng mà consumer không hiểu. Đây
 * là ca mà bộ resolver của P15 chạy `verifyChosen` để bắt.
 */

export const datadogConfigSchema = z.object({
  /** `datadoghq.com`, `datadoghq.eu`... — quyết định nơi dữ liệu nằm */
  site: z.enum(["datadoghq.com", "datadoghq.eu", "ap1.datadoghq.com"]),
  /** Tên credential đã lưu ở `cloud_credentials`; KHÔNG phải giá trị khoá */
  credentialRef: z.string().min(1),
  /** Số host tối đa gửi metrics — ảnh hưởng hoá đơn của khách */
  maxHosts: z.number().int().min(1).max(10_000).default(50),
});

const adapter: DomainAdapter = createSaaSAdapter({
  domainType: "MONITORING",
  toolId: "datadog",
  version: "1.0.0",
  capabilities: {
    provides: [
      { id: "metrics.query", version: "1.0.0" },
      { id: "logs.sink", version: "1.0.0" },
    ],
    requires: [],
    recommends: ["traces.sink"],
  },
  configSchema: datadogConfigSchema,
  apiHost: "api.datadoghq.com",
  connectionName: "udp-datadog-connection",
  quotaDimensions: [],
  /** Khớp `ignoredLabelPrefixes` của fixture — xem chú thích tương tự ở prometheus-grafana */
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/"],

  configurePath: () => "/api/v1/integration/udp",
  configureBody: (config) => {
    const parsed = datadogConfigSchema.parse(config);
    return {
      site: parsed.site,
      maxHosts: parsed.maxHosts,
      /**
       * Gửi TÊN credential, không gửi giá trị.
       *
       * Giá trị khoá đi trong header `Authorization` do egress guard gắn, nên nó không
       * bao giờ nằm trong thân request — và thân request là thứ có thể vọng lại trong một
       * thông điệp lỗi của nhà cung cấp.
       */
      credentialRef: parsed.credentialRef,
    };
  },

  bindings: () => [
    {
      id: "metrics.query",
      version: "1.0.0",
      providedBy: "monitoring:datadog",
      endpoint: "https://api.datadoghq.com/api/v1/query",
    },
    {
      id: "logs.sink",
      version: "1.0.0",
      providedBy: "monitoring:datadog",
      endpoint: "https://http-intake.logs.datadoghq.com/api/v2/logs",
    },
  ],
});

export default adapter;

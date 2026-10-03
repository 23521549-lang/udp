import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import {
  DATADOG_SITES,
  datadogApiHost,
  type MetricsSourceDeclaration,
} from "@udp/metrics-provider";
import { logsSinkBinding } from "../../adapter-base/logs-sink.js";
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
  site: z.enum(DATADOG_SITES),
  /**
   * Khoá API (32 hex) và khoá ứng dụng (40 hex) — BÍ MẬT (Plan #31 QĐ-6): niêm phong khi
   * lưu, không lên dây, chỉ mở trong bộ nhớ worker. Định dạng chặt để bắt lỗi dán nhầm
   * khoá này vào ô kia trước khi Datadog trả 403.
   */
  apiKey: z
    .string()
    .regex(/^[0-9a-f]{32}$/i)
    .describe("secret"),
  appKey: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .describe("secret"),
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
  apiHost: (config) => datadogApiHost(datadogConfigSchema.parse(config).site),
  connectionName: "udp-datadog-connection",
  quotaDimensions: [],
  /** Khớp `ignoredLabelPrefixes` của fixture — xem chú thích tương tự ở prometheus-grafana */
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/"],

  configurePath: () => "/api/v1/integration/udp",
  /**
   * Thân request KHÔNG mang khoá: khoá đi trong header, vì thân request là thứ có thể
   * vọng lại trong một thông điệp lỗi của nhà cung cấp.
   */
  configureBody: (config) => {
    const parsed = datadogConfigSchema.parse(config);
    return { site: parsed.site, maxHosts: parsed.maxHosts };
  },
  authHeaders: (config) => {
    const parsed = datadogConfigSchema.parse(config);
    return {
      "DD-API-KEY": parsed.apiKey,
      "DD-APPLICATION-KEY": parsed.appKey,
    };
  },
  /** Chỉ khoá ingest vào cluster cho log shipper; khoá ứng dụng (đọc/ghi cấu hình) ở lại UDP */
  secretValues: (config) => ({
    "api-key": datadogConfigSchema.parse(config).apiKey,
  }),

  /** Endpoint theo vùng dữ liệu của tài khoản — site EU mà trỏ Mỹ là 403 hay mất dữ liệu */
  bindings: (_ctx, config) => {
    const { site } = datadogConfigSchema.parse(config);
    return [
      {
        id: "metrics.query",
        version: "1.0.0",
        providedBy: "monitoring:datadog",
        endpoint: `https://${datadogApiHost(site)}/api/v1/query`,
      },
      // logs.sink@1 (Plan #32): khoá ingest nằm trong Secret kết nối mà lớp nền SaaS ghi
      logsSinkBinding("monitoring:datadog", {
        protocol: "datadog",
        endpoint: `https://http-intake.logs.${site}/api/v2/logs`,
        credential: {
          secretName: "udp-datadog-connection-key",
          secretKey: "api-key",
        },
      }),
    ];
  },
});

export default adapter;

/** §5.4: nguồn metrics của canary analysis — cùng site và khoá mà adapter đã cấu hình */
export const metricsSource: MetricsSourceDeclaration = {
  kind: "datadog",
  of: (config) => {
    const { site, apiKey, appKey } = datadogConfigSchema.parse(config);
    return { kind: "datadog", site, apiKey, appKey };
  },
};

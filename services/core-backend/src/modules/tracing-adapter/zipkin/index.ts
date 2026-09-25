import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Zipkin (§5.5 Tracing, Plan #31) — họ Helm, không gọi ra ngoài.
 *
 * Chart chính thức của OpenZipkin, lưu trữ trong bộ nhớ có trần số span (`MEM_MAX_SPANS`): nhẹ
 * nhất trong ba tool tracing, và là lựa chọn khi chỉ cần xem trace gần đây — mất khi pod khởi
 * động lại, nên KHÔNG tiêu thụ quota lưu trữ.
 *
 * Nhận Zipkin v2 JSON (`/api/v2/spans`), không phải OTLP ⇒ `traces.sink` **2.0.0**: major là giao
 * thức dây. Một consumer chỉ nói OTLP khai `constraint: "^1"` và validator báo `VERSION_MISMATCH`
 * thay vì bind nó vào một endpoint trả 404 cho mọi span.
 */

export const zipkinConfigSchema = z.object({
  /** Trần span giữ trong bộ nhớ — vượt thì span cũ nhất bị bỏ */
  maxSpans: z.number().int().min(10_000).max(5_000_000).default(500_000),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "TRACING",
  toolId: "zipkin",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "traces.sink", version: "2.0.0" }],
    requires: [],
  },
  configSchema: zipkinConfigSchema,
  chart: {
    name: "zipkin",
    version: "0.3.6",
    repo: "https://openzipkin.github.io/zipkin",
  },
  releaseName: "udp-zipkin",
  /** Lưu trong bộ nhớ — không PVC, không chiều quota nào */
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => ({
    zipkin: {
      storage: { type: "mem" },
      extraEnv: {
        MEM_MAX_SPANS: String(zipkinConfigSchema.parse(config).maxSpans),
      },
    },
  }),

  bindings: (ctx) => [
    {
      id: "traces.sink",
      version: "2.0.0",
      providedBy: "tracing:zipkin",
      endpoint: `http://udp-zipkin.${ctx.systemNamespace}:9411/api/v2/spans`,
    },
  ],
});

export default adapter;

import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Jaeger (§5.5 Tracing, Plan #31) — họ Helm, không gọi ra ngoài.
 *
 * All-in-one với lưu trữ Badger trên PVC: đủ cho một project (chưa cần cụm Cassandra hay
 * Elasticsearch), và giữ được trace qua lần pod khởi động lại — bộ nhớ thuần thì không.
 * Nhận OTLP/HTTP, nên `traces.sink` là **1.0.0**: major của capability này là GIAO THỨC dây
 * (1 = OTLP, 2 = Zipkin v2 JSON), cùng cách §5.3 dùng major cho ngôn ngữ truy vấn.
 */

export const jaegerConfigSchema = z.object({
  /** Giữ trace bao lâu — Badger dọn theo TTL */
  retentionHours: z.number().int().min(1).max(720).default(72),
  /** Kích cỡ PVC của Badger, GiB */
  storageGb: z.number().int().min(1).max(500).default(10),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "TRACING",
  toolId: "jaeger",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "traces.sink", version: "1.0.0" }],
    requires: [],
  },
  configSchema: jaegerConfigSchema,
  chart: helmChart("jaeger"),
  releaseName: "udp-jaeger",
  /** Badger giữ trace trên PVC — quota lưu trữ bằng 0 thì phải từ chối */
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = jaegerConfigSchema.parse(config);
    return {
      provisionDataStore: { cassandra: false, elasticsearch: false },
      allInOne: {
        enabled: true,
        extraEnv: [
          { name: "COLLECTOR_OTLP_ENABLED", value: "true" },
          {
            name: "BADGER_SPAN_STORE_TTL",
            value: `${String(parsed.retentionHours)}h`,
          },
        ],
      },
      storage: {
        type: "badger",
        badger: {
          ephemeral: false,
          persistence: { size: `${String(parsed.storageGb)}Gi` },
        },
      },
      agent: { enabled: false },
      collector: { enabled: false },
      query: { enabled: false },
    };
  },

  bindings: (ctx) => [
    {
      id: "traces.sink",
      version: "1.0.0",
      providedBy: "tracing:jaeger",
      endpoint: `http://udp-jaeger-collector.${ctx.systemNamespace}:4318`,
    },
  ],
});

export default adapter;

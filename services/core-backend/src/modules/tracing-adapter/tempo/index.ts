import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Grafana Tempo (§5.5 Tracing, Plan #31) — họ Helm, không gọi ra ngoài.
 *
 * Chart `tempo` một tiến trình (monolithic) với lưu trữ cục bộ trên PVC: một project không cần
 * bản microservices cùng object storage. Nhận OTLP (gRPC 4317, HTTP 4318) ⇒ `traces.sink`
 * **1.0.0** — cùng giao thức với Jaeger, nên đổi qua lại giữa hai tool không đòi consumer đổi gì.
 */

export const tempoConfigSchema = z.object({
  /** Giữ trace bao lâu — compactor của Tempo xoá block quá hạn */
  retentionHours: z.number().int().min(1).max(720).default(72),
  /** Kích cỡ PVC, GiB */
  storageGb: z.number().int().min(1).max(500).default(10),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "TRACING",
  toolId: "tempo",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "traces.sink", version: "1.0.0" }],
    requires: [],
  },
  configSchema: tempoConfigSchema,
  chart: helmChart("tempo"),
  releaseName: "udp-tempo",
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = tempoConfigSchema.parse(config);
    return {
      tempo: {
        retention: `${String(parsed.retentionHours)}h`,
        receivers: {
          otlp: {
            protocols: {
              grpc: { endpoint: "0.0.0.0:4317" },
              http: { endpoint: "0.0.0.0:4318" },
            },
          },
        },
      },
      persistence: { enabled: true, size: `${String(parsed.storageGb)}Gi` },
    };
  },

  bindings: (ctx) => [
    {
      id: "traces.sink",
      version: "1.0.0",
      providedBy: "tracing:tempo",
      endpoint: `http://udp-tempo.${ctx.systemNamespace}:4318`,
    },
  ],
});

export default adapter;

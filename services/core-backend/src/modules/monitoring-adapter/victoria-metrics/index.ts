import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import type { MetricsSourceDeclaration } from "@udp/metrics-provider";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter VictoriaMetrics (§5.5 Monitoring, Plan #31) — họ Helm, không gọi ra ngoài.
 *
 * `victoria-metrics-k8s-stack` cài operator, vmsingle (lưu trữ + truy vấn), vmagent (scrape
 * `/metrics` của Golden Path) và Grafana. API truy vấn tương thích Prometheus, nên
 * `metrics.query` là **2.1.0** (QĐ-4): cùng họ PromQL với Prometheus (2.0.0) và thoả Flagger
 * (`^2`); bản phụ .1 ghi nhận MetricsQL là tập mở rộng của PromQL. Là nguồn trong cluster: chỉ
 * tới được qua API-server service proxy (ADR-06).
 */

export const victoriaMetricsConfigSchema = z.object({
  /** Số ngày giữ metrics — dung lượng đĩa đi theo nó */
  retentionDays: z.number().int().min(1).max(365),
  /** Kích cỡ PVC của vmsingle, GiB */
  storageGb: z.number().int().min(1).max(1000).default(20),
  /** Cài kèm Grafana với dashboard của stack */
  grafana: z.boolean().default(true),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "MONITORING",
  toolId: "victoria-metrics",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [
      { id: "metrics.query", version: "2.1.0" },
      { id: "metrics.scrape", version: "1.0.0" },
    ],
    requires: [],
    recommends: ["logs.sink"],
  },
  configSchema: victoriaMetricsConfigSchema,
  chart: {
    name: "victoria-metrics-k8s-stack",
    version: "0.25.17",
    repo: "https://victoriametrics.github.io/helm-charts",
  },
  releaseName: "udp-vm",
  /** vmsingle giữ dữ liệu trên PVC — phải từ chối khi quota lưu trữ bằng 0 */
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = victoriaMetricsConfigSchema.parse(config);
    return {
      // Tên cố định ⇒ service `vmsingle-udp-vm` ổn định cho binding
      fullnameOverride: "udp-vm",
      vmsingle: {
        enabled: true,
        spec: {
          retentionPeriod: `${String(parsed.retentionDays)}d`,
          storage: {
            resources: {
              requests: { storage: `${String(parsed.storageGb)}Gi` },
            },
          },
        },
      },
      vmagent: { enabled: true },
      grafana: { enabled: parsed.grafana },
      alertmanager: { enabled: false },
    };
  },

  bindings: (ctx) => [
    {
      id: "metrics.query",
      version: "2.1.0",
      providedBy: "monitoring:victoria-metrics",
      endpoint: `http://vmsingle-udp-vm.${ctx.systemNamespace}:8429`,
    },
    {
      id: "metrics.scrape",
      version: "1.0.0",
      providedBy: "monitoring:victoria-metrics",
      endpoint: `http://vmsingle-udp-vm.${ctx.systemNamespace}:8429/api/v1/write`,
    },
  ],
});

export default adapter;

/** §5.4: PromQL trên vmsingle TRONG cluster — qua API-server service proxy (ADR-06) */
export const metricsSource: MetricsSourceDeclaration = {
  kind: "prometheus",
  of: (_config, binding) => {
    if (binding.endpoint === undefined) {
      throw new Error(
        "binding metrics.query của victoria-metrics thiếu endpoint",
      );
    }
    return { kind: "prometheus", baseUrl: binding.endpoint, inCluster: true };
  },
};

import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { logsSinkBinding } from "../../adapter-base/logs-sink.js";

/**
 * Adapter Loki + Grafana (§5.5 Logging, Plan #32) — họ Helm, ba release, không gọi ra ngoài.
 *
 * `loki` chế độ SingleBinary với lưu trữ filesystem trên PVC (một project không cần object
 * storage), `promtail` thu log container đẩy vào gateway của Loki, `grafana` có sẵn nguồn dữ
 * liệu Loki. Ba release là MỘT tool: bật cùng nhau, gỡ ngược thứ tự (Plan #32 QĐ, companions).
 *
 * `logs.sink` giao thức `loki`, không khoá: gateway chỉ mở trong cluster.
 */

export const lokiConfigSchema = z.object({
  /** Giữ log bao lâu — compactor của Loki xoá chunk quá hạn */
  retentionHours: z.number().int().min(24).max(8760).default(168),
  /** Kích cỡ PVC của Loki, GiB */
  storageGb: z.number().int().min(1).max(1000).default(20),
});

const GRAFANA_REPO = "https://grafana.github.io/helm-charts";
const gatewayOf = (namespace: string): string =>
  `http://udp-loki-gateway.${namespace}`;

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "LOGGING",
  toolId: "loki",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "logs.sink", version: "1.0.0" }],
    requires: [],
  },
  configSchema: lokiConfigSchema,
  chart: helmChart("loki"),
  releaseName: "udp-loki",
  /** Chunk và index nằm trên PVC — quota lưu trữ bằng 0 thì phải từ chối */
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = lokiConfigSchema.parse(config);
    return {
      deploymentMode: "SingleBinary",
      loki: {
        auth_enabled: false,
        commonConfig: { replication_factor: 1 },
        storage: { type: "filesystem" },
        schemaConfig: {
          configs: [
            {
              from: "2024-04-01",
              store: "tsdb",
              object_store: "filesystem",
              schema: "v13",
              index: { prefix: "loki_index_", period: "24h" },
            },
          ],
        },
        limits_config: {
          retention_period: `${String(parsed.retentionHours)}h`,
        },
        compactor: {
          retention_enabled: true,
          delete_request_store: "filesystem",
        },
      },
      singleBinary: {
        replicas: 1,
        persistence: { size: `${String(parsed.storageGb)}Gi` },
      },
      read: { replicas: 0 },
      write: { replicas: 0 },
      backend: { replicas: 0 },
      gateway: { enabled: true },
      chunksCache: { enabled: false },
      resultsCache: { enabled: false },
    };
  },
  companions: [
    {
      releaseName: "udp-loki-promtail",
      chart: helmChart("promtail"),
      values: (_config, ctx) => ({
        config: {
          clients: [
            { url: `${gatewayOf(ctx.systemNamespace)}/loki/api/v1/push` },
          ],
        },
      }),
    },
    {
      releaseName: "udp-loki-grafana",
      chart: helmChart("grafana"),
      values: (_config, ctx) => ({
        datasources: {
          "datasources.yaml": {
            apiVersion: 1,
            datasources: [
              {
                name: "Loki",
                type: "loki",
                access: "proxy",
                url: gatewayOf(ctx.systemNamespace),
                isDefault: true,
              },
            ],
          },
        },
      }),
    },
  ],

  bindings: (ctx) => [
    logsSinkBinding("logging:loki", {
      protocol: "loki",
      endpoint: `${gatewayOf(ctx.systemNamespace)}/loki/api/v1/push`,
    }),
  ],
});

export default adapter;

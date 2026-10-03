import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import type { MetricsSourceDeclaration } from "@udp/metrics-provider";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * [v4.10] Adapter THẬT thứ nhất — Prometheus + Grafana, họ Helm (§5.1 nhóm LIGHT).
 *
 * Nó là bằng chứng của luận điểm pluggable ở dạng kiểm được: tệp này khai **dữ liệu**, và
 * toàn bộ vòng đời đến từ `createHelmBasedAdapter`. Nếu một adapter thật phải viết lại
 * vòng đời thì câu "mọi adapter qua cùng một bộ hợp đồng" chỉ đúng vì bộ hợp đồng được
 * lặp lại bằng tay ở mỗi adapter.
 *
 * **Vì sao `metrics.query` là 2.0.0:** §5.3 dùng version của capability để phân biệt NGÔN
 * NGỮ truy vấn — PromQL là 2.x, còn DQL của Datadog là 1.x. Flagger khai
 * `constraint: "^2"`, nên Datadog không thoả và validator báo `VERSION_MISMATCH` thay vì
 * bind một provider nói thứ tiếng khác.
 *
 * **`requires: registry.oci`** không phải để lấy image của chính Prometheus (chart tự lo)
 * mà để Grafana kéo được image dashboard của tenant từ registry mà project đang dùng. Nó
 * đọc endpoint từ `ctx.resolved`, không đoán — đó là lý do `values` NÉM khi thiếu binding.
 */

export const prometheusGrafanaConfigSchema = z.object({
  /** Số ngày giữ metrics; ảnh hưởng dung lượng đĩa nên nó là chiều quota */
  retentionDays: z.number().int().min(1).max(365),
  /** Bật bộ dashboard mặc định của UDP */
  dashboards: z.boolean().default(true),
  /** Kích cỡ PVC của Prometheus, tính theo GiB */
  storageGb: z.number().int().min(1).max(1000).default(20),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "MONITORING",
  toolId: "prometheus-grafana",
  version: "1.0.0",
  /**
   * `cluster`: một Prometheus cho cả cluster, không phải một cho mỗi environment.
   *
   * Metrics của nhiều environment nằm chung một Prometheus và phân biệt bằng nhãn — dựng
   * một bản cho mỗi environment là nhân ba chi phí đĩa cho cùng một dữ liệu.
   */
  scope: "cluster",
  capabilities: {
    provides: [
      { id: "metrics.query", version: "2.0.0" },
      { id: "metrics.scrape", version: "1.0.0" },
    ],
    requires: [{ id: "registry.oci" }],
    recommends: ["logs.sink"],
    hint: {
      "registry.oci":
        "Bật domain Container Registry để Grafana kéo được dashboard của bạn",
    },
  },
  configSchema: prometheusGrafanaConfigSchema,
  chart: helmChart("kube-prometheus-stack"),
  releaseName: "udp-prometheus",
  quotaDimensions: ["maxStorageGb"],
  /**
   * Hai prefix này khớp `ignoredLabelPrefixes` của `AdapterFixture` trong `contract.test.ts`.
   *
   * Hai chỗ khai cùng một sự thậ­t, và đó là chủ ý: fixture nói adapter **tuyên bố**
   * bỏ qua gì, còn ở đây là hành vi thậ­t. Bộ hợp đồng là chốt giữ hai bên khớp: nếu
   * adapter bỏ qua nhiều hơn lời khai, một lần sửa tay sẽ không bị phát hiện.
   */
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = prometheusGrafanaConfigSchema.parse(config);
    const registry = ctx.resolved["registry.oci"];
    if (registry === undefined) {
      /**
       * NÉM chứ không dùng một giá trị mặc định.
       *
       * Một endpoint registry đoán ra sẽ chạy được trên cluster của người viết adapter và
       * vỡ ở cluster của khách — và nó vỡ lúc Grafana kéo image, tức sau khi deploy đã báo
       * thành công.
       */
      throw new Error("thiếu binding registry.oci trong ctx.resolved");
    }
    return {
      prometheus: {
        prometheusSpec: {
          retention: `${String(parsed.retentionDays)}d`,
          storageSpec: {
            volumeClaimTemplate: {
              spec: {
                resources: {
                  requests: { storage: `${String(parsed.storageGb)}Gi` },
                },
              },
            },
          },
        },
      },
      grafana: {
        enabled: parsed.dashboards,
        /** Kéo dashboard từ registry của project, đọc từ binding chứ không đoán */
        image: { registry: registry.endpoint ?? registry.providedBy },
      },
    };
  },

  bindings: (ctx) => [
    {
      id: "metrics.query",
      version: "2.0.0",
      providedBy: "monitoring:prometheus-grafana",
      endpoint: `http://udp-prometheus-prometheus.${ctx.systemNamespace}:9090`,
    },
    {
      id: "metrics.scrape",
      version: "1.0.0",
      providedBy: "monitoring:prometheus-grafana",
      endpoint: `http://udp-prometheus-prometheus.${ctx.systemNamespace}:9090/api/v1/write`,
    },
  ],
});

export default adapter;

/**
 * §5.4: PromQL trên Prometheus TRONG cluster tenant — endpoint của binding là địa chỉ
 * ClusterIP, chỉ tới được qua API-server service proxy (ADR-06).
 */
export const metricsSource: MetricsSourceDeclaration = {
  kind: "prometheus",
  of: (_config, binding) => {
    if (binding.endpoint === undefined) {
      throw new Error(
        "binding metrics.query của prometheus-grafana thiếu endpoint",
      );
    }
    return { kind: "prometheus", baseUrl: binding.endpoint, inCluster: true };
  },
};

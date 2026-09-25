import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import type { MetricsSourceDeclaration } from "@udp/metrics-provider";
import { agentClusterName } from "../../adapter-base/agent-cluster.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Grafana Cloud (§5.5 Monitoring, Plan #31) — họ Helm CÓ agent (QĐ-3).
 *
 * `k8s-monitoring` cài Grafana Alloy: scrape `/metrics` của Golden Path (tự khám phá theo chú
 * thích) và remote-write lên Mimir của Grafana Cloud. Truy vấn là PromQL trên chính Mimir đó,
 * nên `metrics.query` là **2.0.0** (QĐ-4): Flagger (`^2`) thoả, khác New Relic/Dynatrace.
 *
 * Access token vừa là mật khẩu remote-write của Alloy (⇒ `Secret`, QĐ-5), vừa là khoá UDP
 * truy vấn Mimir cho canary analysis (§5.4). URL chỉ nhận miền của Grafana Cloud — một URL tự
 * do là đường gửi token của khách tới máy bất kỳ.
 */

export const grafanaCloudConfigSchema = z.object({
  /** `https://prometheus-prod-<n>-<vùng>.grafana.net/api/prom` — trang "Prometheus" của stack */
  prometheusUrl: z
    .string()
    .regex(/^https:\/\/prometheus-[a-z0-9-]+\.grafana\.net\/api\/prom$/),
  /** Instance ID của Prometheus trong stack — username của basic auth */
  prometheusUser: z.number().int().positive(),
  /** Access policy token `glc_…` (metrics:read + metrics:write) */
  accessToken: z
    .string()
    .regex(/^glc_[A-Za-z0-9+/=_-]{32,}$/)
    .describe("secret"),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "MONITORING",
  toolId: "grafana-cloud",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [
      { id: "metrics.query", version: "2.0.0" },
      { id: "metrics.scrape", version: "1.0.0" },
    ],
    requires: [],
    recommends: ["logs.sink", "traces.sink"],
  },
  configSchema: grafanaCloudConfigSchema,
  chart: {
    name: "k8s-monitoring",
    version: "1.6.14",
    repo: "https://grafana.github.io/helm-charts",
  },
  releaseName: "udp-grafana-cloud",
  /** Dữ liệu nằm ở Grafana Cloud — không PVC nào trong cluster */
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = grafanaCloudConfigSchema.parse(config);
    return {
      cluster: { name: agentClusterName(ctx) },
      externalServices: {
        prometheus: {
          host: new URL(parsed.prometheusUrl).origin,
          basicAuth: { username: String(parsed.prometheusUser) },
        },
      },
      metrics: { enabled: true, autoDiscover: { enabled: true } },
      logs: { enabled: false },
      traces: { enabled: false },
    };
  },
  secretValues: (config) => ({
    externalServices: {
      prometheus: {
        basicAuth: {
          password: grafanaCloudConfigSchema.parse(config).accessToken,
        },
      },
    },
  }),

  bindings: (_ctx, config) => {
    const { prometheusUrl } = grafanaCloudConfigSchema.parse(config);
    return [
      {
        id: "metrics.query",
        version: "2.0.0",
        providedBy: "monitoring:grafana-cloud",
        endpoint: prometheusUrl,
      },
      {
        id: "metrics.scrape",
        version: "1.0.0",
        providedBy: "monitoring:grafana-cloud",
        endpoint: `${prometheusUrl}/push`,
      },
    ];
  },
});

export default adapter;

/** §5.4: PromQL trên Mimir được host — ngoài cluster, basic auth bằng instance id + token */
export const metricsSource: MetricsSourceDeclaration = {
  kind: "prometheus",
  of: (config) => {
    const { prometheusUrl, prometheusUser, accessToken } =
      grafanaCloudConfigSchema.parse(config);
    return {
      kind: "prometheus",
      baseUrl: prometheusUrl,
      inCluster: false,
      basicAuth: { username: String(prometheusUser), password: accessToken },
    };
  },
};

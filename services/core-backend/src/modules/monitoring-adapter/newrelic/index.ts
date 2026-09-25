import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import {
  NEW_RELIC_REGIONS,
  newRelicApiHost,
  type MetricsSourceDeclaration,
} from "@udp/metrics-provider";
import { agentClusterName } from "../../adapter-base/agent-cluster.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter New Relic (§5.5 Monitoring, Plan #31) — họ Helm CÓ agent (QĐ-3).
 *
 * `nri-bundle` cài infrastructure agent, Prometheus agent (scrape `/metrics` của Golden Path,
 * nên nhãn `ff` của §6.6 đi tới New Relic nguyên vẹn) và log forwarder; dữ liệu về tài khoản
 * New Relic của khách. Hai khoá, hai chỗ sống khác nhau:
 *
 *  - **license key** — agent gửi dữ liệu bằng nó ⇒ vào `Secret` của `udp-system` (QĐ-5);
 *  - **user key** — chỉ UDP dùng để truy vấn NRQL cho canary analysis (§5.4) ⇒ KHÔNG vào
 *    cluster: khoá đọc cả tài khoản không có lý do nằm cạnh workload của khách.
 *
 * `metrics.query` là 1.0.0: NRQL không phải PromQL, nên Flagger (`^2`) không thoả và validator
 * báo `VERSION_MISMATCH` thay vì bind một nguồn nói thứ tiếng khác (§5.3).
 */

export const newRelicConfigSchema = z.object({
  accountId: z.number().int().positive(),
  /** Vùng dữ liệu của tài khoản — API và log endpoint theo vùng */
  region: z.enum(NEW_RELIC_REGIONS),
  /** License key ingest, 40 ký tự */
  licenseKey: z
    .string()
    .regex(/^[A-Za-z0-9]{40}$/)
    .describe("secret"),
  /** User key `NRAK-…` — NerdGraph chỉ nhận loại khoá này */
  userKey: z
    .string()
    .regex(/^NRAK-[A-Z0-9]{27}$/)
    .describe("secret"),
  /** Chế độ ít dữ liệu của nri-bundle — bớt hoá đơn ingest của khách */
  lowDataMode: z.boolean().default(true),
});

const logEndpoint = (region: (typeof NEW_RELIC_REGIONS)[number]): string =>
  region === "EU"
    ? "https://log-api.eu.newrelic.com/log/v1"
    : "https://log-api.newrelic.com/log/v1";

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "MONITORING",
  toolId: "newrelic",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [
      { id: "metrics.query", version: "1.0.0" },
      { id: "logs.sink", version: "1.0.0" },
    ],
    requires: [],
    recommends: ["traces.sink"],
  },
  configSchema: newRelicConfigSchema,
  chart: {
    name: "nri-bundle",
    version: "5.0.94",
    repo: "https://helm-charts.newrelic.com",
  },
  releaseName: "udp-newrelic",
  /** Agent không giữ dữ liệu trong cluster — không chiều quota nào */
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = newRelicConfigSchema.parse(config);
    return {
      global: {
        cluster: agentClusterName(ctx),
        lowDataMode: parsed.lowDataMode,
      },
      "newrelic-infrastructure": { enabled: true },
      "nri-metadata-injection": { enabled: true },
      "kube-state-metrics": { enabled: true },
      "nri-kube-events": { enabled: true },
      "newrelic-logging": { enabled: true },
      // Scrape MỌI target có chú thích prometheus.io/scrape — gồm `/metrics` của Golden Path
      "newrelic-prometheus-agent": {
        enabled: true,
        config: { kubernetes: { integrations_filter: { enabled: false } } },
      },
    };
  },
  secretValues: (config) => ({
    global: { licenseKey: newRelicConfigSchema.parse(config).licenseKey },
  }),

  bindings: (_ctx, config) => {
    const { region } = newRelicConfigSchema.parse(config);
    return [
      {
        id: "metrics.query",
        version: "1.0.0",
        providedBy: "monitoring:newrelic",
        endpoint: `https://${newRelicApiHost(region)}/graphql`,
      },
      {
        id: "logs.sink",
        version: "1.0.0",
        providedBy: "monitoring:newrelic",
        endpoint: logEndpoint(region),
      },
    ];
  },
});

export default adapter;

/** §5.4: NRQL qua NerdGraph bằng user key — khoá không rời bộ nhớ của bên truy vấn */
export const metricsSource: MetricsSourceDeclaration = {
  kind: "newrelic",
  of: (config) => {
    const { region, accountId, userKey } = newRelicConfigSchema.parse(config);
    return { kind: "newrelic", region, accountId, apiKey: userKey };
  },
};

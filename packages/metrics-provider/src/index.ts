/**
 * `@udp/metrics-provider` — nguồn metrics cho progressive delivery (§5.4).
 *
 * Service 1 gọi `probe()` khi tạo rollout; Service 3 gọi phần còn lại ở mỗi
 * vòng phân tích (§7.1). Hôm nay có một hiện thực thật (Prometheus) và một
 * nguồn giả cho test (`@udp/metrics-provider/testing`).
 */
export type {
  MetricSample,
  MetricTarget,
  MetricsProvider,
  ProbeOutcome,
  ScrapeIntervalSource,
} from "./provider.js";
export {
  DEFAULT_METRIC_BASE,
  ffLabel,
  matchersOf,
  queryTemplates,
} from "./query-templates.js";
export type { QueryTemplates } from "./query-templates.js";
export { quoteLabelValue, quoteRegexPrefix, windowOf } from "./promql.js";
export { PrometheusMetricsProvider } from "./prometheus.js";
export type { PrometheusProviderOptions } from "./prometheus.js";

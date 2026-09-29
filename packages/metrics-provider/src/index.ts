/**
 * `@udp/metrics-provider` — nguồn metrics cho progressive delivery (§5.4).
 *
 * Service 1 gọi `probe()` khi tạo rollout; Service 3 gọi phần còn lại ở mỗi
 * vòng phân tích (§7.1); [Plan #53] `series()` cho trang Giám sát. Bốn hiện thực: Prometheus (PromQL — cả VictoriaMetrics,
 * Grafana Cloud), Datadog, New Relic, Dynatrace (Plan #31), dựng từ một
 * `MetricsSource` bằng `createMetricsProvider`; nguồn giả cho test ở
 * `@udp/metrics-provider/testing`.
 */
export type {
  MetricSample,
  MetricSeries,
  MetricTarget,
  MetricsProvider,
  MetricsSeriesProvider,
  ProbeOutcome,
  ScrapeIntervalSource,
  SeriesKind,
  SeriesPoint,
  SeriesWindow,
} from "./provider.js";
export {
  alignSeries,
  MAX_SERIES_STEPS,
  MetricsQueryError,
  MIN_SERIES_RATE_WINDOW_SEC,
  SERIES_UNIT,
  seriesGrid,
  seriesRateWindowSec,
} from "./series.js";
export type { SeriesGrid } from "./series.js";
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
export { createMetricsProvider, METRICS_QUERY_MAJOR } from "./source.js";
export type {
  CreateProviderOptions,
  MetricsSource,
  MetricsSourceDeclaration,
  MetricsSourceKind,
} from "./source.js";
export {
  DATADOG_SITES,
  datadogApiHost,
  DatadogMetricsProvider,
} from "./saas/datadog.js";
export type { DatadogProviderOptions, DatadogSite } from "./saas/datadog.js";
export {
  NEW_RELIC_REGIONS,
  newRelicApiHost,
  NewRelicMetricsProvider,
} from "./saas/newrelic.js";
export type {
  NewRelicProviderOptions,
  NewRelicRegion,
} from "./saas/newrelic.js";
export { DynatraceMetricsProvider } from "./saas/dynatrace.js";
export type { DynatraceProviderOptions } from "./saas/dynatrace.js";
export { histogramQuantile } from "./saas/quantile.js";

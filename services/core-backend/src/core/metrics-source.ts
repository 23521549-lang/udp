import { env } from "@udp/config";
import {
  createMetricsProvider,
  PrometheusMetricsProvider,
} from "@udp/metrics-provider";
import { createEgressFetch } from "./egress/egress.js";
import type { AppDeps } from "./app-deps.js";

/**
 * Nguồn metrics của Service 1 — chỉ để `probe()` pha 1 lúc tạo rollout (§7.4).
 *
 * Nguồn đến từ binding `metrics.query` của environment (Plan #31): nhà cung cấp SaaS đi
 * thẳng tới API của họ qua egress guard (§12 T11) với khoá đã mở trong bộ nhớ. Prometheus
 * TRONG cluster tenant chỉ tới được qua API-server service proxy (ADR-06) — chưa có ở S1,
 * nên nó và project chưa có binding nào đi `PROMETHEUS_URL` chung như Service 3 (§16).
 */
let saasFetch: typeof fetch | undefined;

export const metricsFor: AppDeps["metricsFor"] = (source, metricQueries) => {
  const metricBase =
    metricQueries === undefined ? {} : { metricBase: metricQueries.metricBase };
  if (source === null || (source.kind === "prometheus" && source.inCluster)) {
    return new PrometheusMetricsProvider({
      baseUrl: env.PROMETHEUS_URL,
      ...metricBase,
    });
  }
  saasFetch ??= createEgressFetch();
  return createMetricsProvider(source, { ...metricBase, fetch: saasFetch });
};

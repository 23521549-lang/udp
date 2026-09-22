import { env } from "@udp/config";
import { PrometheusMetricsProvider } from "@udp/metrics-provider";
import type { AppDeps } from "./app-deps.js";

/**
 * Nguồn metrics của Service 1 — chỉ để `probe()` pha 1 lúc tạo rollout (§7.4).
 *
 * Lát cắt này dùng `PROMETHEUS_URL` chung như Service 3 (§16): ngày có
 * cluster-access (ADR-06), nguồn theo capability `metrics.query` của environment
 * và đi qua API-server service proxy — chữ ký `metricsFor` không đổi.
 */
export const metricsFor: AppDeps["metricsFor"] = (metricQueries) =>
  new PrometheusMetricsProvider({
    baseUrl: env.PROMETHEUS_URL,
    ...(metricQueries === undefined
      ? {}
      : { metricBase: metricQueries.metricBase }),
  });

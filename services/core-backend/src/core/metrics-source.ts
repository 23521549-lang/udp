import { env } from "@udp/config";
import { ServiceUnavailableError } from "@udp/http";
import {
  createMetricsProvider,
  PrometheusMetricsProvider,
} from "@udp/metrics-provider";
import type { ClusterAccessCache } from "../modules/cluster/cluster-access-cache.js";
import {
  serviceProxyFetch,
  serviceTargetOf,
} from "../modules/cluster/service-proxy-fetch.js";
import { createEgressFetch } from "./egress/egress.js";
import type { AppDeps } from "./app-deps.js";

/**
 * Nguồn metrics của Service 1 — probe pha 1 lúc tạo rollout (§7.4) VÀ [v4.11, Plan #39, D-P30]
 * mọi phép đo Service 3 nhờ qua `/internal/environments/:envId/metrics`.
 *
 * Nguồn đến từ binding `metrics.query` của environment (Plan #31):
 *  - SaaS: thẳng tới API nhà cung cấp qua egress guard (§12 T11), khoá đã mở trong bộ nhớ.
 *  - Prometheus/VictoriaMetrics TRONG cluster tenant: qua proxy của API server (ADR-06) với truy
 *    cập cluster nhớ theo hạn token. Tiến trình không có đường tới cluster (`clusters` null) ⇒
 *    503 — KHÔNG lặng lẽ đo một Prometheus khác. API server từ chối token ⇒ bỏ bản nhớ.
 *  - Chưa có binding (project dev, seed): `PROMETHEUS_URL` của triển khai (§16).
 */
export function createMetricsFor(
  clusters: ClusterAccessCache | null,
): AppDeps["metricsFor"] {
  let saasFetch: typeof fetch | undefined;
  return (source, metricQueries, scope) => {
    const metricBase =
      metricQueries === undefined
        ? {}
        : { metricBase: metricQueries.metricBase };
    if (source === null) {
      return new PrometheusMetricsProvider({
        baseUrl: env.PROMETHEUS_URL,
        ...metricBase,
      });
    }
    if (source.kind === "prometheus" && source.inCluster) {
      if (clusters === null) {
        throw new ServiceUnavailableError(
          "Tiến trình này không tới được cluster để đọc Prometheus trong cluster",
        );
      }
      const proxied = serviceProxyFetch(
        () => clusters.get(scope.projectId),
        serviceTargetOf(source.baseUrl),
      );
      return createMetricsProvider(source, {
        ...metricBase,
        fetch: async (input, init) => {
          const res = await proxied(input, init);
          if (res.status === 401) clusters.forget(scope.projectId);
          return res;
        },
      });
    }
    saasFetch ??= createEgressFetch();
    return createMetricsProvider(source, { ...metricBase, fetch: saasFetch });
  };
}

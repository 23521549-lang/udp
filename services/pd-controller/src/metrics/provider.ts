import { METRICS_PROVIDER } from "@udp/config";
import type { MetricsProvider } from "@udp/metrics-provider";
import type { SessionRow } from "../rollout-session/types.js";
import { RemoteMetricsProvider, type CoreMetricsClient } from "./remote.js";

/**
 * Chọn nguồn metrics cho một session (§5.4, §7.1 `metricsProviderFor`) — [v4.11, Plan #39] THEO
 * ENVIRONMENT của session: mỗi environment đọc từ nguồn mà binding `metrics.query` của nó chỉ tới
 * (Prometheus trong cluster, Grafana Cloud, Datadog, New Relic, Dynatrace), qua Service 1 — S1
 * giữ khoá và đường tới cluster (D-P30). Không còn một `PROMETHEUS_URL` chung cho mọi session.
 *
 * Một provider mỗi (environment, `metric_queries.metricBase`); siêu dữ liệu của nguồn (độ trễ
 * scrape) đọc lúc tạo và làm mới định kỳ — provider tạo sau không rơi về mặc định khi S1 chập
 * chờn, nó giữ số đã đọc.
 */
export type ProviderSession = Pick<
  SessionRow,
  "id" | "environmentId" | "metricQueries"
>;

export type MetricsProviderFor = (session: ProviderSession) => MetricsProvider;

export interface MetricsProviders {
  forSession: MetricsProviderFor;
  /** Đọc lại siêu dữ liệu nguồn cho mọi provider đang có */
  refresh(): Promise<void>;
  stop(): void;
}

export interface ProviderFactoryOptions {
  client: CoreMetricsClient;
  refreshMs?: number;
}

export function createMetricsProviders(
  options: ProviderFactoryOptions,
): MetricsProviders {
  const byKey = new Map<string, RemoteMetricsProvider>();

  const refresh = async (): Promise<void> => {
    await Promise.all([...byKey.values()].map((p) => p.refresh()));
  };

  const timer = setInterval(() => {
    void refresh();
  }, options.refreshMs ?? METRICS_PROVIDER.scrapeLagRefreshMs);
  timer.unref();

  return {
    forSession(session) {
      const base = session.metricQueries?.metricBase ?? "";
      const key = `${session.environmentId}|${base}`;
      const existing = byKey.get(key);
      if (existing !== undefined) return existing;
      const created = new RemoteMetricsProvider(
        options.client,
        session.environmentId,
        session.metricQueries,
        // Chưa đọc được nguồn: độ trễ LỚN nhất đã biết (lô 60 giây của nguồn SaaS) — chờ lâu
        // hơn thì chỉ chậm một bậc, đo sớm thì phân tích trên cửa sổ chưa đủ dữ liệu
        Math.max(
          METRICS_PROVIDER.defaultScrapeLagSeconds,
          METRICS_PROVIDER.saasExportIntervalSeconds,
        ),
      );
      byKey.set(key, created);
      void created.refresh();
      return created;
    },
    refresh,
    stop() {
      clearInterval(timer);
    },
  };
}

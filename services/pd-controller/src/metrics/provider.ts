import { METRICS_PROVIDER } from "@udp/config";
import { logger } from "@udp/http";
import {
  PrometheusMetricsProvider,
  type MetricsProvider,
} from "@udp/metrics-provider";
import type { SessionRow } from "../rollout-session/types.js";

/**
 * Chọn nguồn metrics cho một session (§5.4, §7.1 `metricsProviderFor`).
 *
 * Lát cắt này: một Prometheus, địa chỉ từ cấu hình (`PROMETHEUS_URL`), một
 * provider cho mỗi `metric_queries.metricBase` (§7.4 "Override": app không theo
 * OTel semconv khai tên metric riêng). Ngày Domain Adapter Monitoring ra đời,
 * `forSession` tra registry theo capability `metrics.query` của environment và
 * nối qua API-server service proxy (ADR-06) — chữ ký không đổi.
 *
 * Độ trễ scrape đọc từ `/api/v1/targets` lúc khởi động và làm mới định kỳ
 * (§5.4 [v4.2]); provider tạo sau kế thừa con số đang có, không rơi về mặc định.
 *
 * `prometheusUrl` và `fetch` tiêm vào (không đọc `env` ở đây) để test dựng
 * Prometheus giả.
 */
export type ProviderSession = Pick<SessionRow, "id" | "metricQueries">;

export type MetricsProviderFor = (session: ProviderSession) => MetricsProvider;

export interface MetricsProviders {
  forSession: MetricsProviderFor;
  /** Đọc lại scrape interval cho mọi provider đang có */
  refresh(): Promise<void>;
  stop(): void;
}

export interface ProviderFactoryOptions {
  prometheusUrl: string;
  scrapeLagSeconds?: number;
  refreshMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_KEY = "";

export function createMetricsProviders(
  options: ProviderFactoryOptions,
): MetricsProviders {
  const byBase = new Map<string, PrometheusMetricsProvider>();

  const build = (
    metricBase: string | undefined,
    lag: number | undefined,
  ): PrometheusMetricsProvider =>
    new PrometheusMetricsProvider({
      baseUrl: options.prometheusUrl,
      ...(lag === undefined ? {} : { scrapeLagSeconds: lag }),
      ...(metricBase === undefined ? {} : { metricBase }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });

  const root = build(undefined, options.scrapeLagSeconds);
  byBase.set(DEFAULT_KEY, root);

  const refresh = async (): Promise<void> => {
    try {
      await Promise.all([...byBase.values()].map((p) => p.refreshScrapeLag()));
    } catch (err: unknown) {
      logger.warn({ err }, "Không đọc được scrape interval của Prometheus");
    }
  };

  void refresh();
  const timer = setInterval(() => {
    void refresh();
  }, options.refreshMs ?? METRICS_PROVIDER.scrapeLagRefreshMs);
  timer.unref();

  return {
    forSession(session) {
      const base = session.metricQueries?.metricBase;
      const key = base ?? DEFAULT_KEY;
      const existing = byBase.get(key);
      if (existing !== undefined) return existing;
      const created = build(base, root.scrapeLagSeconds);
      byBase.set(key, created);
      return created;
    },
    refresh,
    stop() {
      clearInterval(timer);
    },
  };
}

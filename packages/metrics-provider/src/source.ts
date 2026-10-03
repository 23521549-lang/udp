import { PrometheusMetricsProvider } from "./prometheus.js";
import type { MetricsSeriesProvider } from "./provider.js";
import { DatadogMetricsProvider, type DatadogSite } from "./saas/datadog.js";
import { DynatraceMetricsProvider } from "./saas/dynatrace.js";
import {
  NewRelicMetricsProvider,
  type NewRelicRegion,
} from "./saas/newrelic.js";

/**
 * Nguồn metrics của MỘT environment, suy từ binding `metrics.query` và cấu hình (đã mở bí
 * mật) của tool cung cấp nó (§5.4, Plan #31). Là DỮ LIỆU, không phải provider: adapter khai
 * cách suy (`MetricsSourceDeclaration`), còn bên dùng (Service 1, sau này Service 3) dựng
 * provider bằng `createMetricsProvider` với `fetch` của CHÍNH nó (egress guard).
 */
export type MetricsSource =
  | {
      kind: "prometheus";
      baseUrl: string;
      /**
       * Prometheus/VictoriaMetrics TRONG cluster tenant: chỉ tới được qua API-server service
       * proxy (ADR-06) — bên dùng chưa có đường đó thì đi `PROMETHEUS_URL` (§16). Ngoài
       * cluster là endpoint PromQL được host (Grafana Cloud/Mimir).
       */
      inCluster: boolean;
      basicAuth?: { username: string; password: string };
    }
  | { kind: "datadog"; site: DatadogSite; apiKey: string; appKey: string }
  | {
      kind: "newrelic";
      region: NewRelicRegion;
      accountId: number;
      apiKey: string;
    }
  | { kind: "dynatrace"; environmentUrl: string; apiToken: string };

export type MetricsSourceKind = MetricsSource["kind"];

/**
 * Bản chính của `metrics.query` mà mỗi loại nguồn thoả (§5.3): PromQL là 2, ngôn ngữ riêng
 * của từng nhà cung cấp là 1. Registry đối chiếu với `provides` của adapter lúc nạp — §5.4
 * đòi ràng buộc này kiểm ở lúc khởi động, không phải lúc chạy rollout.
 */
export const METRICS_QUERY_MAJOR: Readonly<Record<MetricsSourceKind, number>> =
  {
    prometheus: 2,
    datadog: 1,
    newrelic: 1,
    dynatrace: 1,
  };

/**
 * Lời khai của một adapter `provides: metrics.query` (§5.4: "PHẢI đăng ký kèm một
 * MetricsProvider"). Adapter xuất nó cạnh export mặc định; registry từ chối nạp adapter
 * cung cấp `metrics.query` mà không khai, hay khai `kind` lệch version đã `provides`.
 */
export interface MetricsSourceDeclaration {
  kind: MetricsSourceKind;
  /** Từ cấu hình ĐÃ MỞ bí mật và binding của environment ra nguồn metrics */
  of(
    config: Readonly<Record<string, unknown>>,
    binding: { endpoint?: string },
  ): MetricsSource;
}

export interface CreateProviderOptions {
  /** Tên metric gốc (`RolloutSession.metric_queries`) — áp cho MỌI nguồn */
  metricBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createMetricsProvider(
  source: MetricsSource,
  options: CreateProviderOptions = {},
): MetricsSeriesProvider {
  switch (source.kind) {
    case "prometheus":
      return new PrometheusMetricsProvider({
        baseUrl: source.baseUrl,
        ...(source.basicAuth === undefined
          ? {}
          : { basicAuth: source.basicAuth }),
        // Endpoint được host không mở `/-/ready` dưới đường truy vấn — hỏi bằng truy vấn
        readiness: source.inCluster ? "ready-endpoint" : "query",
        ...options,
      });
    case "datadog":
      return new DatadogMetricsProvider({ ...source, ...options });
    case "newrelic":
      return new NewRelicMetricsProvider({ ...source, ...options });
    case "dynatrace":
      return new DynatraceMetricsProvider({ ...source, ...options });
  }
}

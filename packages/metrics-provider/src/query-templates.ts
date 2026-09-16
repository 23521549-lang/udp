import { PROMETHEUS_METRIC_NAME } from "@udp/shared-types";
import type { MetricTarget } from "./provider.js";
import { quoteLabelValue, quoteRegexPrefix, windowOf } from "./promql.js";

/**
 * Truy vấn mẫu theo OpenTelemetry semantic conventions (§7.4), khớp nhãn của
 * `udpMetricsMiddleware` trong Golden Path (§6.6, §11.1).
 *
 * Tên metric mặc định là `http.server.request.duration` ở dạng Prometheus. App
 * dùng tên khác ghi đè qua `metricBase` (`RolloutSession.metric_queries`, §7.4).
 *
 * Một quy tắc không đổi: MỌI matcher có `service_name` và `namespace`. Bỏ
 * `service_name` khi thiếu `workloadName` là gộp mọi service trong namespace có
 * cùng `ff` — phép đo mất nhân quả. Vì thế `MetricTarget.workloadName` là bắt
 * buộc, và Service 3 HOLD khi session thiếu `workload_name`.
 */

export const DEFAULT_METRIC_BASE = "http_server_request_duration_seconds";

/** Nhãn tổng hợp của §6.6: `ff="<flagKey>=<variant>"` */
export function ffLabel(flagKey: string, variantKey: string): string {
  return `${flagKey}=${variantKey}`;
}

/**
 * Bộ matcher cho một target. SERVICE_LEVEL thêm `service_version`; FLAG_LEVEL
 * thêm `ff` — cùng một version, khác nhánh flag (C1).
 */
export function matchersOf(
  target: MetricTarget,
  extra: readonly string[] = [],
): string {
  const parts = [
    `service_name=${quoteLabelValue(target.workloadName)}`,
    `namespace=${quoteLabelValue(target.namespace)}`,
  ];
  if (target.version !== undefined) {
    parts.push(`service_version=${quoteLabelValue(target.version)}`);
  }
  if (target.flagKey !== undefined && target.variantKey !== undefined) {
    parts.push(
      `ff=${quoteLabelValue(ffLabel(target.flagKey, target.variantKey))}`,
    );
  }
  return `{${[...parts, ...extra].join(", ")}}`;
}

const ERROR_STATUS = 'http_response_status_code=~"5.."';

export interface QueryTemplates {
  requestCount(t: MetricTarget, windowSec: number): string;
  errorCount(t: MetricTarget, windowSec: number): string;
  errorRate(t: MetricTarget, windowSec: number): string;
  latencyP99(t: MetricTarget, windowSec: number): string;
  /** Có series nào cho target không — FLAG_LEVEL theo `flagKey`, không theo variant */
  probeSeries(t: MetricTarget): string;
}

export function queryTemplates(
  metricBase: string = DEFAULT_METRIC_BASE,
): QueryTemplates {
  // `metricBase` đến từ `RolloutSession.metric_queries` — dữ liệu người dùng — nên
  // kiểm ở đây dù S1 đã kiểm: đây là nơi nó thành PromQL.
  if (!PROMETHEUS_METRIC_NAME.test(metricBase)) {
    throw new Error(`Tên metric không hợp lệ: ${JSON.stringify(metricBase)}`);
  }
  const count = `${metricBase}_count`;
  const bucket = `${metricBase}_bucket`;
  return {
    requestCount: (t, w) =>
      `sum(increase(${count}${matchersOf(t)}${windowOf(w)}))`,
    errorCount: (t, w) =>
      `sum(increase(${count}${matchersOf(t, [ERROR_STATUS])}${windowOf(w)}))`,
    errorRate: (t, w) =>
      `sum(rate(${count}${matchersOf(t, [ERROR_STATUS])}${windowOf(w)})) / ` +
      `sum(rate(${count}${matchersOf(t)}${windowOf(w)}))`,
    latencyP99: (t, w) =>
      `histogram_quantile(0.99, sum by (le) (rate(${bucket}${matchersOf(t)}${windowOf(w)})))`,
    probeSeries: (t) => {
      const base = {
        namespace: t.namespace,
        workloadName: t.workloadName,
        ...(t.version === undefined ? {} : { version: t.version }),
      };
      const extra =
        t.flagKey === undefined
          ? []
          : [`ff=~${quoteRegexPrefix(`${t.flagKey}=`)}`];
      return `count(${count}${matchersOf(base, extra)})`;
    },
  };
}

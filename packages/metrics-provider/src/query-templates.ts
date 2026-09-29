import { PROMETHEUS_METRIC_NAME } from "@udp/shared-types";
import type { MetricTarget, SeriesKind } from "./provider.js";
import { quoteLabelValue, quoteRegexPrefix, windowOf } from "./promql.js";
import { seriesRateWindowSec } from "./series.js";

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

/** Target nhắm ĐÚNG một nhánh flag (FLAG_LEVEL) — cần cả key lẫn variant */
const isBranchTarget = (
  t: MetricTarget,
): t is MetricTarget & { flagKey: string; variantKey: string } =>
  t.flagKey !== undefined && t.variantKey !== undefined;

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
  if (isBranchTarget(target)) {
    parts.push(
      `ff=${quoteLabelValue(ffLabel(target.flagKey, target.variantKey))}`,
    );
  }
  return `{${[...parts, ...extra].join(", ")}}`;
}

const ERROR_STATUS = 'http_response_status_code=~"5.."';

/**
 * [v4.7] Matcher của các truy vấn PHÂN TÍCH (đếm request, lỗi, p99). Không nhắm
 * một nhánh flag ⇒ chỉ series TỔNG `ff=""`: middleware ghi mỗi request vào series
 * tổng CỘNG một series cho mỗi tracked flag (§6.6), nên không lọc là đếm 1 + T
 * lần và tỉ lệ lỗi/p99 lệch theo phân bố các nhánh. `ff=""` cũng khớp series
 * KHÔNG có nhãn `ff` (app không cài middleware) ⇒ tương thích ngược.
 *
 * Không đặt trong `matchersOf`: `probeSeries` thêm `ff=~"^<key>=.*"` lên cùng bộ
 * matcher, và `ff=""` cạnh nó làm truy vấn luôn rỗng — cổng probe pha 2 không bao
 * giờ mở.
 */
function analysisMatchers(
  t: MetricTarget,
  extra: readonly string[] = [],
): string {
  return matchersOf(t, isBranchTarget(t) ? extra : [...extra, 'ff=""']);
}

/**
 * Không có series lỗi nào KHI CÓ lưu lượng là 0 lỗi, không phải "không biết" (Plan #31).
 *
 * Histogram chỉ sinh series cho bộ nhãn đã từng quan sát: một nhánh khoẻ chưa từng trả 5xx
 * không có series `http_response_status_code=~"5.."`, và `sum(...)` trên tập rỗng là vector
 * RỖNG — `hasData: false`, nên `decide()` HOLD mãi một canary không có lỗi nào. `or` với
 * `0 * <tổng>` cho đúng 0 khi series tổng CÓ mặt, và vẫn rỗng khi không có lưu lượng nào:
 * I7 giữ nguyên — "không biết" không bao giờ thành "không lỗi".
 */
const zeroWhenTraffic = (errors: string, total: string): string =>
  `(${errors} or 0 * ${total})`;

export interface QueryTemplates {
  requestCount(t: MetricTarget, windowSec: number): string;
  errorCount(t: MetricTarget, windowSec: number): string;
  errorRate(t: MetricTarget, windowSec: number): string;
  latencyP99(t: MetricTarget, windowSec: number): string;
  /**
   * [v4.4] Số series CÓ LƯU LƯỢNG trong cửa sổ — `increase(...) > 0`, không phải
   * "tồn tại". Có `flagKey` thì theo nhãn `ff` của flag, không theo variant.
   */
  probeSeries(t: MetricTarget, windowSec: number): string;
  /**
   * [v4.4] Số mẫu nhiều nhất của một series của workload trong cửa sổ — scrape
   * interval của CHÍNH workload là `cửa sổ / số mẫu`, không phải số lớn nhất của
   * mọi target trong Prometheus.
   */
  scrapeSamples(t: MetricTarget, windowSec: number): string;
  /**
   * [Plan #53] Truy vấn của `query_range` cho một chuỗi RED — CHÍNH khuôn §7.4 ở trên, cửa sổ
   * rate là `seriesRateWindowSec(stepSec)`. Mọi truy vấn đều gộp (`sum`, `histogram_quantile`
   * trên `sum by (le)`) nên kết quả là MỘT series. `latencyP99` ra giây — provider đổi ms.
   */
  series(kind: SeriesKind, t: MetricTarget, stepSec: number): string;
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
  const over = (fn: "increase" | "rate", t: MetricTarget, w: number) => ({
    total: `sum(${fn}(${count}${analysisMatchers(t)}${windowOf(w)}))`,
    errors: `sum(${fn}(${count}${analysisMatchers(t, [ERROR_STATUS])}${windowOf(w)}))`,
  });
  const errorRate = (t: MetricTarget, w: number): string => {
    const q = over("rate", t, w);
    return `${zeroWhenTraffic(q.errors, q.total)} / ${q.total}`;
  };
  const latencyP99 = (t: MetricTarget, w: number): string =>
    `histogram_quantile(0.99, sum by (le) (rate(${bucket}${analysisMatchers(t)}${windowOf(w)})))`;
  return {
    requestCount: (t, w) => over("increase", t, w).total,
    errorCount: (t, w) => {
      const q = over("increase", t, w);
      return zeroWhenTraffic(q.errors, q.total);
    },
    errorRate,
    latencyP99,
    probeSeries: (t, w) => {
      const base = {
        namespace: t.namespace,
        workloadName: t.workloadName,
        ...(t.version === undefined ? {} : { version: t.version }),
      };
      const extra =
        t.flagKey === undefined
          ? []
          : [`ff=~${quoteRegexPrefix(`${t.flagKey}=`)}`];
      return `count(increase(${count}${matchersOf(base, extra)}${windowOf(w)}) > 0)`;
    },
    scrapeSamples: (t, w) =>
      `max(count_over_time(${count}${matchersOf({ namespace: t.namespace, workloadName: t.workloadName })}${windowOf(w)}))`,
    series: (kind, t, stepSec) => {
      const w = seriesRateWindowSec(stepSec);
      switch (kind) {
        case "requestRate":
          return over("rate", t, w).total;
        // 0 request ⇒ 0/0 = NaN ⇒ `null`: không lưu lượng không phải "không lỗi"
        case "errorRatio":
          return errorRate(t, w);
        case "latencyP99":
          return latencyP99(t, w);
      }
    },
  };
}

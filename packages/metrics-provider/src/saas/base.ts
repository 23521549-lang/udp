import { METRICS_PROVIDER } from "@udp/config/constants";
import type { AdapterResult } from "@udp/shared-types";
import type {
  MetricSample,
  MetricSeries,
  MetricTarget,
  MetricsSeriesProvider,
  ProbeOutcome,
  SeriesKind,
  SeriesPoint,
  SeriesWindow,
} from "../provider.js";
import {
  alignSeries,
  MetricsQueryError,
  SERIES_UNIT,
  seriesGrid,
} from "../series.js";

/**
 * Lớp nền của nguồn metrics SaaS (§5.4, Plan #31) — Datadog, New Relic, Dynatrace.
 *
 * Ba nhà cung cấp nói ba ngôn ngữ truy vấn nhưng cùng một hình: gửi một truy vấn, nhận về
 * một số. Lớp nền giữ phần GIỐNG nhau và là chỗ duy nhất giữ các luật của §5.4:
 *
 *  - **Không dữ liệu ⇒ `hasData: false`**, không bao giờ là 0 (I7).
 *  - **0 lỗi khi CÓ lưu lượng** — nhà cung cấp không trả series lỗi cho nhánh chưa từng lỗi;
 *    chỉ khi truy vấn tổng có số thì "không có series lỗi" mới là 0 (cùng luật với PromQL).
 *  - **Truy vấn thật đi kèm mẫu**, để `metric_snapshot` tái lập được.
 *
 * Adapter con chỉ khai ngôn ngữ (`language`), cách chạy một truy vấn (`run`), một truy vấn
 * chuỗi thời gian (`runSeries`) và cách hỏi "khoá còn dùng được không" (`ping`).
 */

/** Kết quả một truy vấn: không hỏi được, hay hỏi được (có số hoặc rỗng) */
export type Scalar = { kind: "ok"; value?: number } | { kind: "failed" };

/**
 * [Plan #53] Khoảng của một lần hỏi chuỗi: điểm ở mốc lưới `t` là ô `(t − step, t]` — nhìn lùi
 * như `rate(…[w])` của PromQL — nên khoảng bắt đầu LÙI một bước trước mốc đầu của lưới và kết
 * thúc ở mốc cuối. Mọi ô vì thế đã đóng: không có ô dở ở mép phải làm đồ thị tụt xuống.
 */
export interface SeriesSpan {
  /** Epoch giây, chia hết cho bước */
  fromSec: number;
  /** Epoch giây, chia hết cho bước — mốc cuối của lưới */
  toSec: number;
  stepSec: number;
}

export interface SaaSQueryLanguage {
  /** Tổng số request của target trong cửa sổ */
  requests(t: MetricTarget, windowSec: number): string;
  /** Số request 5xx của target trong cửa sổ */
  errors(t: MetricTarget, windowSec: number): string;
  /** p99 độ trễ, theo GIÂY — lớp nền đổi ra mili giây như Prometheus */
  p99(t: MetricTarget, windowSec: number): string;
  /**
   * Lưu lượng cho `probe()` (§7.4 hai pha): không `flagKey` ⇒ của workload; có `flagKey` ⇒
   * của MỌI nhánh flag đó (variant mới chưa có traffic).
   */
  probe(t: MetricTarget, windowSec: number): string;
  /**
   * [Plan #53] SỐ request trong mỗi ô `stepSec` của `span` — lớp nền chia cho bước ra
   * request/giây. Đếm rồi chia thay cho hàm rate riêng của từng nhà: cùng một phép tính kiểm
   * được cho cả ba, và khớp với số đếm của `requests` mà `decide()` đã dùng.
   */
  seriesRequests(t: MetricTarget, span: SeriesSpan): string;
  /** [Plan #53] Số request 5xx trong mỗi ô — lớp nền chia cho `seriesRequests` cùng mốc */
  seriesErrors(t: MetricTarget, span: SeriesSpan): string;
  /** [Plan #53] p99 độ trễ của mỗi ô, theo GIÂY — lớp nền đổi ra mili giây */
  seriesP99(t: MetricTarget, span: SeriesSpan): string;
}

export interface SaaSProviderOptions {
  fetch?: typeof fetch;
  /** Hạn chờ mỗi lời gọi HTTP */
  timeoutMs?: number;
}

export abstract class SaaSMetricsProvider implements MetricsSeriesProvider {
  abstract readonly providerId: string;
  /** DQL, NRQL, metric selector — không phải PromQL (§5.3) */
  readonly capabilityVersion = "1.x";
  readonly scrapeLagSeconds = METRICS_PROVIDER.saasExportIntervalSeconds;
  protected readonly fetchImpl: typeof fetch;
  protected readonly timeoutMs: number;

  protected constructor(
    protected readonly language: SaaSQueryLanguage,
    options: SaaSProviderOptions,
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? METRICS_PROVIDER.queryTimeoutMs;
  }

  /** Chạy MỘT truy vấn của ngôn ngữ nhà cung cấp trên cửa sổ `windowSec` giây gần nhất */
  protected abstract run(query: string, windowSec: number): Promise<Scalar>;
  /**
   * Chạy MỘT truy vấn chuỗi trên `span`. Mỗi điểm mang mốc CUỐI của ô nó đo, theo giây —
   * adapter đổi từ quy ước của nhà cung cấp (mốc đầu ô, mili giây…). `undefined` là không hỏi
   * được; mảng rỗng là hỏi được mà không có dữ liệu.
   */
  protected abstract runSeries(
    query: string,
    span: SeriesSpan,
  ): Promise<SeriesPoint[] | undefined>;
  /** Khoá hợp lệ và API tới được — `probe()` phân biệt "không tới được" với "không có số" */
  protected abstract ping(): Promise<boolean>;

  requestCount(t: MetricTarget, w: number): Promise<MetricSample> {
    return this.sample(this.language.requests(t, w), w);
  }

  async errorCount(t: MetricTarget, w: number): Promise<MetricSample> {
    const query = this.language.errors(t, w);
    const { errors } = await this.errorsWithTraffic(t, w, query);
    return errors === undefined
      ? { value: 0, query, windowSeconds: w, hasData: false }
      : { value: errors, query, windowSeconds: w, hasData: true };
  }

  async errorRate(t: MetricTarget, w: number): Promise<MetricSample> {
    const errorsQuery = this.language.errors(t, w);
    const query = `(${errorsQuery}) / (${this.language.requests(t, w)})`;
    const { errors, requests } = await this.errorsWithTraffic(
      t,
      w,
      errorsQuery,
    );
    // 0 request ⇒ không có tỉ lệ nào (0/0), vẫn là "không biết"
    return errors === undefined || requests === undefined || requests <= 0
      ? { value: 0, query, windowSeconds: w, hasData: false }
      : { value: errors / requests, query, windowSeconds: w, hasData: true };
  }

  async latencyP99(t: MetricTarget, w: number): Promise<MetricSample> {
    const sample = await this.sample(this.language.p99(t, w), w);
    return sample.hasData ? { ...sample, value: sample.value * 1000 } : sample;
  }

  custom(query: string, _t: MetricTarget, w: number): Promise<MetricSample> {
    return this.sample(query, w);
  }

  async probe(t: MetricTarget): Promise<AdapterResult<ProbeOutcome>> {
    const started = Date.now();
    // API không cho đo chu kỳ đẩy của agent: dùng chu kỳ mặc định, ghi rõ là GIẢ ĐỊNH
    const assumed = {
      scrapeIntervalSec: METRICS_PROVIDER.saasExportIntervalSeconds,
      scrapeIntervalSource: "assumed" as const,
    };
    if (!(await this.ping())) {
      return {
        status: "FAILED",
        message: `${this.providerId} không tới được hoặc khoá không hợp lệ`,
        data: {
          reachable: false,
          hasSeries: false,
          queryFailed: false,
          ...assumed,
        },
        durationMs: Date.now() - started,
      };
    }
    const window = METRICS_PROVIDER.probeWindowSeconds;
    const series = await this.run(this.language.probe(t, window), window);
    const queryFailed = series.kind === "failed";
    return {
      status: queryFailed ? "FAILED" : "SUCCESS",
      ...(queryFailed
        ? { message: `${this.providerId} sống nhưng truy vấn probe hỏng` }
        : {}),
      data: {
        reachable: true,
        hasSeries:
          series.kind === "ok" &&
          series.value !== undefined &&
          series.value > 0,
        queryFailed,
        ...assumed,
      },
      durationMs: Date.now() - started,
    };
  }

  /**
   * Chuỗi RED trên lưới của `seriesGrid` — xem hợp đồng ở `MetricsSeriesProvider.series`. Lớp nền
   * giữ phần giống nhau của ba nhà: đặt điểm vào lưới, `null` cho mốc thiếu, đổi đơn vị, và
   * tỉ lệ lỗi tính theo TỪNG mốc từ hai chuỗi đếm.
   */
  async series(
    kind: SeriesKind,
    t: MetricTarget,
    window: SeriesWindow,
  ): Promise<MetricSeries> {
    const grid = seriesGrid(window);
    const span: SeriesSpan = {
      fromSec: grid.startSec - grid.stepSec,
      toSec: grid.endSec,
      stepSec: grid.stepSec,
    };
    const unit = SERIES_UNIT[kind];
    switch (kind) {
      case "requestRate": {
        const query = this.language.seriesRequests(t, span);
        const counts = alignSeries(grid, await this.seriesOf(query, span));
        return {
          kind,
          unit,
          query,
          points: counts.map((p) => ({
            t: p.t,
            v: p.v === null ? null : p.v / grid.stepSec,
          })),
        };
      }
      case "errorRatio": {
        const errorsQuery = this.language.seriesErrors(t, span);
        const requestsQuery = this.language.seriesRequests(t, span);
        const [errors, requests] = await Promise.all([
          this.seriesOf(errorsQuery, span),
          this.seriesOf(requestsQuery, span),
        ]);
        const errorsAt = alignSeries(grid, errors);
        return {
          kind,
          unit,
          query: `(${errorsQuery}) / (${requestsQuery})`,
          // 0 request ⇒ 0/0, "không biết"; có request mà không có điểm lỗi ⇒ 0 lỗi — nhà cung
          // cấp không trả series lỗi cho nhánh chưa từng lỗi (cùng luật với `errorRate`)
          points: alignSeries(grid, requests).map((p, i) => ({
            t: p.t,
            v: p.v === null || p.v <= 0 ? null : (errorsAt[i]?.v ?? 0) / p.v,
          })),
        };
      }
      case "latencyP99": {
        const { query, points } = await this.latencySeries(t, span);
        return {
          kind,
          unit,
          query,
          points: alignSeries(grid, points).map((p) => ({
            t: p.t,
            v: p.v === null ? null : p.v * 1000,
          })),
        };
      }
    }
  }

  /** p99 theo GIÂY của từng ô — Dynatrace ghi đè để tính từ bucket như `latencyP99` */
  protected async latencySeries(
    t: MetricTarget,
    span: SeriesSpan,
  ): Promise<{ query: string; points: SeriesPoint[] }> {
    const query = this.language.seriesP99(t, span);
    return { query, points: await this.seriesOf(query, span) };
  }

  /** Một truy vấn chuỗi; không hỏi được ⇒ ném — chuỗi KHÔNG có đường lùi "toàn 0" */
  protected async seriesOf(
    query: string,
    span: SeriesSpan,
  ): Promise<SeriesPoint[]> {
    const points = await this.runSeries(query, span);
    if (points === undefined) {
      throw new MetricsQueryError(this.providerId, query);
    }
    return points;
  }

  private async sample(query: string, w: number): Promise<MetricSample> {
    const result = await this.run(query, w);
    return result.kind === "ok" && result.value !== undefined
      ? { value: result.value, query, windowSeconds: w, hasData: true }
      : { value: 0, query, windowSeconds: w, hasData: false };
  }

  /** Số lỗi và số request; "không có series lỗi" chỉ là 0 khi số request CÓ mặt */
  private async errorsWithTraffic(
    t: MetricTarget,
    w: number,
    errorsQuery: string,
  ): Promise<{ errors?: number; requests?: number }> {
    const [errors, requests] = await Promise.all([
      this.run(errorsQuery, w),
      this.run(this.language.requests(t, w), w),
    ]);
    const total =
      requests.kind === "ok" && requests.value !== undefined
        ? { requests: requests.value }
        : {};
    if (errors.kind === "ok" && errors.value !== undefined) {
      return { errors: errors.value, ...total };
    }
    // Hỏi được mà rỗng: 0 lỗi CHỈ KHI có lưu lượng; truy vấn hỏng thì vẫn "không biết"
    return errors.kind === "ok" && total.requests !== undefined
      ? { errors: 0, ...total }
      : total;
  }
}

/** Số hữu hạn đầu tiên trong một giá trị JSON bất kỳ hình — `null`/`NaN` là rỗng */
export function finiteOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

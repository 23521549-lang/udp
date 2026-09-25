import { METRICS_PROVIDER } from "@udp/config/constants";
import type { AdapterResult } from "@udp/shared-types";
import type {
  MetricSample,
  MetricTarget,
  MetricsProvider,
  ProbeOutcome,
} from "../provider.js";

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
 * Adapter con chỉ khai ngôn ngữ (`language`), cách chạy một truy vấn (`run`) và cách hỏi
 * "khoá còn dùng được không" (`ping`).
 */

/** Kết quả một truy vấn: không hỏi được, hay hỏi được (có số hoặc rỗng) */
export type Scalar = { kind: "ok"; value?: number } | { kind: "failed" };

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
}

export interface SaaSProviderOptions {
  fetch?: typeof fetch;
  /** Hạn chờ mỗi lời gọi HTTP */
  timeoutMs?: number;
}

export abstract class SaaSMetricsProvider implements MetricsProvider {
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

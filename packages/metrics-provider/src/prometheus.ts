import { METRICS_PROVIDER } from "@udp/config/constants";
import type { AdapterResult } from "@udp/shared-types";
import type {
  MetricSample,
  MetricTarget,
  MetricsProvider,
  ProbeOutcome,
  ScrapeIntervalSource,
} from "./provider.js";
import { queryTemplates, type QueryTemplates } from "./query-templates.js";

/**
 * `MetricsProvider` cho Prometheus HTTP API (§5.4, §7.4).
 *
 * Ba quy tắc, mỗi cái canh một chế độ hỏng đã có tên trong thiết kế:
 *
 *   - **Không có dữ liệu ⇒ `hasData: false`, không bao giờ là 0.** Vector rỗng,
 *     `NaN`/`Inf` (histogram_quantile khi không có bucket), HTTP lỗi, hết hạn
 *     chờ — tất cả đều là "không biết", và §7.5 vấn đề 3 nói rõ "không biết"
 *     không được thành "không lỗi" (I7).
 *   - **Truy vấn thật đi kèm mẫu.** `RolloutEvent.metric_snapshot.query` là thứ
 *     người vận hành dán lại vào Prometheus để tái lập con số đã dẫn tới
 *     rollback (§7.4 "Ghi vết").
 *   - **Có hạn chờ.** Một Prometheus treo không được giữ vòng reconciliation
 *     treo theo: lease 60 giây sẽ hết trong lúc chờ và worker khác giẫm lên.
 *
 * Kết nối tới Prometheus trong cluster của tenant qua API-server service proxy
 * (ADR-06) chưa có ở lát cắt này: `baseUrl` là địa chỉ trực tiếp (`PROMETHEUS_URL`
 * ở dev). `fetch` tiêm được để test dựng server giả hoặc kiểm hạn chờ.
 */

export interface PrometheusProviderOptions {
  baseUrl: string;
  /**
   * Độ trễ scrape (giây) mà `decide()` chờ sau mỗi bậc, cho tới khi
   * `refreshScrapeLag()` đọc được con số thật từ `/api/v1/targets`; mặc định
   * `METRICS_PROVIDER.defaultScrapeLagSeconds`
   */
  scrapeLagSeconds?: number;
  /** Hạn chờ mỗi lời gọi HTTP */
  timeoutMs?: number;
  /** Tên metric của app nếu không theo OTel semconv (`RolloutSession.metric_queries`) */
  metricBase?: string;
  fetch?: typeof fetch;
}

interface InstantVector {
  status: string;
  data?: { resultType?: string; result?: { value?: [number, string] }[] };
}

interface TargetsResponse {
  status: string;
  data?: { activeTargets?: { scrapeInterval?: string; health?: string }[] };
}

/** `15s`, `1m`, `500ms` → giây; không hiểu thì `undefined` */
export function parseDurationSeconds(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text.trim());
  if (m === null) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  const factor =
    unit === "ms" ? 0.001 : unit === "s" ? 1 : unit === "m" ? 60 : 3600;
  return n * factor;
}

export class PrometheusMetricsProvider implements MetricsProvider {
  readonly providerId = "prometheus";
  readonly capabilityVersion = "2.x";
  private lagSeconds: number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly templates: QueryTemplates;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PrometheusProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.lagSeconds =
      options.scrapeLagSeconds ?? METRICS_PROVIDER.defaultScrapeLagSeconds;
    this.timeoutMs = options.timeoutMs ?? METRICS_PROVIDER.queryTimeoutMs;
    this.templates = queryTemplates(options.metricBase);
    this.fetchImpl = options.fetch ?? fetch;
  }

  get scrapeLagSeconds(): number {
    return this.lagSeconds;
  }

  /**
   * Đọc scrape interval LỚN NHẤT của các target đang sống và dùng nó làm độ trễ
   * scrape (§5.4 [v4.2]). Không đọc được (Prometheus chưa lên, không target) thì
   * giữ nguyên giá trị đang có — không bao giờ hạ xuống 0. Trả về con số đang
   * dùng sau lần đọc.
   */
  async refreshScrapeLag(): Promise<number> {
    const measured = await this.scrapeInterval();
    if (measured !== undefined && measured > 0) this.lagSeconds = measured;
    return this.lagSeconds;
  }

  requestCount(t: MetricTarget, w: number): Promise<MetricSample> {
    return this.instant(this.templates.requestCount(t, w), w);
  }

  errorCount(t: MetricTarget, w: number): Promise<MetricSample> {
    return this.instant(this.templates.errorCount(t, w), w);
  }

  errorRate(t: MetricTarget, w: number): Promise<MetricSample> {
    return this.instant(this.templates.errorRate(t, w), w);
  }

  async latencyP99(t: MetricTarget, w: number): Promise<MetricSample> {
    // histogram_quantile trả giây; §7.4 so với `latencyP99Ms`
    const sample = await this.instant(this.templates.latencyP99(t, w), w);
    return sample.hasData ? { ...sample, value: sample.value * 1000 } : sample;
  }

  custom(query: string, _t: MetricTarget, w: number): Promise<MetricSample> {
    return this.instant(query, w);
  }

  async probe(t: MetricTarget): Promise<AdapterResult<ProbeOutcome>> {
    const started = Date.now();
    const ready = await this.get("/-/ready");
    if (ready === undefined) {
      return {
        status: "FAILED",
        message: "Prometheus không tới được hoặc chưa sẵn sàng",
        data: {
          reachable: false,
          hasSeries: false,
          queryFailed: false,
          scrapeIntervalSource: "assumed",
        },
        durationMs: Date.now() - started,
      };
    }
    const window = METRICS_PROVIDER.probeWindowSeconds;
    // Song song: probe nằm trên đường request của S1 và trong lease của S3
    const [series, scrape] = await Promise.all([
      this.query(this.templates.probeSeries(t, window)),
      this.scrapeIntervalOf(t, window),
    ]);
    const queryFailed = series.kind === "failed";
    return {
      status: queryFailed ? "FAILED" : "SUCCESS",
      ...(queryFailed
        ? { message: "Prometheus sống nhưng truy vấn probe hỏng" }
        : {}),
      data: {
        reachable: true,
        hasSeries:
          series.kind === "ok" &&
          series.value !== undefined &&
          series.value > 0,
        queryFailed,
        ...(scrape.seconds === undefined
          ? {}
          : { scrapeIntervalSec: scrape.seconds }),
        scrapeIntervalSource: scrape.source,
      },
      durationMs: Date.now() - started,
    };
  }

  /**
   * Scrape interval của CHÍNH workload: `n` mẫu trong cửa sổ cho `n − 1` khoảng,
   * nên interval ≤ `cửa sổ / (n − 1)` — không đánh giá THẤP (validator "cửa sổ ≥
   * 4 × scrape" dựa vào đó). Series trẻ hơn cửa sổ (pod vừa deploy: 2 mẫu ⇒ 300s)
   * thì con số đó phóng đại, nên chặn trên bằng số lớn nhất của `/api/v1/targets`
   * — cận trên của MỌI target. Không đo được gì thì `assumed`.
   */
  private async scrapeIntervalOf(
    t: MetricTarget,
    windowSec: number,
  ): Promise<{ seconds?: number; source: ScrapeIntervalSource }> {
    const [samples, global] = await Promise.all([
      this.query(this.templates.scrapeSamples(t, windowSec)),
      this.scrapeInterval(),
    ]);
    if (
      samples.kind === "ok" &&
      samples.value !== undefined &&
      samples.value >= 2
    ) {
      const measured = windowSec / (samples.value - 1);
      return global !== undefined && global < measured
        ? { seconds: global, source: "global" }
        : { seconds: measured, source: "workload" };
    }
    return global === undefined
      ? { source: "assumed" }
      : { seconds: global, source: "global" };
  }

  /**
   * Một truy vấn tức thời. Mọi đường hỏng đều về `hasData: false` kèm đúng chuỗi
   * truy vấn, để lý do HOLD trong `last_decision` nói được "đo cái gì".
   */
  private async instant(
    query: string,
    windowSeconds: number,
  ): Promise<MetricSample> {
    const result = await this.query(query);
    return result.kind === "ok" && result.value !== undefined
      ? { value: result.value, query, windowSeconds, hasData: true }
      : { value: 0, query, windowSeconds, hasData: false };
  }

  /**
   * Hỏi Prometheus và PHÂN BIỆT hai thứ mà `instant` gộp làm một: `failed` —
   * không hỏi được (HTTP lỗi, hết giờ, trả sai hình); `ok` không `value` — hỏi
   * được, kết quả rỗng hoặc NaN/Inf. `probe()` cần sự phân biệt đó (§7.4).
   */
  private async query(
    query: string,
  ): Promise<{ kind: "ok"; value?: number } | { kind: "failed" }> {
    const body = await this.get(
      `/api/v1/query?query=${encodeURIComponent(query)}`,
    );
    if (body === undefined) return { kind: "failed" };
    let parsed: InstantVector;
    try {
      parsed = JSON.parse(body) as InstantVector;
    } catch {
      return { kind: "failed" };
    }
    if (parsed.status !== "success" || parsed.data?.resultType !== "vector") {
      return { kind: "failed" };
    }
    const first = parsed.data.result?.[0]?.value?.[1];
    if (first === undefined) return { kind: "ok" };
    const value = Number(first);
    return Number.isFinite(value) ? { kind: "ok", value } : { kind: "ok" };
  }

  /** Scrape interval LỚN NHẤT trong các target đang sống — validator ép cửa sổ theo số này */
  private async scrapeInterval(): Promise<number | undefined> {
    const body = await this.get("/api/v1/targets?state=active");
    if (body === undefined) return undefined;
    let parsed: TargetsResponse;
    try {
      parsed = JSON.parse(body) as TargetsResponse;
    } catch {
      return undefined;
    }
    let max: number | undefined;
    for (const target of parsed.data?.activeTargets ?? []) {
      if (target.scrapeInterval === undefined) continue;
      const seconds = parseDurationSeconds(target.scrapeInterval);
      if (seconds !== undefined && (max === undefined || seconds > max)) {
        max = seconds;
      }
    }
    return max;
  }

  /**
   * GET có hạn chờ; mọi lỗi (mạng, mã ≠ 2xx, quá hạn) về `undefined`.
   *
   * Hạn chờ do CHÍNH provider giữ (`Promise.race`), không chỉ nhờ `signal`: một
   * `fetch` tiêm vào hay một proxy không tôn trọng `AbortSignal` vẫn không được
   * giữ vòng reconciliation treo quá `timeoutMs`. Signal vẫn gửi đi để bên có
   * tôn trọng thì huỷ được kết nối thật.
   */
  private async get(path: string): Promise<string | undefined> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, this.timeoutMs);
    });
    const request = (async (): Promise<string | undefined> => {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          signal: controller.signal,
        });
        if (!res.ok) return undefined;
        return await res.text();
      } catch {
        return undefined;
      }
    })();
    try {
      return await Promise.race([request, expired]);
    } finally {
      clearTimeout(timer);
    }
  }
}

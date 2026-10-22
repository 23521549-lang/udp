import { parseJson, timedRequest } from "../http.js";
import type { MetricSample, MetricTarget, SeriesPoint } from "../provider.js";
import { DEFAULT_METRIC_BASE, ffLabel } from "../query-templates.js";
import { MetricsQueryError } from "../series.js";
import {
  finiteOf,
  SaaSMetricsProvider,
  type SaaSProviderOptions,
  type SaaSQueryLanguage,
  type Scalar,
  type SeriesSpan,
} from "./base.js";
import { histogramQuantile } from "./quantile.js";

/**
 * `MetricsProvider` cho Dynatrace (§5.4, Plan #31) — Metrics API v2, metric selector.
 *
 * **Quy ước thu thập** (nợ `saas-metrics-real`): Dynatrace scrape `/metrics` của Golden Path
 * (chú thích `metrics.dynatrace.com/scrape`); counter giữ tên (`<metricBase>_count`,
 * `<metricBase>_bucket`), nhãn Prometheus thành dimension cùng tên, namespace là
 * `k8s.namespace.name`. Dynatrace không có hàm phân vị trên bucket Prometheus, nên p99 lấy
 * số đếm theo từng `le` trong cửa sổ rồi tính bằng CHÍNH thuật toán `histogram_quantile`.
 *
 * **Chuỗi thời gian** (Plan #53): CHÍNH các selector trên, khoảng tuyệt đối (`from`/`to` mili
 * giây) và `resolution=<n>m` — độ phân giải của Dynatrace chỉ có từ phút trở lên, nên bước phải
 * chia hết cho 60 giây. Mỗi mốc trong `timestamps` là mốc CUỐI của ô (tài liệu Metrics API v2),
 * đúng quy ước của lớp nền. p99 tính theo từng mốc từ bucket, như `latencyP99`.
 */

/** Chuỗi của metric selector: `~` và `"` escape bằng `~` (cú pháp của Dynatrace) */
export const dtString = (value: string): string =>
  `"${value.replace(/~/g, "~~").replace(/"/g, '~"')}"`;

export interface DynatraceProviderOptions extends SaaSProviderOptions {
  /** `https://<id>.live.dynatrace.com` — adapter đã kiểm đúng miền SaaS của Dynatrace */
  environmentUrl: string;
  /** Token có scope `metrics.read` */
  apiToken: string;
  metricBase?: string;
}

interface QueryResponse {
  result?: {
    data?: {
      dimensionMap?: Record<string, string>;
      timestamps?: unknown[];
      values?: unknown[];
    }[];
  }[];
}

type Entry = { dimensions: Record<string, string>; value?: number };
/** Một dãy của chuỗi: mốc CUỐI ô theo giây, `null` ở ô không có dữ liệu */
type SeriesEntry = {
  dimensions: Record<string, string>;
  points: SeriesPoint[];
};

/**
 * `resolution` của một bước — Dynatrace không nhận giây. Bước lẻ phút là lỗi của bên gọi (lưới
 * của trang Giám sát là 1m/5m/15m/1h), không phải thứ nên âm thầm làm tròn: ô rộng hơn bước là
 * chia số đếm cho sai bề rộng.
 */
export function dtResolution(stepSec: number): string {
  if (stepSec % 60 !== 0) {
    throw new RangeError(
      `Dynatrace chỉ có độ phân giải theo phút: bước ${String(stepSec)}s không chia hết cho 60`,
    );
  }
  return `${String(stepSec / 60)}m`;
}

function language(metricBase: string): SaaSQueryLanguage {
  const filter = (t: MetricTarget, branch: string | null, extra?: string) =>
    `filter(and(${[
      `eq("service_name",${dtString(t.workloadName)})`,
      `eq("k8s.namespace.name",${dtString(t.namespace)})`,
      ...(t.version === undefined
        ? []
        : [`eq("service_version",${dtString(t.version)})`]),
      ...(branch === null ? [] : [branch]),
      ...(extra === undefined ? [] : [extra]),
    ].join(",")}))`;
  /** Nhắm một nhánh ⇒ đúng `ff` của nó; không ⇒ CHỈ series tổng — nhãn rỗng là không có */
  const branchOf = (t: MetricTarget): string =>
    t.flagKey !== undefined && t.variantKey !== undefined
      ? `eq("ff",${dtString(ffLabel(t.flagKey, t.variantKey))})`
      : `not(existsKey("ff"))`;
  const count = (f: string) => `${metricBase}_count:${f}:splitBy():sum`;
  const requests = (t: MetricTarget): string => count(filter(t, branchOf(t)));
  const errors = (t: MetricTarget): string =>
    count(filter(t, branchOf(t), `prefix("http_response_status_code","5")`));
  const p99 = (t: MetricTarget): string =>
    `${metricBase}_bucket:${filter(t, branchOf(t))}:splitBy("le"):sum`;
  return {
    requests,
    errors,
    p99,
    // Chuỗi: cùng selector; khoảng và độ phân giải đi trên URL
    seriesRequests: requests,
    seriesErrors: errors,
    seriesP99: p99,
    probe: (t) => {
      const base = { namespace: t.namespace, workloadName: t.workloadName };
      return count(
        filter(
          base,
          t.flagKey === undefined
            ? null
            : `prefix("ff",${dtString(`${t.flagKey}=`)})`,
        ),
      );
    },
  };
}

const leOf = (text: string | undefined): number | undefined =>
  text === "+Inf" ? Infinity : finiteOf(Number(text));

export class DynatraceMetricsProvider extends SaaSMetricsProvider {
  readonly providerId = "dynatrace";
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options: DynatraceProviderOptions) {
    super(language(options.metricBase ?? DEFAULT_METRIC_BASE), options);
    this.baseUrl = options.environmentUrl.replace(/\/+$/, "");
    this.headers = { Authorization: `Api-Token ${options.apiToken}` };
  }

  /** p99 từ bucket trong cửa sổ — cùng định nghĩa với `histogram_quantile` của PromQL */
  override async latencyP99(t: MetricTarget, w: number): Promise<MetricSample> {
    const query = this.language.p99(t, w);
    const entries = await this.entries(query, w);
    const buckets = (entries ?? []).flatMap((e) => {
      const le = leOf(e.dimensions.le);
      return le === undefined || e.value === undefined
        ? []
        : [{ le, count: e.value }];
    });
    const seconds = histogramQuantile(0.99, buckets);
    return seconds === undefined
      ? { value: 0, query, windowSeconds: w, hasData: false }
      : { value: seconds * 1000, query, windowSeconds: w, hasData: true };
  }

  protected async run(selector: string, windowSec: number): Promise<Scalar> {
    const entries = await this.entries(selector, windowSec);
    if (entries === undefined) return { kind: "failed" };
    const values = entries.flatMap((e) =>
      e.value === undefined ? [] : [e.value],
    );
    return values.length === 0
      ? { kind: "ok" }
      : { kind: "ok", value: values.reduce((a, b) => a + b, 0) };
  }

  /** Số đếm của từng ô; nhiều dãy (không nên có với `splitBy()`) thì cộng theo mốc như `run` */
  protected async runSeries(
    selector: string,
    span: SeriesSpan,
  ): Promise<SeriesPoint[] | undefined> {
    const entries = await this.seriesEntries(selector, span);
    if (entries === undefined) return undefined;
    const byTime = new Map<number, number>();
    for (const { points } of entries) {
      for (const p of points) {
        if (p.v !== null) byTime.set(p.t, (byTime.get(p.t) ?? 0) + p.v);
      }
    }
    return [...byTime].map(([t, v]) => ({ t, v }));
  }

  /** p99 theo từng mốc: gom số đếm của mọi `le` cùng mốc rồi `histogramQuantile` */
  protected override async latencySeries(
    t: MetricTarget,
    span: SeriesSpan,
  ): Promise<{ query: string; points: SeriesPoint[] }> {
    const query = this.language.seriesP99(t, span);
    const entries = await this.seriesEntries(query, span);
    if (entries === undefined) {
      throw new MetricsQueryError(this.providerId, query);
    }
    const byTime = new Map<number, { le: number; count: number }[]>();
    for (const e of entries) {
      const le = leOf(e.dimensions.le);
      if (le === undefined) continue;
      for (const p of e.points) {
        if (p.v === null) continue;
        byTime.set(p.t, [...(byTime.get(p.t) ?? []), { le, count: p.v }]);
      }
    }
    return {
      query,
      points: [...byTime].map(([at, buckets]) => ({
        t: at,
        v: histogramQuantile(0.99, buckets) ?? null,
      })),
    };
  }

  protected async ping(): Promise<boolean> {
    const parsed = parseJson<{ metrics?: unknown[] }>(
      await timedRequest(
        this.fetchImpl,
        `${this.baseUrl}/api/v2/metrics?pageSize=1`,
        { headers: this.headers },
        this.timeoutMs,
      ),
    );
    return Array.isArray(parsed?.metrics);
  }

  /**
   * Các dãy của `span` ở độ phân giải của bước; `timestamps` mili giây ⇒ giây. Hỏng, hay hai
   * mảng lệch độ dài ⇒ `undefined`.
   */
  private async seriesEntries(
    selector: string,
    span: SeriesSpan,
  ): Promise<SeriesEntry[] | undefined> {
    const url =
      `${this.baseUrl}/api/v2/metrics/query?metricSelector=${encodeURIComponent(selector)}` +
      `&from=${String(span.fromSec * 1000)}&to=${String(span.toSec * 1000)}` +
      `&resolution=${dtResolution(span.stepSec)}`;
    const parsed = parseJson<QueryResponse>(
      await timedRequest(
        this.fetchImpl,
        url,
        { headers: this.headers },
        this.timeoutMs,
      ),
    );
    if (!Array.isArray(parsed?.result)) return undefined;
    const entries: SeriesEntry[] = [];
    for (const d of parsed.result.flatMap((r) => r.data ?? [])) {
      const timestamps = d.timestamps ?? [];
      const values = d.values ?? [];
      if (timestamps.length !== values.length) return undefined;
      entries.push({
        dimensions: d.dimensionMap ?? {},
        points: timestamps.flatMap((ms, i) => {
          const at = finiteOf(ms);
          return at === undefined
            ? []
            : [{ t: at / 1000, v: finiteOf(values[i]) ?? null }];
        }),
      });
    }
    return entries;
  }

  /** Mỗi dãy của kết quả một số (`resolution=Inf` gộp cả cửa sổ); hỏng ⇒ `undefined` */
  private async entries(
    selector: string,
    windowSec: number,
  ): Promise<Entry[] | undefined> {
    const url =
      `${this.baseUrl}/api/v2/metrics/query?metricSelector=${encodeURIComponent(selector)}` +
      `&from=now-${String(windowSec)}s&resolution=Inf`;
    const parsed = parseJson<QueryResponse>(
      await timedRequest(
        this.fetchImpl,
        url,
        { headers: this.headers },
        this.timeoutMs,
      ),
    );
    if (!Array.isArray(parsed?.result)) return undefined;
    return parsed.result.flatMap((r) =>
      (r.data ?? []).map((d) => {
        const value = finiteOf(d.values?.[0]);
        return {
          dimensions: d.dimensionMap ?? {},
          ...(value === undefined ? {} : { value }),
        };
      }),
    );
  }
}

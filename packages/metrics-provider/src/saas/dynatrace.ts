import { parseJson, timedRequest } from "../http.js";
import type { MetricSample, MetricTarget } from "../provider.js";
import { DEFAULT_METRIC_BASE, ffLabel } from "../query-templates.js";
import {
  finiteOf,
  SaaSMetricsProvider,
  type SaaSProviderOptions,
  type SaaSQueryLanguage,
  type Scalar,
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
    data?: { dimensionMap?: Record<string, string>; values?: unknown[] }[];
  }[];
}

type Entry = { dimensions: Record<string, string>; value?: number };

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
  return {
    requests: (t) => count(filter(t, branchOf(t))),
    errors: (t) =>
      count(filter(t, branchOf(t), `prefix("http_response_status_code","5")`)),
    p99: (t) =>
      `${metricBase}_bucket:${filter(t, branchOf(t))}:splitBy("le"):sum`,
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

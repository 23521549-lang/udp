import { timedRequest, parseJson } from "../http.js";
import type { MetricTarget } from "../provider.js";
import { DEFAULT_METRIC_BASE, ffLabel } from "../query-templates.js";
import {
  finiteOf,
  SaaSMetricsProvider,
  type SaaSProviderOptions,
  type SaaSQueryLanguage,
  type Scalar,
} from "./base.js";

/**
 * `MetricsProvider` cho Datadog (§5.4, Plan #31) — Metrics Query API v1.
 *
 * **Quy ước thu thập** (nợ `saas-metrics-real`: chỉ kiểm được với tài khoản thật): Datadog
 * Agent scrape `/metrics` của Golden Path bằng check OpenMetrics với `namespace: udp` và
 * `histogram_buckets_as_distributions: true` — histogram thành DISTRIBUTION
 * `udp.<metricBase>`, nhãn Prometheus thành tag, namespace do autodiscovery gắn
 * (`kube_namespace`). Nhãn rỗng theo ngữ nghĩa Prometheus là KHÔNG có nhãn, nên series
 * tổng (`ff=""`) là series không có tag `ff`.
 */

export const DATADOG_SITES = [
  "datadoghq.com",
  "datadoghq.eu",
  "ap1.datadoghq.com",
] as const;
export type DatadogSite = (typeof DATADOG_SITES)[number];

/** Host API theo site — dữ liệu nằm ở vùng nào thì hỏi đúng vùng đó */
export const datadogApiHost = (site: DatadogSite): string => `api.${site}`;

/**
 * Giá trị tag theo cách Datadog chuẩn hoá lúc nhận: chữ thường, ký tự ngoài
 * `[a-z0-9_\-:./]` thành `_` (`checkout=on` ⇒ `checkout_on`). Nhờ đó giá trị người dùng
 * cũng KHÔNG mở được cú pháp truy vấn — không còn `{`, `}`, `,`, `!`, khoảng trắng.
 */
export const ddTagValue = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_\-:./]/g, "_");

export interface DatadogProviderOptions extends SaaSProviderOptions {
  site: DatadogSite;
  apiKey: string;
  appKey: string;
  /** Tên metric gốc như PromQL (`RolloutSession.metric_queries`) — agent giữ nguyên tên */
  metricBase?: string;
}

interface QueryResponse {
  status?: string;
  series?: { pointlist?: [number, number | null][] }[];
}

function language(metricBase: string): SaaSQueryLanguage {
  const metric = `udp.${metricBase}`;
  const scope = (
    t: MetricTarget,
    branch: string | null,
    extra: string[] = [],
  ) =>
    [
      `service_name:${ddTagValue(t.workloadName)}`,
      `kube_namespace:${ddTagValue(t.namespace)}`,
      ...(t.version === undefined
        ? []
        : [`service_version:${ddTagValue(t.version)}`]),
      ...(branch === null ? [] : [branch]),
      ...extra,
    ].join(",");
  /** Nhắm một nhánh ⇒ đúng tag `ff` của nó; không ⇒ CHỈ series tổng (§7.4 [v4.7]) */
  const branchOf = (t: MetricTarget): string =>
    t.flagKey !== undefined && t.variantKey !== undefined
      ? `ff:${ddTagValue(ffLabel(t.flagKey, t.variantKey))}`
      : "!ff:*";
  const count = (filter: string, w: number) =>
    `count:${metric}{${filter}}.as_count().rollup(sum, ${String(w)})`;
  return {
    requests: (t, w) => count(scope(t, branchOf(t)), w),
    errors: (t, w) =>
      count(scope(t, branchOf(t), ["http_response_status_code:5*"]), w),
    p99: (t, w) =>
      `p99:${metric}{${scope(t, branchOf(t))}}.rollup(max, ${String(w)})`,
    probe: (t, w) => {
      const base = { namespace: t.namespace, workloadName: t.workloadName };
      return count(
        scope(
          base,
          t.flagKey === undefined ? null : `ff:${ddTagValue(`${t.flagKey}=`)}*`,
        ),
        w,
      );
    },
  };
}

/**
 * Gộp các điểm theo hàm `.rollup()` cuối truy vấn: `sum` cộng (cửa sổ có thể rơi vào hai
 * ô thời gian), `max` lấy lớn nhất (p99 bi quan — thà HOLD còn hơn bỏ sót). Truy vấn tự viết
 * (`custom`) không có `.rollup()` ⇒ điểm cuối cùng.
 */
function reduce(query: string, points: number[]): number | undefined {
  if (points.length === 0) return undefined;
  const fn = /\.rollup\((sum|max),\s*\d+\)$/.exec(query)?.[1];
  if (fn === "sum") return points.reduce((a, b) => a + b, 0);
  if (fn === "max") return Math.max(...points);
  return points.at(-1);
}

export class DatadogMetricsProvider extends SaaSMetricsProvider {
  readonly providerId = "datadog";
  private readonly host: string;
  private readonly headers: Record<string, string>;

  constructor(options: DatadogProviderOptions) {
    super(language(options.metricBase ?? DEFAULT_METRIC_BASE), options);
    this.host = datadogApiHost(options.site);
    this.headers = {
      "DD-API-KEY": options.apiKey,
      "DD-APPLICATION-KEY": options.appKey,
    };
  }

  protected async run(query: string, windowSec: number): Promise<Scalar> {
    const to = Math.floor(Date.now() / 1000);
    const url =
      `https://${this.host}/api/v1/query?from=${String(to - windowSec)}` +
      `&to=${String(to)}&query=${encodeURIComponent(query)}`;
    const parsed = parseJson<QueryResponse>(
      await timedRequest(
        this.fetchImpl,
        url,
        { headers: this.headers },
        this.timeoutMs,
      ),
    );
    if (parsed?.status !== "ok" || !Array.isArray(parsed.series)) {
      return { kind: "failed" };
    }
    const points = parsed.series.flatMap((s) =>
      (s.pointlist ?? []).flatMap(([, v]) => {
        const value = finiteOf(v);
        return value === undefined ? [] : [value];
      }),
    );
    const value = reduce(query, points);
    return value === undefined ? { kind: "ok" } : { kind: "ok", value };
  }

  protected async ping(): Promise<boolean> {
    const parsed = parseJson<{ valid?: boolean }>(
      await timedRequest(
        this.fetchImpl,
        `https://${this.host}/api/v1/validate`,
        { headers: this.headers },
        this.timeoutMs,
      ),
    );
    return parsed?.valid === true;
  }
}

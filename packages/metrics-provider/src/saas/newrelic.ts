import { parseJson, timedRequest } from "../http.js";
import type { MetricTarget, SeriesPoint } from "../provider.js";
import { DEFAULT_METRIC_BASE, ffLabel } from "../query-templates.js";
import {
  finiteOf,
  SaaSMetricsProvider,
  type SaaSProviderOptions,
  type SaaSQueryLanguage,
  type Scalar,
  type SeriesSpan,
} from "./base.js";

/**
 * `MetricsProvider` cho New Relic (§5.4, Plan #31) — NRQL qua NerdGraph.
 *
 * **Quy ước thu thập** (nợ `saas-metrics-real`): tích hợp Prometheus của New Relic scrape
 * `/metrics` của Golden Path; counter thành metric kiểu `count` (delta) nên `sum()` trên
 * `SINCE` là số tăng trong cửa sổ; bucket histogram giữ tên `<metricBase>_bucket` và NRQL
 * có sẵn `bucketPercentile()` cho đúng loại đó. Nhãn Prometheus thành thuộc tính, cùng tên.
 *
 * NRQL đi qua BIẾN GraphQL (`$nrql`), không ghép vào thân GraphQL; giá trị người dùng trong
 * NRQL là chuỗi `'…'` đã escape.
 *
 * **Chuỗi thời gian** (Plan #53): CHÍNH các truy vấn trên với `TIMESERIES <bước> seconds SINCE
 * <ms> UNTIL <ms>` thay cho `SINCE … ago`. NRQL dựng các ô tính từ mốc CUỐI của khoảng (tài
 * liệu "query time range"), và mốc đó là mốc cuối của lưới — nên `endTimeSeconds` của mỗi hàng
 * rơi đúng lên lưới. Tối đa 366 ô mỗi truy vấn: lưới dày hơn thì New Relic trả lỗi, và lỗi đó
 * là `MetricsQueryError`, không phải một chuỗi rỗng.
 */

export const NEW_RELIC_REGIONS = ["US", "EU"] as const;
export type NewRelicRegion = (typeof NEW_RELIC_REGIONS)[number];

export const newRelicApiHost = (region: NewRelicRegion): string =>
  region === "EU" ? "api.eu.newrelic.com" : "api.newrelic.com";

/** Chuỗi NRQL: `'` và `\` escape bằng `\` — một tên flag có `'` không đóng được chuỗi */
export const nrqlString = (value: string): string =>
  `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const NRQL_QUERY =
  "query($accountId: Int!, $nrql: Nrql!) { actor { account(id: $accountId) { nrql(query: $nrql) { results } } } }";

export interface NewRelicProviderOptions extends SaaSProviderOptions {
  region: NewRelicRegion;
  accountId: number;
  /** User key (`NRAK-…`) — NerdGraph chỉ nhận loại khoá này */
  apiKey: string;
  metricBase?: string;
}

interface NerdGraphResponse {
  data?: {
    actor?: {
      account?: { nrql?: { results?: Record<string, unknown>[] } };
      user?: { id?: number };
    };
  };
  errors?: unknown[];
}

function language(metricBase: string): SaaSQueryLanguage {
  const where = (t: MetricTarget, branch: string | null, extra = "") =>
    [
      `service_name = ${nrqlString(t.workloadName)}`,
      `namespace = ${nrqlString(t.namespace)}`,
      ...(t.version === undefined
        ? []
        : [`service_version = ${nrqlString(t.version)}`]),
      ...(branch === null ? [] : [branch]),
      ...(extra === "" ? [] : [extra]),
    ].join(" AND ");
  /** Nhắm một nhánh ⇒ đúng `ff` của nó; không ⇒ CHỈ series tổng — nhãn rỗng là không có */
  const branchOf = (t: MetricTarget): string =>
    t.flagKey !== undefined && t.variantKey !== undefined
      ? `ff = ${nrqlString(ffLabel(t.flagKey, t.variantKey))}`
      : "(ff IS NULL OR ff = '')";
  /** Mệnh đề thời gian: cửa sổ gần nhất cho truy vấn tức thời, khoảng tuyệt đối cho chuỗi */
  const since = (w: number) => `SINCE ${String(w)} seconds ago`;
  const timeseries = (span: SeriesSpan) =>
    `TIMESERIES ${String(span.stepSec)} seconds SINCE ${String(span.fromSec * 1000)} UNTIL ${String(span.toSec * 1000)}`;
  const count = (filter: string, time: string) =>
    `SELECT sum(${metricBase}_count) AS value FROM Metric WHERE ${filter} ${time}`;
  const requests = (t: MetricTarget, time: string) =>
    count(where(t, branchOf(t)), time);
  const errors = (t: MetricTarget, time: string) =>
    count(where(t, branchOf(t), "http_response_status_code LIKE '5%'"), time);
  const p99 = (t: MetricTarget, time: string) =>
    `SELECT bucketPercentile(${metricBase}_bucket, 99) AS value FROM Metric WHERE ${where(t, branchOf(t))} ${time}`;
  return {
    requests: (t, w) => requests(t, since(w)),
    errors: (t, w) => errors(t, since(w)),
    p99: (t, w) => p99(t, since(w)),
    seriesRequests: (t, span) => requests(t, timeseries(span)),
    seriesErrors: (t, span) => errors(t, timeseries(span)),
    seriesP99: (t, span) => p99(t, timeseries(span)),
    probe: (t, w) => {
      const base = { namespace: t.namespace, workloadName: t.workloadName };
      return count(
        where(
          base,
          t.flagKey === undefined
            ? null
            : `ff LIKE ${nrqlString(`${t.flagKey}=%`)}`,
        ),
        since(w),
      );
    },
  };
}

/**
 * Số của hàng đầu: `value` là số, hay một object một số (`bucketPercentile` trả
 * `{ "99": 0.12 }`). `null` là rỗng — New Relic trả `null` khi không có điểm nào.
 */
function valueOf(row: Record<string, unknown> | undefined): number | undefined {
  const raw = row?.value;
  if (typeof raw === "object" && raw !== null) {
    return finiteOf(Object.values(raw)[0]);
  }
  return finiteOf(raw);
}

export class NewRelicMetricsProvider extends SaaSMetricsProvider {
  readonly providerId = "newrelic";
  private readonly url: string;
  private readonly apiKey: string;
  private readonly accountId: number;

  constructor(options: NewRelicProviderOptions) {
    super(language(options.metricBase ?? DEFAULT_METRIC_BASE), options);
    this.url = `https://${newRelicApiHost(options.region)}/graphql`;
    this.apiKey = options.apiKey;
    this.accountId = options.accountId;
  }

  protected async run(nrql: string): Promise<Scalar> {
    const results = await this.nrql(nrql);
    if (results === undefined) return { kind: "failed" };
    const value = valueOf(results[0]);
    return value === undefined ? { kind: "ok" } : { kind: "ok", value };
  }

  /** Mỗi hàng `TIMESERIES` là một ô; `endTimeSeconds` đã là mốc CUỐI ô, theo giây */
  protected async runSeries(nrql: string): Promise<SeriesPoint[] | undefined> {
    const results = await this.nrql(nrql);
    if (results === undefined) return undefined;
    return results.flatMap((row) => {
      const t = finiteOf(row.endTimeSeconds);
      return t === undefined ? [] : [{ t, v: valueOf(row) ?? null }];
    });
  }

  protected async ping(): Promise<boolean> {
    const parsed = await this.graphql({ query: "{ actor { user { id } } }" });
    return typeof parsed?.data?.actor?.user?.id === "number";
  }

  /** Các hàng của một NRQL; hỏng, GraphQL báo `errors` hay thiếu `results` ⇒ `undefined` */
  private async nrql(
    nrql: string,
  ): Promise<Record<string, unknown>[] | undefined> {
    const parsed = await this.graphql({
      query: NRQL_QUERY,
      variables: { accountId: this.accountId, nrql },
    });
    const results = parsed?.data?.actor?.account?.nrql?.results;
    return parsed === undefined ||
      parsed.errors !== undefined ||
      !Array.isArray(results)
      ? undefined
      : results;
  }

  private async graphql(
    body: Record<string, unknown>,
  ): Promise<NerdGraphResponse | undefined> {
    return parseJson<NerdGraphResponse>(
      await timedRequest(
        this.fetchImpl,
        this.url,
        {
          method: "POST",
          headers: {
            "API-Key": this.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        this.timeoutMs,
      ),
    );
  }
}

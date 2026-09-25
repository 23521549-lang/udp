import { parseJson, timedRequest } from "../http.js";
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
 * `MetricsProvider` cho New Relic (§5.4, Plan #31) — NRQL qua NerdGraph.
 *
 * **Quy ước thu thập** (nợ `saas-metrics-real`): tích hợp Prometheus của New Relic scrape
 * `/metrics` của Golden Path; counter thành metric kiểu `count` (delta) nên `sum()` trên
 * `SINCE` là số tăng trong cửa sổ; bucket histogram giữ tên `<metricBase>_bucket` và NRQL
 * có sẵn `bucketPercentile()` cho đúng loại đó. Nhãn Prometheus thành thuộc tính, cùng tên.
 *
 * NRQL đi qua BIẾN GraphQL (`$nrql`), không ghép vào thân GraphQL; giá trị người dùng trong
 * NRQL là chuỗi `'…'` đã escape.
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
  const since = (w: number) => `SINCE ${String(w)} seconds ago`;
  const count = (filter: string, w: number) =>
    `SELECT sum(${metricBase}_count) AS value FROM Metric WHERE ${filter} ${since(w)}`;
  return {
    requests: (t, w) => count(where(t, branchOf(t)), w),
    errors: (t, w) =>
      count(where(t, branchOf(t), "http_response_status_code LIKE '5%'"), w),
    p99: (t, w) =>
      `SELECT bucketPercentile(${metricBase}_bucket, 99) AS value FROM Metric WHERE ${where(t, branchOf(t))} ${since(w)}`,
    probe: (t, w) => {
      const base = { namespace: t.namespace, workloadName: t.workloadName };
      return count(
        where(
          base,
          t.flagKey === undefined
            ? null
            : `ff LIKE ${nrqlString(`${t.flagKey}=%`)}`,
        ),
        w,
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
    const parsed = await this.graphql({
      query: NRQL_QUERY,
      variables: { accountId: this.accountId, nrql },
    });
    const results = parsed?.data?.actor?.account?.nrql?.results;
    if (parsed === undefined || parsed.errors !== undefined || !results) {
      return { kind: "failed" };
    }
    const value = valueOf(results[0]);
    return value === undefined ? { kind: "ok" } : { kind: "ok", value };
  }

  protected async ping(): Promise<boolean> {
    const parsed = await this.graphql({ query: "{ actor { user { id } } }" });
    return typeof parsed?.data?.actor?.user?.id === "number";
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

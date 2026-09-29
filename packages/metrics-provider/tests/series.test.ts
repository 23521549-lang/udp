import { describe, expect, it } from "vitest";
import {
  DatadogMetricsProvider,
  DynatraceMetricsProvider,
  MAX_SERIES_STEPS,
  MetricsQueryError,
  NewRelicMetricsProvider,
  PrometheusMetricsProvider,
  queryTemplates,
  seriesGrid,
  seriesRateWindowSec,
} from "../src/index.js";
import type { MetricsSeriesProvider, SeriesWindow } from "../src/index.js";
import { FakeMetricsProvider } from "../src/testing.js";

/**
 * Chuỗi thời gian RED (Plan #53 QĐ-4, AC-2) trước một `fetch` giả trả đúng hình API của từng
 * nguồn. Điều được kiểm là hợp đồng của `MetricsProvider.series`: đúng lưới, mốc thiếu là
 * `null` (không bao giờ 0, I7), đúng đơn vị, đúng truy vấn gửi đi; hỏng ⇒ `MetricsQueryError`.
 */

type Reply = { status: number; body: unknown };
interface Call {
  url: URL;
  init: RequestInit | undefined;
}

function fakeFetch(handler: (url: URL, init?: RequestInit) => Reply) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    const out = handler(url, init);
    return Promise.resolve(
      new Response(
        typeof out.body === "string" ? out.body : JSON.stringify(out.body),
        { status: out.status },
      ),
    );
  };
  return { fetchImpl, calls };
}

/** Mốc cuối lưới; `end` lệch 30 giây để kiểm phép làm tròn xuống */
const E = 1_800_000_000;
const T0 = E - 300;
const GRID = [T0, T0 + 60, T0 + 120, T0 + 180, T0 + 240, E];
const WINDOW: SeriesWindow = {
  rangeSec: 300,
  stepSec: 60,
  end: new Date((E + 30) * 1000),
};
const workload = { namespace: "udp-demo-dev", workloadName: "checkout" };
const values = (points: { t: number; v: number | null }[]): (number | null)[] =>
  points.map((p) => p.v);

describe("lưới của series", () => {
  it("từ ⌊(end − range)/step⌋·step tới ⌊end/step⌋·step, mỗi bước một mốc", () => {
    expect(seriesGrid(WINDOW)).toEqual({
      startSec: T0,
      endSec: E,
      stepSec: 60,
      times: GRID,
    });
    // `end` lệch khỏi bước ⇒ mốc đầu cũng làm tròn xuống, không cắt mất một điểm
    expect(
      seriesGrid({ rangeSec: 100, stepSec: 60, end: new Date((E + 30) * 1000) })
        .times,
    ).toEqual([E - 120, E - 60, E]);
  });

  it(`quá ${String(MAX_SERIES_STEPS)} bước hay cửa sổ không nguyên dương ⇒ RangeError`, () => {
    expect(() => seriesGrid({ ...WINDOW, rangeSec: 501 * 60 })).toThrow(
      RangeError,
    );
    expect(seriesGrid({ ...WINDOW, rangeSec: 500 * 60 }).times).toHaveLength(
      501,
    );
    expect(() => seriesGrid({ ...WINDOW, stepSec: 0 })).toThrow(RangeError);
    expect(() => seriesGrid({ ...WINDOW, stepSec: 1.5 })).toThrow(RangeError);
    expect(() => seriesGrid({ ...WINDOW, end: new Date(Number.NaN) })).toThrow(
      RangeError,
    );
  });

  it("cửa sổ rate không ngắn hơn 60 giây", () => {
    expect(seriesRateWindowSec(15)).toBe(60);
    expect(seriesRateWindowSec(60)).toBe(60);
    expect(seriesRateWindowSec(900)).toBe(900);
  });
});

describe("PromQL của series — CHÍNH khuôn §7.4", () => {
  const q = queryTemplates();
  const total =
    'sum(rate(http_server_request_duration_seconds_count{service_name="checkout", namespace="udp-demo-dev", ff=""}[60s]))';

  it("requestRate là sum(rate(_count)) của series tổng, cửa sổ max(step, 60)", () => {
    expect(q.series("requestRate", workload, 30)).toBe(total);
    expect(q.series("requestRate", workload, 300)).toContain("[300s]");
  });

  it("errorRatio là 5xx / tổng, tử số 0 khi có lưu lượng mà không lỗi", () => {
    expect(q.series("errorRatio", workload, 60)).toBe(
      '(sum(rate(http_server_request_duration_seconds_count{service_name="checkout", namespace="udp-demo-dev", http_response_status_code=~"5..", ff=""}[60s])) or 0 * ' +
        `${total}) / ${total}`,
    );
  });

  it("latencyP99 là histogram_quantile trên _bucket; version lọc service_version", () => {
    expect(q.series("latencyP99", { ...workload, version: "1.4.0" }, 900)).toBe(
      'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="checkout", namespace="udp-demo-dev", service_version="1.4.0", ff=""}[900s])))',
    );
  });
});

describe("Prometheus — query_range", () => {
  const BASE =
    "https://k8s.example/api/v1/namespaces/udp-system/services/x:9090/proxy";
  const matrix = (pairs: [number, string][]) => ({
    status: "success",
    data: { resultType: "matrix", result: [{ metric: {}, values: pairs }] },
  });
  const make = (handler: (url: URL) => Reply, timeoutMs = 500) => {
    const f = fakeFetch(handler);
    return {
      ...f,
      provider: new PrometheusMetricsProvider({
        baseUrl: `${BASE}/`,
        timeoutMs,
        fetch: f.fetchImpl,
      }),
    };
  };

  it("giữ tiền tố của service proxy; start/end/step đúng lưới; truy vấn đi kèm chuỗi", async () => {
    const { provider, calls } = make(() => ({
      status: 200,
      body: matrix(GRID.map((t) => [t, "2.5"])),
    }));
    const series = await provider.series("requestRate", workload, WINDOW);
    expect(series).toEqual({
      kind: "requestRate",
      unit: "rps",
      points: GRID.map((t) => ({ t, v: 2.5 })),
      query: queryTemplates().series("requestRate", workload, 60),
    });
    const url = calls[0]?.url;
    expect(url?.pathname).toBe(
      "/api/v1/namespaces/udp-system/services/x:9090/proxy/api/v1/query_range",
    );
    expect(url?.searchParams.get("query")).toBe(series.query);
    expect(url?.searchParams.get("start")).toBe(String(T0));
    expect(url?.searchParams.get("end")).toBe(String(E));
    expect(url?.searchParams.get("step")).toBe("60s");
  });

  it("mốc Prometheus không trả (lỗ giữa chuỗi) ⇒ null, không phải 0; số 0 thật giữ là 0", async () => {
    const { provider } = make(() => ({
      status: 200,
      body: matrix([
        [T0, "1"],
        [T0 + 60, "0"],
        // T0 + 120 vắng — scrape hỏng một nhịp
        [T0 + 180.0, "3"],
        [T0 + 240, "4"],
        [E, "5"],
      ]),
    }));
    const series = await provider.series("requestRate", workload, WINDOW);
    expect(values(series.points)).toEqual([1, 0, null, 3, 4, 5]);
    expect(series.points.map((p) => p.t)).toEqual(GRID);
  });

  it('errorRatio: "NaN" (0/0 khi không có request) ⇒ null; p99 giây ⇒ mili giây', async () => {
    const ratio = make(() => ({
      status: 200,
      body: matrix([
        [T0, "0.02"],
        [T0 + 60, "NaN"],
        [T0 + 120, "+Inf"],
      ]),
    }));
    const r = await ratio.provider.series("errorRatio", workload, WINDOW);
    expect(r.unit).toBe("ratio");
    expect(values(r.points)).toEqual([0.02, null, null, null, null, null]);

    const p99 = make(() => ({
      status: 200,
      body: matrix([
        [T0, "0.25"],
        [E, "NaN"],
      ]),
    }));
    const l = await p99.provider.series("latencyP99", workload, WINDOW);
    expect(l.unit).toBe("ms");
    expect(l.points[0]?.v).toBeCloseTo(250);
    expect(l.points[5]?.v).toBeNull();
    expect(l.query).toContain("histogram_quantile(0.99");
  });

  it("ma trận rỗng ⇒ mọi mốc null — hỏi được mà không có dữ liệu, không phải lỗi", async () => {
    const { provider } = make(() => ({
      status: 200,
      body: {
        status: "success",
        data: { resultType: "matrix", result: [] },
      },
    }));
    const series = await provider.series("errorRatio", workload, WINDOW);
    expect(values(series.points)).toEqual(GRID.map(() => null));
  });

  for (const [label, reply] of [
    ["HTTP 500", { status: 500, body: "boom" }],
    ["JSON hỏng", { status: 200, body: "{not json" }],
    [
      "status error",
      { status: 200, body: { status: "error", error: "bad_data" } },
    ],
    [
      "resultType không phải matrix",
      {
        status: 200,
        body: { status: "success", data: { resultType: "vector", result: [] } },
      },
    ],
    [
      "values sai hình",
      {
        status: 200,
        body: {
          status: "success",
          data: { resultType: "matrix", result: [{ values: [[T0, 1]] }] },
        },
      },
    ],
  ] as const) {
    it(`${label} ⇒ MetricsQueryError, KHÔNG phải chuỗi toàn 0`, async () => {
      const { provider } = make(() => reply);
      const failure = provider.series("requestRate", workload, WINDOW);
      await expect(failure).rejects.toBeInstanceOf(MetricsQueryError);
      await expect(failure).rejects.toMatchObject({
        name: "MetricsQueryError",
        providerId: "prometheus",
        query: queryTemplates().series("requestRate", workload, 60),
      });
    });
  }

  it("quá hạn chờ ⇒ MetricsQueryError, không treo", async () => {
    const slow = new PrometheusMetricsProvider({
      baseUrl: BASE,
      timeoutMs: 100,
      fetch: () => new Promise(() => undefined),
    });
    const started = Date.now();
    await expect(
      slow.series("latencyP99", workload, WINDOW),
    ).rejects.toBeInstanceOf(MetricsQueryError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("quá nhiều điểm ⇒ RangeError trước khi gọi backend", async () => {
    const { provider, calls } = make(() => ({ status: 200, body: {} }));
    await expect(
      provider.series("requestRate", workload, {
        rangeSec: 7 * 86_400,
        stepSec: 60,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });
});

/** Mốc của ô SaaS: ô `(t − 60, t]` cho mỗi mốc lưới, nên khoảng hỏi bắt đầu từ T0 − 60 */
const FROM = T0 - 60;

describe("Datadog — /api/v1/query trên khoảng", () => {
  const COUNT =
    "count:udp.http_server_request_duration_seconds{service_name:checkout,kube_namespace:udp-demo-dev,!ff:*}.as_count().rollup(sum, 60)";
  /** Điểm của Datadog mang mốc ĐẦU ô, mili giây */
  const pointlist = (vs: (number | null)[]) => ({
    status: "ok",
    series: [
      { pointlist: vs.map((v, i) => [(FROM + 60 * i) * 1000, v] as const) },
    ],
  });
  const make = (handler: (url: URL) => Reply) => {
    const f = fakeFetch(handler);
    return {
      ...f,
      provider: new DatadogMetricsProvider({
        site: "datadoghq.eu",
        apiKey: "k-api",
        appKey: "k-app",
        fetch: f.fetchImpl,
        timeoutMs: 500,
      }),
    };
  };

  it("requestRate = số đếm mỗi ô / bước; mốc đầu ô + bước = mốc lưới; ô null ⇒ null", async () => {
    const { provider, calls } = make(() => ({
      status: 200,
      body: pointlist([600, 1200, null, 300, 0, 60]),
    }));
    const series = await provider.series("requestRate", workload, WINDOW);
    expect(series).toEqual({
      kind: "requestRate",
      unit: "rps",
      points: GRID.map((t, i) => ({ t, v: [10, 20, null, 5, 0, 1][i] })),
      query: COUNT,
    });
    const url = calls[0]?.url;
    expect(url?.host).toBe("api.datadoghq.eu");
    expect(url?.pathname).toBe("/api/v1/query");
    expect(url?.searchParams.get("from")).toBe(String(FROM));
    expect(url?.searchParams.get("to")).toBe(String(E));
    expect(url?.searchParams.get("query")).toBe(COUNT);
    expect(calls[0]?.init?.headers).toEqual({
      "DD-API-KEY": "k-api",
      "DD-APPLICATION-KEY": "k-app",
    });
  });

  it("errorRatio theo TỪNG mốc: 0 request ⇒ null; có request mà không điểm lỗi ⇒ 0", async () => {
    const { provider } = make((url) => ({
      status: 200,
      body: url.searchParams.get("query")?.includes("status_code:5*")
        ? pointlist([6, 3, null, null, 9, null])
        : pointlist([600, 0, 300, null, 900, 100]),
    }));
    const series = await provider.series("errorRatio", workload, WINDOW);
    expect(series.unit).toBe("ratio");
    expect(values(series.points)).toEqual([0.01, null, 0, null, 0.01, 0]);
    expect(series.query).toBe(
      `(${COUNT.replace("!ff:*", "!ff:*,http_response_status_code:5*")}) / (${COUNT})`,
    );
  });

  it("latencyP99: p99 theo giây của từng ô ⇒ mili giây; rollup(max, bước)", async () => {
    const { provider } = make(() => ({
      status: 200,
      body: pointlist([0.2, 0.35, null, null, null, null]),
    }));
    const series = await provider.series("latencyP99", workload, WINDOW);
    expect(series.points[0]?.v).toBeCloseTo(200);
    expect(series.points[1]?.v).toBeCloseTo(350);
    expect(series.points[2]?.v).toBeNull();
    expect(series.query).toMatch(/^p99:udp\..*\.rollup\(max, 60\)$/);
  });

  it("series rỗng ⇒ mọi mốc null; HTTP lỗi hay status khác ok ⇒ MetricsQueryError", async () => {
    const empty = make(() => ({
      status: 200,
      body: { status: "ok", series: [] },
    }));
    expect(
      values(
        (await empty.provider.series("requestRate", workload, WINDOW)).points,
      ),
    ).toEqual(GRID.map(() => null));

    const broken = make(() => ({ status: 500, body: {} }));
    await expect(
      broken.provider.series("errorRatio", workload, WINDOW),
    ).rejects.toMatchObject({
      name: "MetricsQueryError",
      providerId: "datadog",
    });
    const notOk = make(() => ({
      status: 200,
      body: { status: "error", error: "x" },
    }));
    await expect(
      notOk.provider.series("latencyP99", workload, WINDOW),
    ).rejects.toBeInstanceOf(MetricsQueryError);
  });
});

describe("New Relic — NRQL TIMESERIES", () => {
  const WHERE =
    "WHERE service_name = 'checkout' AND namespace = 'udp-demo-dev' AND (ff IS NULL OR ff = '')";
  const TIME = `TIMESERIES 60 seconds SINCE ${String(FROM * 1000)} UNTIL ${String(E * 1000)}`;
  const rows = (vs: unknown[]) => ({
    data: {
      actor: {
        account: {
          nrql: {
            results: vs.map((value, i) => ({
              beginTimeSeconds: FROM + 60 * i,
              endTimeSeconds: FROM + 60 * (i + 1),
              value,
            })),
          },
        },
      },
    },
  });
  const make = (handler: (url: URL, init?: RequestInit) => Reply) => {
    const f = fakeFetch(handler);
    return {
      ...f,
      provider: new NewRelicMetricsProvider({
        region: "US",
        accountId: 42,
        apiKey: "NRAK-x",
        fetch: f.fetchImpl,
        timeoutMs: 500,
      }),
    };
  };
  const nrqlOf = (init?: RequestInit): string =>
    (JSON.parse(String(init?.body)) as { variables: { nrql: string } })
      .variables.nrql;

  it("NRQL TIMESERIES trên khoảng tuyệt đối (mili giây); endTimeSeconds là mốc lưới", async () => {
    const { provider, calls } = make(() => ({
      status: 200,
      body: rows([120, 60, null, 0, 30, 6]),
    }));
    const series = await provider.series("requestRate", workload, WINDOW);
    const nrql = `SELECT sum(http_server_request_duration_seconds_count) AS value FROM Metric ${WHERE} ${TIME}`;
    expect(series).toEqual({
      kind: "requestRate",
      unit: "rps",
      points: GRID.map((t, i) => ({ t, v: [2, 1, null, 0, 0.5, 0.1][i] })),
      query: nrql,
    });
    expect(calls[0]?.url.href).toBe("https://api.newrelic.com/graphql");
    expect(calls[0]?.init?.headers).toMatchObject({ "API-Key": "NRAK-x" });
    expect(nrqlOf(calls[0]?.init)).toBe(nrql);
  });

  it("errorRatio theo từng mốc; p99 là object một số ⇒ mili giây", async () => {
    const ratio = make((_url, init) => ({
      status: 200,
      body: nrqlOf(init).includes("LIKE '5%'")
        ? rows([3, null, 1, null, null, null])
        : rows([300, 0, null, 50, null, 10]),
    }));
    const r = await ratio.provider.series("errorRatio", workload, WINDOW);
    expect(values(r.points)).toEqual([0.01, null, null, 0, null, 0]);

    const p99 = make(() => ({
      status: 200,
      body: rows([{ "99": 0.12 }, { "99": null }, null]),
    }));
    const l = await p99.provider.series("latencyP99", workload, WINDOW);
    expect(l.points[0]?.v).toBeCloseTo(120);
    expect(values(l.points).slice(1)).toEqual([null, null, null, null, null]);
    expect(l.query).toBe(
      `SELECT bucketPercentile(http_server_request_duration_seconds_bucket, 99) AS value FROM Metric ${WHERE} ${TIME}`,
    );
  });

  it("GraphQL báo errors (vd. quá 366 ô) ⇒ MetricsQueryError", async () => {
    const { provider } = make(() => ({
      status: 200,
      body: { errors: [{ message: "Too many buckets" }] },
    }));
    await expect(
      provider.series("requestRate", workload, WINDOW),
    ).rejects.toMatchObject({
      name: "MetricsQueryError",
      providerId: "newrelic",
    });
  });
});

describe("Dynatrace — metrics/query theo độ phân giải", () => {
  const COUNT =
    'http_server_request_duration_seconds_count:filter(and(eq("service_name","checkout"),eq("k8s.namespace.name","udp-demo-dev"),not(existsKey("ff")))):splitBy():sum';
  /** `timestamps` của Dynatrace là mốc CUỐI ô, mili giây — đúng các mốc lưới */
  const data = (...entries: { le?: string; values: (number | null)[] }[]) => ({
    result: [
      {
        data: entries.map((e) => ({
          dimensionMap: e.le === undefined ? {} : { le: e.le },
          timestamps: e.values
            .map((_v, i) => GRID[i] ?? 0)
            .map((t) => t * 1000),
          values: e.values,
        })),
      },
    ],
  });
  const make = (handler: (url: URL) => Reply) => {
    const f = fakeFetch(handler);
    return {
      ...f,
      provider: new DynatraceMetricsProvider({
        environmentUrl: "https://abc12345.live.dynatrace.com/",
        apiToken: "dt0c01.x",
        fetch: f.fetchImpl,
        timeoutMs: 500,
      }),
    };
  };

  it("from/to mili giây, resolution theo phút; số đếm mỗi ô / bước", async () => {
    const { provider, calls } = make(() => ({
      status: 200,
      body: data({ values: [60, 120, null, 0, 6, 12] }),
    }));
    const series = await provider.series("requestRate", workload, WINDOW);
    expect(values(series.points)).toEqual([1, 2, null, 0, 0.1, 0.2]);
    expect(series.query).toBe(COUNT);
    const url = calls[0]?.url;
    expect(`${String(url?.origin)}${String(url?.pathname)}`).toBe(
      "https://abc12345.live.dynatrace.com/api/v2/metrics/query",
    );
    expect(url?.searchParams.get("metricSelector")).toBe(COUNT);
    expect(url?.searchParams.get("from")).toBe(String(FROM * 1000));
    expect(url?.searchParams.get("to")).toBe(String(E * 1000));
    expect(url?.searchParams.get("resolution")).toBe("1m");
    expect(calls[0]?.init?.headers).toEqual({
      Authorization: "Api-Token dt0c01.x",
    });
  });

  it("errorRatio theo từng mốc", async () => {
    const { provider } = make((url) => ({
      status: 200,
      body: url.searchParams.get("metricSelector")?.includes("prefix(")
        ? data({ values: [2, null, null, 5, null, null] })
        : data({ values: [100, 0, 40, 50, null, 10] }),
    }));
    const series = await provider.series("errorRatio", workload, WINDOW);
    expect(values(series.points)).toEqual([0.02, null, 0, 0.1, null, 0]);
  });

  it("p99 từng mốc tính từ bucket bằng histogram_quantile; mốc không có request ⇒ null", async () => {
    const { provider } = make(() => ({
      status: 200,
      body: data(
        { le: "0.1", values: [50, 0] },
        { le: "0.25", values: [90, 0] },
        { le: "0.5", values: [99, 0] },
        { le: "1", values: [100, 0] },
        { le: "+Inf", values: [100, 0] },
      ),
    }));
    const series = await provider.series("latencyP99", workload, WINDOW);
    expect(series.points[0]?.v).toBeCloseTo(500);
    expect(values(series.points).slice(1)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(series.query).toContain(':splitBy("le"):sum');
  });

  it("bước 5 phút ⇒ resolution=5m; bước lẻ phút ⇒ RangeError; thiếu result ⇒ MetricsQueryError", async () => {
    const ok = make(() => ({ status: 200, body: { result: [] } }));
    await ok.provider.series("requestRate", workload, {
      rangeSec: 3600,
      stepSec: 300,
      end: WINDOW.end ?? new Date(),
    });
    expect(ok.calls[0]?.url.searchParams.get("resolution")).toBe("5m");
    await expect(
      ok.provider.series("requestRate", workload, { ...WINDOW, stepSec: 90 }),
    ).rejects.toBeInstanceOf(RangeError);

    const broken = make(() => ({ status: 200, body: { error: "x" } }));
    await expect(
      broken.provider.series("latencyP99", workload, WINDOW),
    ).rejects.toMatchObject({
      name: "MetricsQueryError",
      providerId: "dynatrace",
    });
  });
});

describe("FakeMetricsProvider.series", () => {
  it("mẫu mặc định tất định trên đúng lưới; lời gọi được ghi lại", async () => {
    const fake = new FakeMetricsProvider();
    const series = await fake.series("requestRate", workload, WINDOW);
    expect(series).toEqual({
      kind: "requestRate",
      unit: "rps",
      points: GRID.map((t, i) => ({ t, v: 10 + (i % 5) })),
      query: "fake:requestRate{*}",
    });
    expect(fake.calls).toEqual([
      {
        kind: "series",
        key: "*",
        windowSec: 300,
        series: "requestRate",
        stepSec: 60,
      },
    ]);
  });

  it("kịch bản đặt được; thiếu mốc hay NaN ⇒ null; nguồn hỏng ⇒ MetricsQueryError", async () => {
    const provider: MetricsSeriesProvider = new FakeMetricsProvider().setSeries(
      (kind) => (kind === "errorRatio" ? [0.5, Number.NaN, null, 0] : []),
    );
    expect(
      values((await provider.series("errorRatio", workload, WINDOW)).points),
    ).toEqual([0.5, null, null, 0, null, null]);
    expect(
      values((await provider.series("latencyP99", workload, WINDOW)).points),
    ).toEqual(GRID.map(() => null));

    const failing = new FakeMetricsProvider().setQueryFailing(true);
    await expect(
      failing.series("requestRate", workload, WINDOW),
    ).rejects.toBeInstanceOf(MetricsQueryError);
    await expect(
      new FakeMetricsProvider().series("requestRate", workload, {
        rangeSec: 86_400,
        stepSec: 60,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

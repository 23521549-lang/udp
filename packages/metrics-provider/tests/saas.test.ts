import { describe, expect, it } from "vitest";
import {
  createMetricsProvider,
  DatadogMetricsProvider,
  DynatraceMetricsProvider,
  histogramQuantile,
  METRICS_QUERY_MAJOR,
  NewRelicMetricsProvider,
  PrometheusMetricsProvider,
} from "../src/index.js";

/**
 * Ba nguồn metrics SaaS (Plan #31 AC-4) trước một `fetch` giả trả đúng hình API của từng nhà
 * cung cấp. Điều được kiểm là ranh giới của §5.4: đúng API, đúng khoá, truy vấn mang theo
 * mẫu; rỗng ⇒ `hasData: false` (không bao giờ là 0, I7); hỏng ⇒ `queryFailed`; 0 lỗi CHỈ
 * khi có lưu lượng.
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
      new Response(JSON.stringify(out.body), { status: out.status }),
    );
  };
  return { fetchImpl, calls };
}

const flag = {
  namespace: "udp-demo-dev",
  workloadName: "checkout",
  flagKey: "checkout_v2",
  variantKey: "on",
};
const workload = { namespace: "udp-demo-dev", workloadName: "checkout" };

describe("Datadog", () => {
  const points = (...values: (number | null)[]) => ({
    status: "ok",
    series: [{ pointlist: values.map((v, i) => [i, v]) }],
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

  it("hỏi đúng vùng, đúng khoá, tag chuẩn hoá theo Datadog; cộng các điểm của cửa sổ", async () => {
    const { provider, calls } = make(() => ({
      status: 200,
      body: points(3, 4, null),
    }));
    const sample = await provider.requestCount(flag, 60);
    expect(sample).toEqual({
      value: 7,
      query:
        "count:udp.http_server_request_duration_seconds{service_name:checkout,kube_namespace:udp-demo-dev,ff:checkout_v2_on}.as_count().rollup(sum, 60)",
      windowSeconds: 60,
      hasData: true,
    });
    const call = calls[0];
    expect(call?.url.host).toBe("api.datadoghq.eu");
    expect(call?.url.pathname).toBe("/api/v1/query");
    expect(call?.url.searchParams.get("query")).toBe(sample.query);
    expect(call?.init?.headers).toEqual({
      "DD-API-KEY": "k-api",
      "DD-APPLICATION-KEY": "k-app",
    });
  });

  it("không nhắm nhánh ⇒ chỉ series tổng (không tag ff); giá trị người dùng không mở được cú pháp", async () => {
    const { provider } = make(() => ({ status: 200, body: points(1) }));
    const sample = await provider.requestCount(
      { namespace: "ns", workloadName: "a,b}{!x" },
      30,
    );
    expect(sample.query).toBe(
      "count:udp.http_server_request_duration_seconds{service_name:a_b___x,kube_namespace:ns,!ff:*}.as_count().rollup(sum, 30)",
    );
  });

  it("rỗng ⇒ hasData false; lỗi HTTP ⇒ hasData false — không bao giờ là 0 (I7)", async () => {
    const empty = make(() => ({
      status: 200,
      body: { status: "ok", series: [] },
    }));
    expect((await empty.provider.requestCount(flag, 60)).hasData).toBe(false);
    const broken = make(() => ({ status: 500, body: {} }));
    expect((await broken.provider.errorCount(flag, 60)).hasData).toBe(false);
  });

  it("0 lỗi CHỈ khi có lưu lượng: series lỗi rỗng + có request ⇒ 0; cả hai rỗng ⇒ không biết", async () => {
    const withTraffic = make((url) => ({
      status: 200,
      body: url.searchParams.get("query")?.includes("status_code:5")
        ? { status: "ok", series: [] }
        : points(40),
    }));
    expect(await withTraffic.provider.errorCount(flag, 60)).toMatchObject({
      value: 0,
      hasData: true,
    });
    expect(await withTraffic.provider.errorRate(flag, 60)).toMatchObject({
      value: 0,
      hasData: true,
    });
    const silent = make(() => ({
      status: 200,
      body: { status: "ok", series: [] },
    }));
    expect((await silent.provider.errorCount(flag, 60)).hasData).toBe(false);
  });

  it("p99 lấy điểm LỚN nhất của cửa sổ (bi quan), đổi ra mili giây", async () => {
    const { provider } = make(() => ({ status: 200, body: points(0.2, 0.35) }));
    const sample = await provider.latencyP99(flag, 60);
    expect(sample.value).toBeCloseTo(350);
    expect(sample.query).toMatch(/^p99:udp\..*\.rollup\(max, 60\)$/);
  });

  it("probe: khoá sai ⇒ không tới được; truy vấn hỏng ⇒ queryFailed; có lưu lượng ⇒ hasSeries, chu kỳ 60s giả định", async () => {
    const invalid = make(() => ({
      status: 403,
      body: { errors: ["Forbidden"] },
    }));
    expect((await invalid.provider.probe(workload)).data).toMatchObject({
      reachable: false,
      queryFailed: false,
    });

    const failing = make((url) =>
      url.pathname === "/api/v1/validate"
        ? { status: 200, body: { valid: true } }
        : { status: 500, body: {} },
    );
    const failed = await failing.provider.probe(workload);
    expect(failed.status).toBe("FAILED");
    expect(failed.data).toMatchObject({ reachable: true, queryFailed: true });

    const live = make((url) =>
      url.pathname === "/api/v1/validate"
        ? { status: 200, body: { valid: true } }
        : { status: 200, body: points(12) },
    );
    const ok = await live.provider.probe(flag);
    expect(ok.data).toEqual({
      reachable: true,
      hasSeries: true,
      queryFailed: false,
      scrapeIntervalSec: 60,
      scrapeIntervalSource: "assumed",
    });
    // Pha 2 theo flagKey, mọi variant — không theo variant
    expect(live.calls.at(-1)?.url.searchParams.get("query")).toContain(
      "ff:checkout_v2_*",
    );
  });
});

describe("New Relic", () => {
  const rows = (...results: Record<string, unknown>[]) => ({
    data: { actor: { account: { nrql: { results } } } },
  });
  const make = (handler: (url: URL, init?: RequestInit) => Reply) => {
    const f = fakeFetch(handler);
    return {
      ...f,
      provider: new NewRelicMetricsProvider({
        region: "EU",
        accountId: 42,
        apiKey: "NRAK-x",
        fetch: f.fetchImpl,
        timeoutMs: 500,
      }),
    };
  };
  const nrqlOf = (call: Call | undefined): string =>
    (JSON.parse(String(call?.init?.body)) as { variables: { nrql: string } })
      .variables.nrql;

  it("NRQL đi qua biến GraphQL tới đúng vùng; chuỗi người dùng escape", async () => {
    const { provider, calls } = make(() => ({
      status: 200,
      body: rows({ value: 12 }),
    }));
    const sample = await provider.requestCount(
      { ...flag, workloadName: "it's" },
      60,
    );
    expect(sample.value).toBe(12);
    expect(calls[0]?.url.href).toBe("https://api.eu.newrelic.com/graphql");
    expect(calls[0]?.init?.headers).toMatchObject({ "API-Key": "NRAK-x" });
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      variables: { accountId: number; nrql: string };
    };
    expect(body.variables.accountId).toBe(42);
    expect(body.variables.nrql).toBe(
      "SELECT sum(http_server_request_duration_seconds_count) AS value FROM Metric WHERE service_name = 'it\\'s' AND namespace = 'udp-demo-dev' AND ff = 'checkout_v2=on' SINCE 60 seconds ago",
    );
    expect(sample.query).toBe(body.variables.nrql);
  });

  it("null ⇒ hasData false; errors của GraphQL ⇒ hỏng; phân vị là object một số", async () => {
    const empty = make(() => ({ status: 200, body: rows({ value: null }) }));
    expect((await empty.provider.requestCount(flag, 60)).hasData).toBe(false);

    const graphqlError = make(() => ({
      status: 200,
      body: { errors: [{ message: "NRQL Syntax Error" }] },
    }));
    expect((await graphqlError.provider.requestCount(flag, 60)).hasData).toBe(
      false,
    );

    const p99 = make(() => ({
      status: 200,
      body: rows({ value: { "99": 0.25 } }),
    }));
    const sample = await p99.provider.latencyP99(workload, 60);
    expect(sample).toMatchObject({ value: 250, hasData: true });
    expect(nrqlOf(p99.calls[0])).toContain(
      "bucketPercentile(http_server_request_duration_seconds_bucket, 99)",
    );
    expect(nrqlOf(p99.calls[0])).toContain("(ff IS NULL OR ff = '')");
  });

  it("probe: ping qua user; pha 2 lọc theo tiền tố flag", async () => {
    const { provider, calls } = make((_url, init) =>
      String(init?.body).includes("user")
        ? { status: 200, body: { data: { actor: { user: { id: 7 } } } } }
        : { status: 200, body: rows({ value: 5 }) },
    );
    const outcome = await provider.probe(flag);
    expect(outcome.data).toMatchObject({ reachable: true, hasSeries: true });
    expect(nrqlOf(calls.at(-1))).toContain("ff LIKE 'checkout_v2=%'");
  });
});

describe("Dynatrace", () => {
  const series = (
    ...data: { dimensionMap?: Record<string, string>; values: unknown[] }[]
  ) => ({ result: [{ data }] });
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

  it("metric selector đúng dimension, gộp cả cửa sổ, đúng token; chuỗi escape bằng ~", async () => {
    const { provider, calls } = make(() => ({
      status: 200,
      body: series({ values: [9] }),
    }));
    const sample = await provider.errorCount(
      { ...flag, workloadName: 'q"~' },
      120,
    );
    expect(sample).toMatchObject({ value: 9, hasData: true });
    const call = calls[0];
    expect(`${String(call?.url.origin)}${String(call?.url.pathname)}`).toBe(
      "https://abc12345.live.dynatrace.com/api/v2/metrics/query",
    );
    expect(call?.url.searchParams.get("from")).toBe("now-120s");
    expect(call?.url.searchParams.get("resolution")).toBe("Inf");
    expect(call?.url.searchParams.get("metricSelector")).toBe(
      'http_server_request_duration_seconds_count:filter(and(eq("service_name","q~"~~"),eq("k8s.namespace.name","udp-demo-dev"),eq("ff","checkout_v2=on"),prefix("http_response_status_code","5"))):splitBy():sum',
    );
    expect(call?.init?.headers).toEqual({
      Authorization: "Api-Token dt0c01.x",
    });
  });

  it("p99 tính từ bucket bằng thuật toán histogram_quantile", async () => {
    const { provider } = make(() => ({
      status: 200,
      body: series(
        { dimensionMap: { le: "0.1" }, values: [50] },
        { dimensionMap: { le: "0.25" }, values: [90] },
        { dimensionMap: { le: "0.5" }, values: [99] },
        { dimensionMap: { le: "1" }, values: [100] },
        { dimensionMap: { le: "+Inf" }, values: [100] },
      ),
    }));
    const sample = await provider.latencyP99(workload, 60);
    expect(sample.hasData).toBe(true);
    expect(sample.value).toBeCloseTo(500);
    expect(sample.query).toContain(':splitBy("le"):sum');
  });

  it("không dãy nào ⇒ hasData false; thiếu `result` ⇒ probe queryFailed", async () => {
    const empty = make(() => ({
      status: 200,
      body: { result: [{ data: [] }] },
    }));
    expect((await empty.provider.requestCount(flag, 60)).hasData).toBe(false);
    expect((await empty.provider.latencyP99(flag, 60)).hasData).toBe(false);

    const broken = make((url) =>
      url.pathname === "/api/v2/metrics"
        ? { status: 200, body: { metrics: [] } }
        : { status: 200, body: { error: "x" } },
    );
    expect((await broken.provider.probe(workload)).data).toMatchObject({
      reachable: true,
      queryFailed: true,
    });
  });
});

describe("histogramQuantile — cùng định nghĩa với PromQL", () => {
  it("nội suy trong bucket chứa hạng; rơi vào +Inf ⇒ cận trên của bucket hữu hạn cuối", () => {
    const b = [
      { le: 0.1, count: 10 },
      { le: 0.2, count: 20 },
      { le: Infinity, count: 20 },
    ];
    expect(histogramQuantile(0.5, b)).toBeCloseTo(0.1);
    expect(histogramQuantile(0.25, b)).toBeCloseTo(0.05);
    expect(
      histogramQuantile(0.99, [
        { le: 0.1, count: 1 },
        { le: Infinity, count: 100 },
      ]),
    ).toBe(0.1);
  });

  it("không tính được ⇒ undefined, không bao giờ 0: rỗng, tổng 0, thiếu +Inf", () => {
    expect(histogramQuantile(0.99, [])).toBeUndefined();
    expect(
      histogramQuantile(0.99, [{ le: Infinity, count: 0 }]),
    ).toBeUndefined();
    expect(histogramQuantile(0.99, [{ le: 1, count: 5 }])).toBeUndefined();
  });
});

describe("createMetricsProvider", () => {
  it("dựng đúng provider theo loại nguồn; version metrics.query theo ngôn ngữ", () => {
    expect(
      createMetricsProvider({
        kind: "prometheus",
        baseUrl: "http://p:9090",
        inCluster: false,
      }),
    ).toBeInstanceOf(PrometheusMetricsProvider);
    expect(
      createMetricsProvider({
        kind: "datadog",
        site: "datadoghq.com",
        apiKey: "a",
        appKey: "b",
      }).capabilityVersion,
    ).toBe("1.x");
    expect(METRICS_QUERY_MAJOR).toEqual({
      prometheus: 2,
      datadog: 1,
      newrelic: 1,
      dynatrace: 1,
    });
  });
});

describe("PromQL được host (Grafana Cloud/Mimir)", () => {
  it("basic auth trên MỌI lời gọi; sống = truy vấn vector(1), không phải /-/ready", async () => {
    const { fetchImpl, calls } = fakeFetch((url) => ({
      status: 200,
      body: {
        status: "success",
        data: {
          resultType: "vector",
          result: url.searchParams.get("query")?.startsWith("vector")
            ? [{ metric: {}, value: [0, "1"] }]
            : [{ metric: {}, value: [0, "3"] }],
        },
      },
    }));
    const provider = createMetricsProvider(
      {
        kind: "prometheus",
        baseUrl: "https://prometheus-prod-01.grafana.net/api/prom",
        inCluster: false,
        basicAuth: { username: "123456", password: "glc_x" },
      },
      { fetch: fetchImpl, timeoutMs: 500 },
    );
    const outcome = await provider.probe(workload);
    expect(outcome.data).toMatchObject({ reachable: true, hasSeries: true });
    expect(calls.map((c) => c.url.pathname)).not.toContain("/api/prom/-/ready");
    expect(calls[0]?.url.searchParams.get("query")).toBe("vector(1)");
    for (const call of calls) {
      expect(call.init?.headers).toEqual({
        Authorization: `Basic ${Buffer.from("123456:glc_x").toString("base64")}`,
      });
    }
  });
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseDurationSeconds,
  PrometheusMetricsProvider,
} from "../src/prometheus.js";

/**
 * Provider Prometheus trước một server HTTP giả trả đúng hình dạng của
 * Prometheus HTTP API (tài liệu `querying/api`): vector tức thời
 * `{status, data: {resultType: "vector", result: [{metric, value: [ts, "str"]}]}}`,
 * giá trị đặc biệt là CHUỖI ("NaN", "+Inf"), `/api/v1/targets` có
 * `scrapeInterval` dạng Go duration từ 2.30, `/-/ready` cho probe.
 *
 * Điều được kiểm ở đây là ranh giới I7: mọi cách "không biết" đều phải thành
 * `hasData: false`, không bao giờ thành một con số.
 */

type Handler = (url: URL) => { status: number; body: string } | undefined;

let server: Server;
let baseUrl = "";
let handler: Handler = () => undefined;
const seen: string[] = [];

const vector = (values: string[]): string =>
  JSON.stringify({
    status: "success",
    data: {
      resultType: "vector",
      result: values.map((v) => ({ metric: {}, value: [1_700_000_000, v] })),
    },
  });

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    seen.push(url.pathname + url.search);
    const out = handler(url) ?? { status: 404, body: "not found" };
    res.statusCode = out.status;
    res.setHeader("content-type", "application/json");
    res.end(out.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const target = {
  namespace: "ns",
  workloadName: "svc",
  flagKey: "f",
  variantKey: "on",
};
const provider = (): PrometheusMetricsProvider =>
  new PrometheusMetricsProvider({ baseUrl, timeoutMs: 500 });

describe("truy vấn tức thời", () => {
  it("một mẫu có số ⇒ hasData và mang đúng truy vấn đã gửi", async () => {
    handler = (url) =>
      url.pathname === "/api/v1/query"
        ? { status: 200, body: vector(["12"]) }
        : undefined;
    const sample = await provider().errorCount(target, 60);
    expect(sample).toEqual({
      value: 12,
      query: expect.stringContaining(
        'ff="f=on", http_response_status_code=~"5.."',
      ),
      windowSeconds: 60,
      hasData: true,
    });
    expect(seen.at(-1)).toContain(
      `/api/v1/query?query=${encodeURIComponent(sample.query)}`,
    );
  });

  it("latencyP99 đổi giây của Prometheus sang mili-giây của ngưỡng §7.4", async () => {
    handler = () => ({ status: 200, body: vector(["0.25"]) });
    expect((await provider().latencyP99(target, 60)).value).toBeCloseTo(250);
  });

  for (const [label, body] of [
    ["vector rỗng", vector([])],
    ['giá trị "NaN"', vector(["NaN"])],
    ['giá trị "+Inf"', vector(["+Inf"])],
    [
      "resultType không phải vector",
      JSON.stringify({
        status: "success",
        data: { resultType: "matrix", result: [] },
      }),
    ],
    [
      "status error",
      JSON.stringify({ status: "error", errorType: "bad_data", error: "x" }),
    ],
    ["JSON hỏng", "{not json"],
  ] as const) {
    it(`${label} ⇒ hasData=false, KHÔNG phải 0 (I7)`, async () => {
      handler = () => ({ status: 200, body });
      const sample = await provider().requestCount(target, 60);
      expect(sample.hasData).toBe(false);
      expect(sample.query).toContain("increase(");
    });
  }

  it("HTTP 503 ⇒ hasData=false", async () => {
    handler = () => ({ status: 503, body: "down" });
    expect((await provider().requestCount(target, 60)).hasData).toBe(false);
  });

  it("quá hạn chờ ⇒ hasData=false, không treo vòng lặp", async () => {
    handler = () => undefined;
    const slow = new PrometheusMetricsProvider({
      baseUrl,
      timeoutMs: 100,
      fetch: () => new Promise(() => undefined),
    });
    const started = Date.now();
    const sample = await slow.requestCount(target, 60);
    expect(sample.hasData).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("probe", () => {
  const targets = {
    status: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        activeTargets: [
          { health: "up", scrapeInterval: "15s" },
          { health: "up", scrapeInterval: "1m" },
        ],
      },
    }),
  };

  it("pha 2: lưu lượng theo flagKey; scrape interval đo trên chính workload", async () => {
    const queries: string[] = [];
    handler = (url) => {
      if (url.pathname === "/-/ready") return { status: 200, body: "ready" };
      if (url.pathname === "/api/v1/query") {
        const query = url.searchParams.get("query") ?? "";
        queries.push(query);
        return {
          status: 200,
          // 21 mẫu trong 300s = 20 khoảng ⇒ 15s
          body: vector([query.includes("count_over_time") ? "21" : "4"]),
        };
      }
      return url.pathname === "/api/v1/targets" ? targets : undefined;
    };
    const result = await provider().probe(target);
    expect(result.status).toBe("SUCCESS");
    expect(result.data).toEqual({
      reachable: true,
      hasSeries: true,
      queryFailed: false,
      scrapeIntervalSec: 15,
      scrapeIntervalSource: "workload",
    });
    expect(queries[0]).toContain('ff=~"f=.*"');
    expect(queries[0]).toContain("increase(");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("workload chưa đủ mẫu ⇒ scrape interval lấy số lớn nhất của targets, ghi nguồn global", async () => {
    handler = (url) => {
      if (url.pathname === "/-/ready") return { status: 200, body: "ready" };
      if (url.pathname === "/api/v1/query") {
        const query = url.searchParams.get("query") ?? "";
        return {
          status: 200,
          body: vector(query.includes("count_over_time") ? [] : ["1"]),
        };
      }
      return url.pathname === "/api/v1/targets" ? targets : undefined;
    };
    const result = await provider().probe(target);
    expect(result.data).toMatchObject({
      scrapeIntervalSec: 60,
      scrapeIntervalSource: "global",
    });
  });

  it("series trẻ hơn cửa sổ (pod vừa deploy) ⇒ chặn trên bằng số global, không phóng đại", async () => {
    handler = (url) => {
      if (url.pathname === "/-/ready") return { status: 200, body: "ready" };
      if (url.pathname === "/api/v1/query") {
        const query = url.searchParams.get("query") ?? "";
        // 2 mẫu ⇒ 300s nếu tin workload; targets nói lớn nhất là 15s
        return {
          status: 200,
          body: vector([query.includes("count_over_time") ? "2" : "1"]),
        };
      }
      return url.pathname === "/api/v1/targets"
        ? {
            status: 200,
            body: JSON.stringify({
              status: "success",
              data: {
                activeTargets: [{ health: "up", scrapeInterval: "15s" }],
              },
            }),
          }
        : undefined;
    };
    const result = await provider().probe(target);
    expect(result.data).toMatchObject({
      scrapeIntervalSec: 15,
      scrapeIntervalSource: "global",
    });
  });

  it("không tới được ⇒ FAILED, reachable=false", async () => {
    handler = () => undefined;
    const result = await provider().probe(target);
    expect(result.status).toBe("FAILED");
    expect(result.data).toEqual({
      reachable: false,
      hasSeries: false,
      queryFailed: false,
      scrapeIntervalSource: "assumed",
    });
  });

  it("sẵn sàng nhưng không có lưu lượng ⇒ hasSeries=false, không phải lỗi", async () => {
    handler = (url) =>
      url.pathname === "/-/ready"
        ? { status: 200, body: "ready" }
        : url.pathname === "/api/v1/query"
          ? { status: 200, body: vector([]) }
          : undefined;
    const result = await provider().probe(target);
    expect(result.status).toBe("SUCCESS");
    expect(result.data).toMatchObject({
      reachable: true,
      hasSeries: false,
      queryFailed: false,
      scrapeIntervalSource: "assumed",
    });
    expect(result.data?.scrapeIntervalSec).toBeUndefined();
  });

  it("sống nhưng truy vấn hỏng (5xx) ⇒ queryFailed — khác với không có series", async () => {
    handler = (url) =>
      url.pathname === "/-/ready"
        ? { status: 200, body: "ready" }
        : url.pathname === "/api/v1/query"
          ? { status: 503, body: "overloaded" }
          : undefined;
    const result = await provider().probe(target);
    expect(result.status).toBe("FAILED");
    expect(result.data).toMatchObject({
      reachable: true,
      hasSeries: false,
      queryFailed: true,
    });
  });
});

describe("refreshScrapeLag — độ trễ scrape đọc từ /api/v1/targets", () => {
  it("lấy scrape interval lớn nhất của target đang sống; mặc định trước khi đọc", async () => {
    handler = (url) =>
      url.pathname === "/api/v1/targets"
        ? {
            status: 200,
            body: JSON.stringify({
              status: "success",
              data: {
                activeTargets: [
                  { scrapeInterval: "15s", health: "up" },
                  { scrapeInterval: "1m", health: "up" },
                ],
              },
            }),
          }
        : undefined;
    const p = provider();
    expect(p.scrapeLagSeconds).toBe(15);
    expect(await p.refreshScrapeLag()).toBe(60);
    expect(p.scrapeLagSeconds).toBe(60);
  });

  it("không đọc được thì giữ nguyên, không bao giờ về 0", async () => {
    handler = () => undefined;
    const p = provider();
    expect(await p.refreshScrapeLag()).toBe(15);
  });
});

describe("parseDurationSeconds — Go duration của Prometheus", () => {
  it("hiểu ms, s, m, h; không hiểu thì undefined", () => {
    expect(parseDurationSeconds("15s")).toBe(15);
    expect(parseDurationSeconds("1m")).toBe(60);
    expect(parseDurationSeconds("500ms")).toBe(0.5);
    expect(parseDurationSeconds("2h")).toBe(7200);
    expect(parseDurationSeconds("1m30s")).toBeUndefined();
    expect(parseDurationSeconds("abc")).toBeUndefined();
  });
});

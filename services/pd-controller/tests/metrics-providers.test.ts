import { METRICS_PROVIDER } from "@udp/config";
import { describe, expect, it } from "vitest";
import { createMetricsProviders } from "../src/metrics/provider.js";

/**
 * Nhà máy provider của S3: một provider cho mỗi `metric_queries.metricBase`
 * (§7.4 "Override"), scrape lag đọc từ `/api/v1/targets` và chia sẻ cho provider
 * tạo sau, tên metric lạ bị chặn ở nơi ghép PromQL.
 */
const targets = (interval: string) =>
  JSON.stringify({
    status: "success",
    data: { activeTargets: [{ scrapeInterval: interval, health: "up" }] },
  });

const fakePrometheus =
  (interval: string): typeof fetch =>
  (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/targets") {
      return Promise.resolve(new Response(targets(interval), { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

const session = (metricBase?: string) => ({
  id: "s",
  metricQueries: metricBase === undefined ? null : { metricBase },
});

describe("createMetricsProviders", () => {
  it("cùng metricBase dùng chung một provider; khác thì provider riêng với truy vấn theo tên metric của app", async () => {
    const providers = createMetricsProviders({
      prometheusUrl: "http://prom.test",
      refreshMs: 3_600_000,
      fetch: fakePrometheus("15s"),
    });
    try {
      const a = providers.forSession(session());
      const b = providers.forSession(session());
      const legacy = providers.forSession(session("http_requests"));
      expect(a).toBe(b);
      expect(legacy).not.toBe(a);

      const sample = await legacy.requestCount(
        {
          namespace: "ns",
          workloadName: "svc",
          flagKey: "f",
          variantKey: "on",
        },
        60,
      );
      expect(sample.query).toContain("http_requests_count{");
      expect(sample.hasData).toBe(false);
    } finally {
      providers.stop();
    }
  });

  it("scrape lag đọc từ /api/v1/targets và truyền cho provider tạo sau", async () => {
    const providers = createMetricsProviders({
      prometheusUrl: "http://prom.test",
      refreshMs: 3_600_000,
      fetch: fakePrometheus("30s"),
    });
    try {
      await providers.refresh();
      expect(providers.forSession(session()).scrapeLagSeconds).toBe(30);
      expect(providers.forSession(session("custom")).scrapeLagSeconds).toBe(30);
    } finally {
      providers.stop();
    }
  });

  it("không đọc được targets thì giữ mặc định, không rơi về 0", async () => {
    const providers = createMetricsProviders({
      prometheusUrl: "http://prom.test",
      refreshMs: 3_600_000,
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    try {
      await providers.refresh();
      expect(providers.forSession(session()).scrapeLagSeconds).toBe(
        METRICS_PROVIDER.defaultScrapeLagSeconds,
      );
    } finally {
      providers.stop();
    }
  });

  it("metricBase không phải tên metric hợp lệ ⇒ ném tại nơi ghép PromQL", () => {
    const providers = createMetricsProviders({
      prometheusUrl: "http://prom.test",
      refreshMs: 3_600_000,
      fetch: fakePrometheus("15s"),
    });
    try {
      expect(() =>
        providers.forSession(session("x_count{}) or vector(0) #")),
      ).toThrow(/Tên metric không hợp lệ/);
    } finally {
      providers.stop();
    }
  });
});

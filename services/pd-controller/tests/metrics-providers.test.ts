import { INTERNAL_SECRET_HEADER, METRICS_PROVIDER } from "@udp/config";
import { describe, expect, it } from "vitest";
import { createMetricsProviders } from "../src/metrics/provider.js";
import {
  createCoreMetricsClient,
  type CoreMetricsClient,
} from "../src/metrics/remote.js";

/**
 * Nhà máy provider của S3 [v4.11, Plan #39]: một provider mỗi (environment, `metricBase`), mọi
 * phép đo đi qua Service 1 — client giả ở đây ghi lại lời gọi và trả đúng hình dây của S1.
 * Lời gọi hỏng là `hasData: false` / `reachable: false` (I7), không bao giờ 0.
 */

const ENV_A = "00000000-0000-4000-8000-0000000000a1";
const ENV_B = "00000000-0000-4000-8000-0000000000b2";

const session = (environmentId: string, metricBase?: string) => ({
  id: "s",
  environmentId,
  metricQueries: metricBase === undefined ? null : { metricBase },
});

const target = {
  namespace: "ns",
  workloadName: "svc",
  flagKey: "f",
  variantKey: "on",
};

function fakeClient(options: { down?: boolean; lag?: number } = {}) {
  const calls: { environmentId: string; body: unknown }[] = [];
  const client: CoreMetricsClient = {
    measure: (environmentId, body) => {
      calls.push({ environmentId, body });
      if (options.down === true) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve(
        body.op === "probe"
          ? {
              probe: {
                status: "SUCCESS",
                data: {
                  reachable: true,
                  hasSeries: true,
                  queryFailed: false,
                  scrapeIntervalSource: "global",
                },
              },
            }
          : {
              sample: {
                value: 0.01,
                query: `q:${body.op}`,
                windowSeconds: body.windowSec,
                hasData: true,
              },
            },
      );
    },
    source: () =>
      options.down === true
        ? Promise.reject(new Error("ECONNREFUSED"))
        : Promise.resolve({
            source: {
              providerId: "prometheus",
              capabilityVersion: "2.0.0",
              scrapeLagSeconds: options.lag ?? 30,
            },
          }),
  };
  return { client, calls };
}

describe("createMetricsProviders (qua Service 1)", () => {
  it("một provider mỗi (environment, metricBase); phép đo mang đúng environment và metricQueries", async () => {
    const { client, calls } = fakeClient();
    const providers = createMetricsProviders({ client, refreshMs: 3_600_000 });
    try {
      const a = providers.forSession(session(ENV_A));
      expect(providers.forSession(session(ENV_A))).toBe(a);
      const b = providers.forSession(session(ENV_B));
      const legacy = providers.forSession(session(ENV_A, "http_requests"));
      expect(b).not.toBe(a);
      expect(legacy).not.toBe(a);

      const sample = await legacy.requestCount(target, 60);
      expect(sample).toEqual({
        value: 0.01,
        query: "q:requestCount",
        windowSeconds: 60,
        hasData: true,
      });
      await b.errorRate(target, 120);
      expect(calls.map((c) => c.environmentId)).toEqual([ENV_A, ENV_B]);
      expect(calls[0]?.body).toEqual({
        op: "requestCount",
        target,
        windowSec: 60,
        metricQueries: { metricBase: "http_requests" },
      });
    } finally {
      providers.stop();
    }
  });

  it("độ trễ scrape: mặc định THẬN TRỌNG trước khi đọc được nguồn, rồi số của nguồn", async () => {
    const { client } = fakeClient({ lag: 30 });
    const providers = createMetricsProviders({ client, refreshMs: 3_600_000 });
    try {
      const p = providers.forSession(session(ENV_A));
      expect(p.scrapeLagSeconds).toBe(
        Math.max(
          METRICS_PROVIDER.defaultScrapeLagSeconds,
          METRICS_PROVIDER.saasExportIntervalSeconds,
        ),
      );
      await providers.refresh();
      expect(p.scrapeLagSeconds).toBe(30);
      expect(p.providerId).toBe("prometheus");
    } finally {
      providers.stop();
    }
  });

  it("Service 1 không trả lời ⇒ hasData false / reachable false, không bao giờ 0 (I7); độ trễ giữ số đang có", async () => {
    const { client } = fakeClient({ down: true });
    const providers = createMetricsProviders({ client, refreshMs: 3_600_000 });
    try {
      const p = providers.forSession(session(ENV_A));
      const before = p.scrapeLagSeconds;
      await providers.refresh();
      expect(p.scrapeLagSeconds).toBe(before);
      const sample = await p.errorRate(target, 60);
      expect(sample.hasData).toBe(false);
      const probe = await p.probe(target);
      expect(probe.status).toBe("FAILED");
      expect(probe.data?.reachable).toBe(false);
    } finally {
      providers.stop();
    }
  });
});

describe("createCoreMetricsClient", () => {
  it("đúng đường nội bộ của environment, mang bí mật nội bộ; S1 trả khác 2xx ⇒ ném (bên trên đổi thành hasData false)", async () => {
    const seen: {
      url: string;
      method: string;
      secret: string | null;
      body: unknown;
    }[] = [];
    let status = 200;
    const client = createCoreMetricsClient({
      baseUrl: "http://core:3000",
      secret: "s".repeat(32),
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: String(input),
          method: init?.method ?? "GET",
          secret: headers.get(INTERNAL_SECRET_HEADER),
          body:
            init?.body === undefined
              ? undefined
              : JSON.parse(String(init.body)),
        });
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status }),
        );
      },
    });

    const body = { op: "requestCount" as const, target, windowSec: 60 };
    await expect(client.measure(ENV_A, body)).resolves.toEqual({ ok: true });
    await client.source(ENV_B);
    expect(seen).toEqual([
      {
        url: `http://core:3000/internal/environments/${ENV_A}/metrics`,
        method: "POST",
        secret: "s".repeat(32),
        body,
      },
      {
        url: `http://core:3000/internal/environments/${ENV_B}/metrics-source`,
        method: "GET",
        secret: "s".repeat(32),
        body: undefined,
      },
    ]);

    status = 503;
    await expect(client.source(ENV_A)).rejects.toThrow("503");
  });
});

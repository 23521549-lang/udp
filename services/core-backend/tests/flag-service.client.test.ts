import { INTERNAL_SECRET_HEADER } from "@udp/config";
import { describe, expect, it } from "vitest";
import {
  createFlagServiceClient,
  type FlagServiceClient,
} from "../src/core/clients/flag-service.client.js";

/**
 * Client S1 → S2 `track` [v4.4] và [v4.9] ba lời gọi ĐỌC, không database: `fetch`
 * giả trả từng loại response, khẳng định phân loại mà `rollout.service` dựa vào
 * để bù trừ, và hình của lời gọi GET (không thân, không content-type).
 */

const SESSION = "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b";
const FLAG = "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c";
const ENV = "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2d";

interface Call {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
}

function clientReturning(respond: () => Promise<Response>): {
  calls: Call[];
  track: () => ReturnType<FlagServiceClient["track"]>;
  client: FlagServiceClient;
} {
  const calls: Call[] = [];
  const client = createFlagServiceClient({
    baseUrl: "http://s2.test/",
    secret: "s3cret",
    fetch: (url, init) => {
      calls.push({
        url: String(url),
        ...(init?.method === undefined ? {} : { method: init.method }),
        headers: init?.headers as Record<string, string>,
        ...(init?.body === undefined ? {} : { body: init.body }),
      });
      return respond();
    },
  });
  return { calls, track: () => client.track(SESSION), client };
}

const json = (status: number, body: unknown) =>
  Promise.resolve(Response.json(body, { status }));

describe("createFlagServiceClient.track", () => {
  it("gọi đúng route kèm secret; 200 đúng hợp đồng ⇒ SUCCESS", async () => {
    const c = clientReturning(() =>
      json(200, {
        flagKey: "f",
        environmentId: "e",
        tracked: true,
        changed: true,
      }),
    );
    expect(await c.track()).toEqual({ status: "SUCCESS", changed: true });
    expect(c.calls[0]?.url).toBe(
      `http://s2.test/internal/rollouts/${SESSION}/track`,
    );
    expect(c.calls[0]?.headers[INTERNAL_SECRET_HEADER]).toBe("s3cret");
  });

  it("409 TRACKED_FLAG_LIMIT ⇒ LIMIT kèm detail; 409/404 khác ⇒ REJECTED", async () => {
    expect(
      await clientReturning(() =>
        json(409, { code: "TRACKED_FLAG_LIMIT", detail: "đủ 3 flag" }),
      ).track(),
    ).toEqual({ status: "LIMIT", message: "đủ 3 flag" });
    expect(
      await clientReturning(() =>
        json(409, { detail: "rollout đã kết thúc" }),
      ).track(),
    ).toEqual({
      status: "REJECTED",
      httpStatus: 409,
      message: "rollout đã kết thúc",
    });
    expect((await clientReturning(() => json(404, {})).track()).status).toBe(
      "REJECTED",
    );
  });

  it("5xx, mạng hỏng, body sai hợp đồng ⇒ UNAVAILABLE (thử lại có ích)", async () => {
    expect((await clientReturning(() => json(503, {})).track()).status).toBe(
      "UNAVAILABLE",
    );
    expect(
      await clientReturning(() =>
        Promise.reject(new Error("ECONNREFUSED")),
      ).track(),
    ).toEqual({ status: "UNAVAILABLE", message: "ECONNREFUSED" });
    expect(
      (
        await clientReturning(() =>
          Promise.resolve(new Response("not json")),
        ).track()
      ).status,
    ).toBe("UNAVAILABLE");
  });
});

// ------------------------------------------------------------- [v4.9] đường đọc

const STATS_BODY = {
  window: {
    from: "2026-09-14T00:00:00Z",
    to: "2026-09-20T12:00:00Z",
    granularity: "day",
    tz: "UTC",
  },
  totals: { evalCount: 3, lastEvaluatedAt: "2026-09-20T11:00:00Z" },
  byEnv: [
    {
      environmentId: ENV,
      evalCount: 3,
      lastEvaluatedAt: "2026-09-20T11:00:00Z",
      variants: [{ variantKey: "on", count: 3, share: 1, known: true }],
      series: [{ at: "2026-09-20", count: 3 }],
    },
  ],
  archive: { allowed: true, evalCount7d: 3, lastEvaluatedAt: null },
  clientTrafficUnobserved: false,
  telemetryGaps: [],
};

const STALE_BODY = {
  telemetry: { firstReportAt: null, observedDays: 0 },
  telemetryGaps: [],
  counts: { UNUSED: 0, SETTLED: 0, STALE_DRAFT: 0 },
  total: 0,
  items: [],
};

describe("createFlagServiceClient — ba lời gọi ĐỌC", () => {
  it("flagStats: GET đúng url + query, KHÔNG thân và KHÔNG content-type", async () => {
    const c = clientReturning(() => json(200, STATS_BODY));
    const stats = await c.client.flagStats(FLAG, {
      days: 7,
      granularity: "day",
      tz: "UTC",
      environmentId: ENV,
    });

    expect(stats.totals.evalCount).toBe(3);
    const call = c.calls[0];
    expect(call?.method).toBe("GET");
    expect(call?.url).toBe(
      `http://s2.test/internal/flags/${FLAG}/stats?environmentId=${ENV}&days=7&granularity=day&tz=UTC`,
    );
    expect(call?.body).toBeUndefined();
    // Một GET khai content-type là nói sai với mọi proxy trên đường
    expect(call?.headers["content-type"]).toBeUndefined();
    expect(call?.headers[INTERNAL_SECRET_HEADER]).toBe("s3cret");
  });

  it("flagStats: environmentId vắng thì không có trong query", async () => {
    const c = clientReturning(() => json(200, STATS_BODY));
    await c.client.flagStats(FLAG, { days: 30, granularity: "day", tz: "UTC" });
    expect(c.calls[0]?.url).toBe(
      `http://s2.test/internal/flags/${FLAG}/stats?days=30&granularity=day&tz=UTC`,
    );
  });

  it("staleFlags và flagStatsSummary: url mang đúng tham số, flagIds là CSV", async () => {
    const stale = clientReturning(() => json(200, STALE_BODY));
    await stale.client.staleFlags({
      projectId: ENV,
      category: "UNUSED",
      limit: 50,
      offset: 0,
    });
    expect(stale.calls[0]?.url).toBe(
      `http://s2.test/internal/stale-flags?projectId=${ENV}&category=UNUSED&limit=50&offset=0`,
    );

    const summary = clientReturning(() =>
      json(200, {
        items: [
          {
            flagId: FLAG,
            evalCount7d: 0,
            daily14: Array.from({ length: 14 }, () => 0),
          },
        ],
      }),
    );
    const got = await summary.client.flagStatsSummary({
      environmentId: ENV,
      flagIds: [FLAG, SESSION],
      tz: "Asia/Ho_Chi_Minh",
    });
    expect(got.items[0]?.daily14).toHaveLength(14);
    expect(summary.calls[0]?.url).toBe(
      `http://s2.test/internal/flag-stats/summary?environmentId=${ENV}&flagIds=${FLAG}%2C${SESSION}&tz=Asia%2FHo_Chi_Minh`,
    );
  });

  it("response sai hình ⇒ ném lỗi hợp đồng (500), không trôi tới Portal", async () => {
    const c = clientReturning(() =>
      json(200, { ...STATS_BODY, totals: { evalCount: "ba" } }),
    );
    await expect(
      c.client.flagStats(FLAG, { days: 7, granularity: "day", tz: "UTC" }),
    ).rejects.toThrow(/sai hình/);
  });

  it("404 của S2 trên đường đọc vẫn chuyển tiếp nguyên mã tới Portal", async () => {
    const c = clientReturning(() =>
      json(404, { title: "Not found", detail: "Không tìm thấy flag" }),
    );
    await expect(
      c.client.flagStats(FLAG, { days: 7, granularity: "day", tz: "UTC" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("5xx trên đường đọc ⇒ 503 để Portal thử lại", async () => {
    const c = clientReturning(() => json(500, {}));
    await expect(
      c.client.staleFlags({ projectId: ENV, limit: 50, offset: 0 }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

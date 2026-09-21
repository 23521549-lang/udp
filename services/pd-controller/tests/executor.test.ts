import { ROLLOUT_RETRY, TOTAL_BUCKETS } from "@udp/config";
import { describe, expect, it } from "vitest";
import {
  applyWithRetry,
  createFlagLevelExecutor,
  weightsFor,
  type ApplyOutcome,
} from "../src/executors/flag-level.executor.js";
import { Fence } from "../src/reconciler/fence.js";

const on = "00000000-0000-4000-8000-000000000001";
const off = "00000000-0000-4000-8000-000000000002";
const SESSION = "11111111-1111-4111-8111-111111111111";
const current = [
  { variantId: on, weight: 10_000 },
  { variantId: off, weight: 90_000 },
];

describe("weightsFor — hai nhánh, tổng luôn TOTAL_BUCKETS", () => {
  it("variant mục tiêu = round(percent × 1000), phần bù cho variant kia", () => {
    for (const p of [0, 0.1, 10, 33.33, 50, 99.99, 100]) {
      const w = weightsFor(p, current, on);
      const target = w.find((x) => x.variantId === on)?.weight;
      expect(target).toBe(Math.round((p * TOTAL_BUCKETS) / 100));
      expect(w.reduce((s, x) => s + x.weight, 0)).toBe(TOTAL_BUCKETS);
    }
  });

  it("giữ nguyên thứ tự variant của rule (thứ tự cộng dồn của pickVariant)", () => {
    expect(weightsFor(20, current, on).map((w) => w.variantId)).toEqual([
      on,
      off,
    ]);
  });

  it("từ chối rule khác hai variant và phần trăm ngoài khoảng", () => {
    expect(() =>
      weightsFor(10, [...current, { variantId: "x", weight: 0 }], on),
    ).toThrow(/hai variant/);
    expect(() => weightsFor(101, current, on)).toThrow(/ngoài khoảng/);
  });

  it("variant mục tiêu không có trong rule ⇒ ném, không ra rule 100% cho variant kia", () => {
    expect(() => weightsFor(10, current, "khac")).toThrow(/không có trong/);
  });
});

describe("createFlagLevelExecutor — hợp đồng PATCH của Service 2", () => {
  interface Received {
    url: string;
    init: RequestInit;
  }

  /** Executor trước một S2 giả trả `status`/`body`; trả cả request đã gửi lẫn kết cục */
  const call = async (
    status: number,
    body: string,
    fence = new Fence(SESSION, 7, "w"),
  ): Promise<{ received: Received[]; outcome: ApplyOutcome }> => {
    const received: Received[] = [];
    const executor = createFlagLevelExecutor({
      baseUrl: "http://s2.test/",
      secret: "s3cret",
      fetch: (url, init) => {
        received.push({ url: String(url), init: init ?? {} });
        return Promise.resolve(new Response(body, { status }));
      },
    });
    const outcome = await executor.applyTraffic(
      fence,
      { ruleId: "r1", weights: current },
      "why",
    );
    return { received, outcome };
  };

  it("gửi If-Match có ngoặc kép, secret và reason bắt buộc", async () => {
    const { received, outcome } = await call(200, "{}");
    const [req] = received;
    expect(req?.url).toBe("http://s2.test/internal/rules/r1");
    expect(req?.init.method).toBe("PATCH");
    const headers = req?.init.headers as Record<string, string>;
    expect(headers["if-match"]).toBe(`"${SESSION}:7"`);
    expect(headers["x-internal-secret"]).toBe("s3cret");
    expect(JSON.parse(String(req?.init.body))).toEqual({
      weights: current,
      reason: "why",
    });
    expect(outcome).toEqual({ status: "SUCCESS" });
  });

  it("412 ⇒ PRECONDITION_FAILED (I23), 4xx khác ⇒ REJECTED, 5xx ⇒ FAILED, mạng ⇒ FAILED", async () => {
    expect((await call(412, "stale")).outcome.status).toBe(
      "PRECONDITION_FAILED",
    );
    expect((await call(422, "bad")).outcome).toEqual({
      status: "REJECTED",
      message: "HTTP 422: bad",
    });
    expect((await call(404, "gone")).outcome.status).toBe("REJECTED");
    expect((await call(503, "down")).outcome.status).toBe("FAILED");
    const executor = createFlagLevelExecutor({
      baseUrl: "http://s2.test",
      secret: "s",
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    const outcome = await executor.applyTraffic(
      new Fence(SESSION, 7, "w"),
      { ruleId: "r", weights: current },
      "x",
    );
    expect(outcome).toEqual({ status: "FAILED", message: "ECONNREFUSED" });
  });

  it("fence đã đóng ⇒ ném TRƯỚC khi chạm mạng", async () => {
    const closed = new Fence(SESSION, 1, "w");
    closed.abort("lease lost");
    let calls = 0;
    const executor = createFlagLevelExecutor({
      baseUrl: "http://s2.test",
      secret: "s",
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response("{}"));
      },
    });
    await expect(
      executor.applyTraffic(closed, { ruleId: "r", weights: current }, "x"),
    ).rejects.toThrow(/Fence đã đóng/);
    expect(calls).toBe(0);
  });
});

describe("createFlagLevelExecutor — untrack theo config", () => {
  const untrackWith = (respond: () => Promise<Response>) => {
    const urls: string[] = [];
    const executor = createFlagLevelExecutor({
      baseUrl: "http://s2.test",
      secret: "s3cret",
      fetch: (url) => {
        urls.push(String(url));
        return respond();
      },
    });
    return { urls, untrack: () => executor.untrack("cfg-1") };
  };

  it("POST /internal/flag-envs/:id/untrack, đọc `changed` từ body", async () => {
    const { urls, untrack } = untrackWith(() =>
      Promise.resolve(Response.json({ changed: true, tracked: false })),
    );
    expect(await untrack()).toEqual({ status: "SUCCESS", changed: true });
    expect(urls).toEqual(["http://s2.test/internal/flag-envs/cfg-1/untrack"]);
    const notFound = untrackWith(() =>
      Promise.resolve(
        Response.json({ tracked: false, changed: false, skipped: "not-found" }),
      ),
    );
    expect(await notFound.untrack()).toEqual({
      status: "SUCCESS",
      changed: false,
    });
  });

  it("404 là lỗi thật (S2 trả 200 not-found khi config không còn) ⇒ FAILED; body sai hợp đồng ⇒ FAILED, không ném", async () => {
    const missing = untrackWith(() =>
      Promise.resolve(new Response("no route", { status: 404 })),
    );
    expect(await missing.untrack()).toEqual({
      status: "FAILED",
      message: "HTTP 404: no route",
    });
    const garbled = untrackWith(() =>
      Promise.resolve(new Response("not json", { status: 200 })),
    );
    expect((await garbled.untrack()).status).toBe("FAILED");
    const offline = untrackWith(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    expect(await offline.untrack()).toEqual({
      status: "FAILED",
      message: "ECONNREFUSED",
    });
  });
});

describe("applyWithRetry — §7.6 retry với backoff tới hạn", () => {
  /** Đồng hồ và nhật ký ngủ riêng cho từng test — không có state dùng chung giữa các `it` */
  const harness = () => {
    const state = { t: 0, sleeps: [] as number[] };
    return {
      state,
      fence: new Fence(SESSION, 1, "w"),
      now: () => state.t,
      sleep: (ms: number): Promise<void> => {
        state.sleeps.push(ms);
        state.t += ms;
        return Promise.resolve();
      },
    };
  };

  it("thử lại khi FAILED, lùi luỹ thừa, dừng khi thành công", async () => {
    const h = harness();
    const outcomes: ApplyOutcome[] = [
      { status: "FAILED", message: "1" },
      { status: "FAILED", message: "2" },
      { status: "SUCCESS" },
    ];
    const result = await applyWithRetry(
      () => Promise.resolve(outcomes.shift() ?? { status: "SUCCESS" }),
      { deadline: 120_000, now: h.now, sleep: h.sleep, fence: h.fence },
    );
    expect(result.status).toBe("SUCCESS");
    expect(h.state.sleeps).toEqual([
      ROLLOUT_RETRY.initialBackoffMs,
      ROLLOUT_RETRY.initialBackoffMs * 2,
    ]);
  });

  it("hết hạn ⇒ trả FAILED cuối cùng; 412 ⇒ dừng ngay không thử lại", async () => {
    const h = harness();
    const failed = await applyWithRetry(
      () => Promise.resolve({ status: "FAILED", message: "down" }),
      { deadline: 5_000, now: h.now, sleep: h.sleep, fence: h.fence },
    );
    expect(failed.status).toBe("FAILED");
    expect(h.state.t).toBeGreaterThanOrEqual(5_000);

    let calls = 0;
    const stale = await applyWithRetry(
      () => {
        calls += 1;
        return Promise.resolve({
          status: "PRECONDITION_FAILED",
          message: "old",
        });
      },
      { deadline: 60_000, now: () => 0, sleep: h.sleep, fence: h.fence },
    );
    expect(stale.status).toBe("PRECONDITION_FAILED");
    expect(calls).toBe(1);

    calls = 0;
    const rejected = await applyWithRetry(
      () => {
        calls += 1;
        return Promise.resolve({ status: "REJECTED", message: "422" });
      },
      { deadline: 60_000, now: () => 0, sleep: h.sleep, fence: h.fence },
    );
    expect(rejected.status).toBe("REJECTED");
    expect(calls).toBe(1);
  });

  it("mất lease giữa chừng ⇒ ném, không gọi thêm", async () => {
    const h = harness();
    let calls = 0;
    await expect(
      applyWithRetry(
        () => {
          calls += 1;
          h.fence.abort("lease lost");
          return Promise.resolve({ status: "FAILED", message: "x" });
        },
        { deadline: 60_000, now: () => 0, sleep: h.sleep, fence: h.fence },
      ),
    ).rejects.toThrow(/Fence đã đóng/);
    expect(calls).toBe(1);
  });
});

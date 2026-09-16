import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Fence } from "../src/reconciler/fence.js";
import { keepLease } from "../src/reconciler/lease.js";

/**
 * `keepLease` với timer giả: hai nghĩa của "gia hạn không thành" (renew trả
 * `false` ⇒ mất ngay; renew NÉM ⇒ thử lại sớm, chỉ mất khi quá thời gian sống
 * của lease) — xem chú thích đầu `lease.ts`.
 */
const RENEW = 20_000;
const LEASE = 60_000;
const RETRY = 2_000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const fence = () => new Fence("11111111-1111-4111-8111-111111111111", 1, "w");

describe("keepLease", () => {
  it("gia hạn theo chu kỳ; renew trả false ⇒ fence đóng ngay", async () => {
    const f = fence();
    const results = [true, true, false];
    const renew = vi.fn(() => Promise.resolve(results.shift() ?? false));
    const lost: string[] = [];
    const keeper = keepLease(f, {
      renewIntervalMs: RENEW,
      leaseMs: LEASE,
      renew,
      onLost: (r) => lost.push(r),
    });

    await vi.advanceTimersByTimeAsync(RENEW * 2);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(f.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(RENEW);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(f.aborted).toBe(true);
    expect(lost).toEqual(["lease lost: renew trả 0 hàng"]);

    // Đã đóng thì không gia hạn nữa
    await vi.advanceTimersByTimeAsync(RENEW * 3);
    expect(renew).toHaveBeenCalledTimes(3);
    keeper.stop();
  });

  it("renew ném ⇒ thử lại sau errorRetryMs, KHÔNG đóng fence khi lease còn sống", async () => {
    const f = fence();
    const results = [
      () => Promise.reject(new Error("pool timeout")),
      () => Promise.reject(new Error("pool timeout")),
      () => Promise.resolve(true),
    ];
    const renew = vi.fn(() =>
      (results.shift() ?? (() => Promise.resolve(true)))(),
    );
    const errors: string[] = [];
    const keeper = keepLease(f, {
      renewIntervalMs: RENEW,
      leaseMs: LEASE,
      errorRetryMs: RETRY,
      renew,
      onRenewError: (m) => errors.push(m),
    });

    await vi.advanceTimersByTimeAsync(RENEW); // lần 1 ném
    await vi.advanceTimersByTimeAsync(RETRY); // lần 2 ném
    await vi.advanceTimersByTimeAsync(RETRY); // lần 3 thành công
    expect(renew).toHaveBeenCalledTimes(3);
    expect(errors).toEqual(["pool timeout", "pool timeout"]);
    expect(f.aborted).toBe(false);

    // Sau lần thành công, chu kỳ trở lại bình thường
    await vi.advanceTimersByTimeAsync(RENEW);
    expect(renew).toHaveBeenCalledTimes(4);
    keeper.stop();
  });

  it("renew ném liên tục quá thời gian sống của lease ⇒ đóng fence", async () => {
    const f = fence();
    const renew = vi.fn(() => Promise.reject(new Error("db down")));
    const lost: string[] = [];
    keepLease(f, {
      renewIntervalMs: RENEW,
      leaseMs: LEASE,
      errorRetryMs: RETRY,
      renew,
      onLost: (r) => lost.push(r),
    });

    await vi.advanceTimersByTimeAsync(LEASE - 1);
    expect(f.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(RETRY + 1);
    expect(f.aborted).toBe(true);
    expect(lost[0]).toMatch(/quá thời gian sống của lease — db down/);
  });

  it("stop() ngăn mọi lần gia hạn sau đó", async () => {
    const f = fence();
    const renew = vi.fn(() => Promise.resolve(true));
    const keeper = keepLease(f, {
      renewIntervalMs: RENEW,
      leaseMs: LEASE,
      renew,
    });
    keeper.stop();
    await vi.advanceTimersByTimeAsync(RENEW * 5);
    expect(renew).not.toHaveBeenCalled();
    expect(f.aborted).toBe(false);
  });
});

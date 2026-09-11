import { afterEach, describe, expect, it, vi } from "vitest";
import { createPruneJob } from "../src/changefeed/prune.job.js";

/**
 * Nhịp và lô của job dọn `ConfigChangeLog` — không chạm database. Hàm SQL được
 * kiểm riêng ở `packages/db/tests/invariants/outbox-prune.test.ts`; ở đây chỉ còn
 * câu hỏi: job gọi nó bao nhiêu lần, khi nào dừng, và có sống sót khi nó hỏng.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("prune.job — một lượt", () => {
  it("lặp khi lô đầy, dừng ở lô thiếu", async () => {
    const counts = [3, 3, 1];
    const calls: number[] = [];
    const job = createPruneJob({
      prune: (n) => {
        calls.push(n);
        return Promise.resolve(counts.shift() ?? 0);
      },
      batchSize: 3,
      maxBatchesPerRun: 10,
    });

    expect(await job.runOnce()).toBe(7);
    expect(calls).toEqual([3, 3, 3]);
  });

  it("chạm trần số lô thì dừng, dù lô vẫn đầy — một lượt không chạy vô hạn", async () => {
    const prune = vi.fn(() => Promise.resolve(5));
    const job = createPruneJob({ prune, batchSize: 5, maxBatchesPerRun: 4 });

    expect(await job.runOnce()).toBe(20);
    expect(prune).toHaveBeenCalledTimes(4);
  });

  it("hàm SQL hỏng thì lượt đó trả về, KHÔNG ném — lượt sau vẫn chạy", async () => {
    let fail = true;
    const job = createPruneJob({
      prune: () =>
        fail ? Promise.reject(new Error("database chớp")) : Promise.resolve(0),
      batchSize: 5,
    });

    await expect(job.runOnce()).resolves.toBe(0);
    fail = false;
    await expect(job.runOnce()).resolves.toBe(0);
  });

  it("không chồng lượt: gọi lại khi đang chạy nhận đúng lượt đang bay", async () => {
    let finish: (n: number) => void = () => undefined;
    const prune = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const job = createPruneJob({ prune, batchSize: 10 });

    const a = job.runOnce();
    const b = job.runOnce();
    expect(b).toBe(a);
    finish(0);
    await a;
    expect(prune).toHaveBeenCalledTimes(1);
  });
});

describe("prune.job — lịch", () => {
  it("lần đầu trễ ngẫu nhiên trong một chu kỳ, sau đó đều đặn; stop thì thôi", async () => {
    vi.useFakeTimers();
    const prune = vi.fn(() => Promise.resolve(0));
    const job = createPruneJob({
      prune,
      intervalMs: 1_000,
      batchSize: 10,
      random: () => 0.5,
    });

    job.start();
    await vi.advanceTimersByTimeAsync(499);
    expect(prune).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(prune).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(prune).toHaveBeenCalledTimes(2);

    job.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it("start hai lần không nhân đôi lịch", async () => {
    vi.useFakeTimers();
    const prune = vi.fn(() => Promise.resolve(0));
    const job = createPruneJob({ prune, intervalMs: 1_000, random: () => 0 });

    job.start();
    job.start();
    await vi.advanceTimersByTimeAsync(3_000);
    // lần đầu ở 0ms, rồi 1000, 2000, 3000
    expect(prune).toHaveBeenCalledTimes(4);
    job.stop();
  });
});

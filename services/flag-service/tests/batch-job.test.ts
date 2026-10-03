import { afterEach, describe, expect, it, vi } from "vitest";
import { createBatchJob } from "../src/core/batch-job.js";

/**
 * [v4.9] Đồng hồ định kỳ dùng chung của mọi việc nền theo lô — không chạm
 * database.
 *
 * `prune.job.test.ts` đã canh HÀNH VI của job dọn outbox qua chính API cũ của
 * nó; file này canh phần LÕI mà job dọn, job gộp stats và flusher cùng dựa vào:
 * điều kiện dừng do `step` quyết, trần số bước mỗi lượt, không chồng lượt, và
 * "một bước ném thì lượt đó vẫn trả về".
 */

const job = (
  step: () => Promise<{ processed: number; more: boolean }>,
  options: {
    intervalMs?: number;
    maxStepsPerRun?: number;
    random?: () => number;
  } = {},
) =>
  createBatchJob({
    label: "test",
    step,
    intervalMs: options.intervalMs ?? 1_000,
    maxStepsPerRun: options.maxStepsPerRun ?? 10,
    random: options.random ?? (() => 0),
    messages: { done: "xong", failed: "hỏng" },
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("batch-job — một lượt", () => {
  it("lặp khi step còn việc, dừng ngay khi step nói hết", async () => {
    const results = [
      { processed: 3, more: true },
      { processed: 2, more: true },
      { processed: 1, more: false },
    ];
    const step = vi.fn(() =>
      Promise.resolve(results.shift() ?? { processed: 0, more: false }),
    );

    expect(await job(step).runOnce()).toBe(6);
    expect(step).toHaveBeenCalledTimes(3);
  });

  it("chạm trần số bước thì dừng dù còn việc — một lượt không chạy vô hạn", async () => {
    const step = vi.fn(() => Promise.resolve({ processed: 5, more: true }));

    expect(await job(step, { maxStepsPerRun: 4 }).runOnce()).toBe(20);
    expect(step).toHaveBeenCalledTimes(4);
  });

  it("step ném thì lượt đó trả về phần đã xử lý, KHÔNG ném — lượt sau vẫn chạy", async () => {
    let fail = false;
    const step = vi.fn(() => {
      if (fail) return Promise.reject(new Error("database chớp"));
      fail = true;
      return Promise.resolve({ processed: 4, more: true });
    });
    const running = job(step);

    await expect(running.runOnce()).resolves.toBe(4);
    fail = false;
    await expect(running.runOnce()).resolves.toBe(4);
  });

  it("không chồng lượt: gọi lại khi đang chạy nhận đúng lượt đang bay", async () => {
    let finish: (r: { processed: number; more: boolean }) => void = () =>
      undefined;
    const step = vi.fn(
      () =>
        new Promise<{ processed: number; more: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const running = job(step);

    const a = running.runOnce();
    const b = running.runOnce();
    expect(b).toBe(a);
    finish({ processed: 0, more: false });
    await a;
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("sau khi lượt trước xong, runOnce mở lượt MỚI", async () => {
    const step = vi.fn(() => Promise.resolve({ processed: 1, more: false }));
    const running = job(step);

    await running.runOnce();
    await running.runOnce();
    expect(step).toHaveBeenCalledTimes(2);
  });
});

describe("batch-job — lịch", () => {
  it("lần đầu trễ ngẫu nhiên trong một chu kỳ, sau đó đều đặn; stop thì thôi", async () => {
    vi.useFakeTimers();
    const step = vi.fn(() => Promise.resolve({ processed: 0, more: false }));
    const running = job(step, { intervalMs: 1_000, random: () => 0.5 });

    running.start();
    await vi.advanceTimersByTimeAsync(499);
    expect(step).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(step).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(step).toHaveBeenCalledTimes(2);

    running.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(step).toHaveBeenCalledTimes(2);
  });

  it("start hai lần không nhân đôi lịch", async () => {
    vi.useFakeTimers();
    const step = vi.fn(() => Promise.resolve({ processed: 0, more: false }));
    const running = job(step, { intervalMs: 1_000 });

    running.start();
    running.start();
    await vi.advanceTimersByTimeAsync(3_000);
    // lần đầu ở 0ms, rồi 1000, 2000, 3000
    expect(step).toHaveBeenCalledTimes(4);
    running.stop();
  });
});

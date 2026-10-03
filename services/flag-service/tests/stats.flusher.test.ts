import { afterEach, describe, expect, it, vi } from "vitest";
import { createStatsAggregator } from "../src/modules/stats/stats.aggregator.js";
import { createStatsFlusher } from "../src/modules/stats/stats.flusher.js";
import type { StatsRow } from "../src/modules/stats/stats.aggregator.js";

/**
 * [v4.9] Lượt đẩy số đếm xuống database — `upsertBatch` tiêm vào, không chạm
 * database (SQL thật được kiểm ở `evalstat-upsert.integration.test.ts`).
 *
 * Câu hỏi trọng tâm là câu duy nhất có thể làm MẤT số đếm: một lô ghi hỏng, hoặc
 * một `record` xảy ra đúng lúc một lượt flush đang bay.
 */

const aggregatorOf = () =>
  createStatsAggregator({
    now: () => Date.parse("2026-09-22T10:00:00Z"),
    maxPendingEntries: 10_000,
    maxPendingEntriesPerEnvironment: 10_000,
  });

const total = (batches: readonly StatsRow[][]): number =>
  batches.flat().reduce((sum, row) => sum + row.count, 0);

afterEach(() => {
  vi.useRealTimers();
});

describe("stats.flusher", () => {
  it("bộ gộp rỗng ⇒ không gọi upsert, không tốn round trip", async () => {
    const upsertBatch = vi.fn(() => Promise.resolve());
    const flusher = createStatsFlusher({
      aggregator: aggregatorOf(),
      upsertBatch,
      intervalMs: 1_000,
    });

    expect(await flusher.runOnce()).toBe(0);
    expect(upsertBatch).not.toHaveBeenCalled();
  });

  it("chia lô theo batchRows, tổng giữ nguyên", async () => {
    const aggregator = aggregatorOf();
    for (let i = 0; i < 25; i += 1) {
      aggregator.record("env-1", `flag-${String(i)}`, "on", 2);
    }
    const batches: StatsRow[][] = [];
    const flusher = createStatsFlusher({
      aggregator,
      upsertBatch: (rows) => {
        batches.push([...rows]);
        return Promise.resolve();
      },
      intervalMs: 1_000,
      batchRows: 10,
    });

    expect(await flusher.runOnce()).toBe(25);
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
    expect(total(batches)).toBe(50);
  });

  it("lô thứ hai hỏng: phần đã ghi KHÔNG lặp lại, phần còn lại quay về bộ gộp", async () => {
    const aggregator = aggregatorOf();
    for (let i = 0; i < 6; i += 1) {
      aggregator.record("env-1", `flag-${String(i)}`, "on", 1);
    }
    const batches: StatsRow[][] = [];
    let fail = true;
    const flusher = createStatsFlusher({
      aggregator,
      upsertBatch: (rows) => {
        if (fail && batches.length === 1) {
          return Promise.reject(new Error("database chớp"));
        }
        batches.push([...rows]);
        return Promise.resolve();
      },
      intervalMs: 1_000,
      batchRows: 2,
    });

    // Lượt 1: lô đầu ghi xong, lô hai ném ⇒ lượt trả về mà không ném
    expect(await flusher.runOnce()).toBe(0);
    expect(total(batches)).toBe(2);

    fail = false;
    expect(await flusher.runOnce()).toBe(4);
    expect(total(batches)).toBe(6);
  });

  it("flushNow: record trong lúc một lượt đang bay vẫn được ghi đủ (C-10)", async () => {
    const aggregator = aggregatorOf();
    aggregator.record("env-1", "a", "on", 1);

    let release: (() => void) | undefined;
    const batches: StatsRow[][] = [];
    const flusher = createStatsFlusher({
      aggregator,
      upsertBatch: async (rows) => {
        batches.push([...rows]);
        if (batches.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      intervalMs: 1_000,
    });

    // Lượt đang bay đã `drain` mục "a" và đang chờ database
    const inflight = flusher.runOnce();
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    aggregator.record("env-1", "b", "on", 5);

    const flushed = flusher.flushNow({ timeoutMs: 1_000 });
    release?.();
    await Promise.all([inflight, flushed]);

    expect(total(batches)).toBe(6);
    expect(aggregator.size()).toBe(0);
  });

  it("flushNow trả về khi hết hạn, không treo lời gọi tắt máy", async () => {
    const aggregator = aggregatorOf();
    aggregator.record("env-1", "a", "on", 1);
    let release: (() => void) | undefined;
    const flusher = createStatsFlusher({
      aggregator,
      upsertBatch: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      intervalMs: 1_000,
    });

    await expect(flusher.flushNow({ timeoutMs: 20 })).resolves.toBeUndefined();
    release?.();
  });

  it("chạy theo chu kỳ sau start, dừng sau stop", async () => {
    vi.useFakeTimers();
    const aggregator = aggregatorOf();
    const upsertBatch = vi.fn(() => Promise.resolve());
    const flusher = createStatsFlusher({
      aggregator,
      upsertBatch,
      intervalMs: 1_000,
      random: () => 0,
    });

    flusher.start();
    aggregator.record("env-1", "a", "on", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(upsertBatch).toHaveBeenCalledTimes(1);

    flusher.stop();
    aggregator.record("env-1", "a", "on", 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(upsertBatch).toHaveBeenCalledTimes(1);
  });

  it("onFlushed báo số hàng và thời gian cho /metrics", async () => {
    const aggregator = aggregatorOf();
    aggregator.record("env-1", "a", "on", 1);
    aggregator.record("env-1", "b", "on", 1);
    const seen: [number, number][] = [];
    let clock = 1_000;

    const flusher = createStatsFlusher({
      aggregator,
      upsertBatch: () => {
        clock += 250;
        return Promise.resolve();
      },
      intervalMs: 1_000,
      now: () => clock,
      onFlushed: (rows, seconds) => seen.push([rows, seconds]),
    });

    await flusher.runOnce();
    expect(seen).toEqual([[2, 0.25]]);
  });
});

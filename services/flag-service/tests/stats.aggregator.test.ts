import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hourFloor } from "@udp/shared-types/flag-stats";
import {
  createStatsAggregator,
  type StatsDropReason,
  type StatsRow,
} from "../src/modules/stats/stats.aggregator.js";

/**
 * [v4.9] Bộ gộp số đếm đánh giá — thuần, không database, đồng hồ tiêm vào
 * (Tester 2.1).
 *
 * Bốn nhóm câu hỏi, và nhóm cuối là nhóm đáng giá nhất: bảo toàn số đếm
 * (INV-23.5). Đếm THIẾU làm flag bị xếp UNUSED rồi archive lọt chốt 7 ngày, nên
 * "mất mà không ai biết" là kết cục phải loại trừ bằng property test, không phải
 * bằng vài ca mẫu.
 */

const build = (options: {
  now?: () => number;
  maxPendingEntries?: number;
  maxPendingEntriesPerEnvironment?: number;
  onDrop?: (reason: StatsDropReason, count: number) => void;
}) =>
  createStatsAggregator({
    maxPendingEntries: options.maxPendingEntries ?? 1_000,
    maxPendingEntriesPerEnvironment:
      options.maxPendingEntriesPerEnvironment ?? 1_000,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onDrop === undefined ? {} : { onDrop: options.onDrop }),
  });

const at =
  (iso: string): (() => number) =>
  () =>
    Date.parse(iso);

describe("stats.aggregator — gộp và bucket", () => {
  it("hai lượt cùng (env, flag, variant, giờ) ⇒ MỘT hàng, count cộng dồn", () => {
    const aggregator = build({ now: at("2026-09-22T10:00:00Z") });
    aggregator.record("env-1", "checkout", "on", 3);
    aggregator.record("env-1", "checkout", "on", 4);

    expect(aggregator.size()).toBe(1);
    expect(aggregator.drain()).toEqual([
      {
        environmentId: "env-1",
        flagKey: "checkout",
        variant: "on",
        count: 7,
        bucketHour: Date.parse("2026-09-22T10:00:00Z"),
      },
    ]);
  });

  it("bucket theo UTC: máy chạy ở +07:00 không làm lệch", () => {
    const aggregator = build({ now: at("2026-09-22T00:30:00+07:00") });
    aggregator.record("env-1", "checkout", "on", 1);

    expect(aggregator.drain()[0]?.bucketHour).toBe(
      Date.parse("2026-09-21T17:00:00Z"),
    );
  });

  it("biên giờ: 10:59:59.999Z và 11:00:00.000Z ⇒ hai bucket", () => {
    let now = Date.parse("2026-09-22T10:59:59.999Z");
    const aggregator = build({ now: () => now });
    aggregator.record("env-1", "checkout", "on", 1);
    now = Date.parse("2026-09-22T11:00:00.000Z");
    aggregator.record("env-1", "checkout", "on", 1);

    expect(
      aggregator
        .drain()
        .map((r) => r.bucketHour)
        .sort(),
    ).toEqual([
      Date.parse("2026-09-22T10:00:00Z"),
      Date.parse("2026-09-22T11:00:00Z"),
    ]);
  });

  it("tách theo environment: cùng flagKey ở hai env là hai hàng (I14)", () => {
    const aggregator = build({ now: at("2026-09-22T10:00:00Z") });
    aggregator.record("env-1", "checkout", "on", 1);
    aggregator.record("env-2", "checkout", "on", 2);

    expect(aggregator.drain()).toHaveLength(2);
  });

  it("flagKey chứa dấu ngoặc kép hay dấu phẩy không gộp nhầm với mục khác", () => {
    const aggregator = build({ now: at("2026-09-22T10:00:00Z") });
    aggregator.record("env-1", 'a","b', "on", 1);
    aggregator.record("env-1", "a", '","b","on', 2);

    expect(aggregator.drain()).toHaveLength(2);
  });

  it("drain tráo Map: mục ghi SAU khi drain rơi vào lô sau, không mất", () => {
    const aggregator = build({ now: at("2026-09-22T10:00:00Z") });
    aggregator.record("env-1", "checkout", "on", 1);

    const first = aggregator.drain();
    aggregator.record("env-1", "checkout", "on", 5);
    const second = aggregator.drain();

    expect(first[0]?.count).toBe(1);
    expect(second[0]?.count).toBe(5);
    expect(aggregator.size()).toBe(0);
  });

  it("bộ gộp rỗng ⇒ drain trả mảng rỗng", () => {
    expect(build({}).drain()).toEqual([]);
  });
});

describe("stats.aggregator — trần bộ nhớ", () => {
  it("vượt trần theo env: mục MỚI bị bỏ (env-cap), mục ĐÃ CÓ vẫn cộng", () => {
    const dropped: [StatsDropReason, number][] = [];
    const aggregator = build({
      now: at("2026-09-22T10:00:00Z"),
      maxPendingEntriesPerEnvironment: 2,
      onDrop: (reason, count) => dropped.push([reason, count]),
    });

    aggregator.record("env-1", "a", "on", 1);
    aggregator.record("env-1", "b", "on", 1);
    aggregator.record("env-1", "c", "on", 9);
    aggregator.record("env-1", "a", "on", 4);

    expect(dropped).toEqual([["env-cap", 9]]);
    expect(aggregator.size()).toBe(2);
    expect(aggregator.drain().find((r) => r.flagKey === "a")?.count).toBe(5);
  });

  it("vượt trần tiến trình: env MỚI cũng không mở thêm chỗ (total-cap)", () => {
    const dropped: [StatsDropReason, number][] = [];
    const aggregator = build({
      now: at("2026-09-22T10:00:00Z"),
      maxPendingEntries: 1,
      onDrop: (reason, count) => dropped.push([reason, count]),
    });

    aggregator.record("env-1", "a", "on", 1);
    aggregator.record("env-2", "b", "on", 7);

    expect(dropped).toEqual([["total-cap", 7]]);
    expect(aggregator.size()).toBe(1);
  });

  it("cộng dồn bão hoà ở 2^53 − 1 và ĐẾM phần vượt (saturated)", () => {
    const dropped: [StatsDropReason, number][] = [];
    const aggregator = build({
      now: at("2026-09-22T10:00:00Z"),
      onDrop: (reason, count) => dropped.push([reason, count]),
    });

    aggregator.record("env-1", "a", "on", Number.MAX_SAFE_INTEGER - 1);
    aggregator.record("env-1", "a", "on", 10);

    expect(aggregator.drain()[0]?.count).toBe(Number.MAX_SAFE_INTEGER);
    expect(dropped).toEqual([["saturated", 9]]);
  });

  it("restore cộng ngược lô chưa ghi; hết chỗ thì bỏ với lý do flush-failed", () => {
    const dropped: [StatsDropReason, number][] = [];
    const aggregator = build({
      now: at("2026-09-22T10:00:00Z"),
      maxPendingEntries: 1,
      onDrop: (reason, count) => dropped.push([reason, count]),
    });

    const rows: StatsRow[] = [
      {
        environmentId: "env-1",
        flagKey: "a",
        variant: "on",
        count: 2,
        bucketHour: Date.parse("2026-09-22T09:00:00Z"),
      },
      {
        environmentId: "env-1",
        flagKey: "b",
        variant: "on",
        count: 3,
        bucketHour: Date.parse("2026-09-22T09:00:00Z"),
      },
    ];
    aggregator.restore(rows);

    expect(dropped).toEqual([["flush-failed", 3]]);
    expect(aggregator.drain()).toEqual([rows[0]]);
  });

  it("restore giữ ĐÚNG bucket của lô cũ, không gán bucket hiện tại", () => {
    let now = Date.parse("2026-09-22T10:00:00Z");
    const aggregator = build({ now: () => now });
    const row: StatsRow = {
      environmentId: "env-1",
      flagKey: "a",
      variant: "on",
      count: 2,
      bucketHour: Date.parse("2026-09-22T08:00:00Z"),
    };

    now = Date.parse("2026-09-22T12:00:00Z");
    aggregator.restore([row]);

    expect(aggregator.drain()).toEqual([row]);
  });
});

describe("stats.aggregator — bảo toàn số đếm (INV-23.5)", () => {
  /** Một lượt ghi: env, flag, variant, count và mốc thời gian của nó */
  const entry = fc.record({
    environmentId: fc.constantFrom("env-1", "env-2", "env-3"),
    flagKey: fc.constantFrom("a", "b", "c", "d"),
    variant: fc.constantFrom("on", "off", "__disabled__", "__error__"),
    count: fc.integer({ min: 1, max: 1_000_000 }),
    /** Trải qua nhiều giờ để bucket không phải hằng số */
    tickMs: fc.integer({ min: 0, max: 7_200_000 }),
  });

  it("flushed + pending + dropped = input, với mọi cách xen kẽ record/drain", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(entry, fc.boolean()), {
          minLength: 1,
          maxLength: 200,
        }),
        fc.integer({ min: 1, max: 40 }),
        (script, cap) => {
          let now = Date.parse("2026-09-22T10:00:00Z");
          let dropped = 0;
          const aggregator = createStatsAggregator({
            now: () => now,
            maxPendingEntries: cap,
            maxPendingEntriesPerEnvironment: cap,
            onDrop: (_reason, count) => {
              dropped += count;
            },
          });

          let input = 0;
          let flushed = 0;
          for (const [item, drainNow] of script) {
            now += item.tickMs;
            aggregator.record(
              item.environmentId,
              item.flagKey,
              item.variant,
              item.count,
            );
            input += item.count;
            if (drainNow) {
              for (const row of aggregator.drain()) flushed += row.count;
            }
          }
          const pending = aggregator
            .drain()
            .reduce((sum, row) => sum + row.count, 0);

          return flushed + pending + dropped === input;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("một lô KHÔNG bao giờ chứa hai hàng cùng khoá xung đột (R7 V1)", () => {
    fc.assert(
      fc.property(
        fc.array(entry, { minLength: 1, maxLength: 200 }),
        (script) => {
          let now = Date.parse("2026-09-22T10:00:00Z");
          const aggregator = createStatsAggregator({
            now: () => now,
            maxPendingEntries: 10_000,
            maxPendingEntriesPerEnvironment: 10_000,
          });
          for (const item of script) {
            now += item.tickMs;
            aggregator.record(
              item.environmentId,
              item.flagKey,
              item.variant,
              item.count,
            );
          }

          const rows = aggregator.drain();
          const keys = new Set(
            rows.map((r) =>
              JSON.stringify([
                r.environmentId,
                r.flagKey,
                r.variant,
                r.bucketHour,
              ]),
            ),
          );
          return (
            keys.size === rows.length &&
            rows.every((r) => r.count > 0) &&
            rows.every(
              (r) =>
                r.bucketHour === hourFloor(new Date(r.bucketHour)).getTime(),
            )
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

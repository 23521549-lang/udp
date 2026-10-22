import { STALE_FLAG_THRESHOLDS } from "@udp/config";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyStale,
  type StaleFlagFacts,
  type StaleVariantTotal,
} from "../src/modules/stats/stale.classifier.js";

/**
 * [v4.9] Bảng quyết định của Cleanup Center (Tester 1.1, bảng R20) — thuần,
 * không database, `asOf` tiêm vào.
 *
 * Mỗi ca là MỘT ô của bảng. Phần property ở cuối canh ba tính chất mà một danh
 * sách ca mẫu không bao giờ nói được: nhãn không phụ thuộc thứ tự hàng, hàng
 * ngoài cửa sổ không đổi kết quả, và không bao giờ có hai nhãn cùng lúc — chính
 * ba chỗ mà một lần sửa "vô hại" sau này sẽ trượt.
 */

const DAY = 86_400_000;
const ASOF = new Date("2026-09-20T12:00:00.000Z");
const { unusedDays, settledDays, staleDraftDays, settledMinEvals } =
  STALE_FLAG_THRESHOLDS;

const ago = (days: number, extraMs = 0): Date =>
  new Date(ASOF.getTime() - days * DAY + extraMs);

/** Flag ACTIVE đã quan sát được rất lâu — mặc định của mọi ca ACTIVE */
const activeFlag = (over: Partial<StaleFlagFacts> = {}): StaleFlagFacts => ({
  lifecycleStatus: "ACTIVE",
  permanent: false,
  createdAt: ago(120),
  activatedAt: ago(90),
  ...over,
});

const total = (
  variantKey: string,
  counts: { unused?: number; settled?: number },
): StaleVariantTotal => ({
  variantKey,
  countUnusedWindow: counts.unused ?? counts.settled ?? 0,
  countSettledWindow: counts.settled ?? 0,
});

/** Telemetry của project bắt đầu từ rất lâu — mặc định "quan sát được" */
const context = (telemetryDaysAgo: number | null = 60) => ({
  asOf: ASOF,
  telemetryStartedAt: telemetryDaysAgo === null ? null : ago(telemetryDaysAgo),
});

describe("UNUSED", () => {
  it("ACTIVE, không permanent, 0 lượt trong cửa sổ ⇒ UNUSED", () => {
    expect(classifyStale(activeFlag(), [], context()).categories).toEqual([
      "UNUSED",
    ]);
  });

  it("một lượt trong cửa sổ giữ flag khỏi danh sách; 0 lượt thì vào", () => {
    const rows = [total("on", { unused: 1, settled: 0 })];
    expect(classifyStale(activeFlag(), rows, context()).categories).toEqual([]);
    expect(
      classifyStale(activeFlag(), [total("on", {})], context()).categories,
    ).toEqual(["UNUSED"]);
  });

  it("permanent không bao giờ UNUSED", () => {
    expect(
      classifyStale(activeFlag({ permanent: true }), [], context()).categories,
    ).toEqual([]);
  });

  it("tuổi quan sát được đúng biên: vừa đủ 30 ngày thì UNUSED, thiếu 1 ms thì không", () => {
    const exact = activeFlag({ activatedAt: ago(unusedDays) });
    expect(classifyStale(exact, [], context()).categories).toEqual(["UNUSED"]);
    const young = activeFlag({ activatedAt: ago(unusedDays, 1) });
    expect(classifyStale(young, [], context()).categories).toEqual([]);
  });

  it("flag ACTIVE lâu nhưng project mới bật telemetry hôm qua ⇒ chưa xếp (R01 (c))", () => {
    expect(classifyStale(activeFlag(), [], context(1)).categories).toEqual([]);
  });

  it("project chưa từng nhận báo cáo ⇒ không UNUSED, không SETTLED", () => {
    expect(classifyStale(activeFlag(), [], context(null)).categories).toEqual(
      [],
    );
    expect(
      classifyStale(
        activeFlag(),
        [total("on", { settled: settledMinEvals })],
        context(null),
      ).categories,
    ).toEqual([]);
  });

  it("activatedAt null (không thể có với ACTIVE, CHECK canh) ⇒ không xếp", () => {
    expect(
      classifyStale(activeFlag({ activatedAt: null }), [], context())
        .categories,
    ).toEqual([]);
  });
});

describe("SETTLED", () => {
  it("100% lượt của cửa sổ rơi vào MỘT variant ⇒ SETTLED kèm variant đó", () => {
    const verdict = classifyStale(
      activeFlag(),
      [total("on", { settled: settledMinEvals })],
      context(),
    );
    expect(verdict.categories).toEqual(["SETTLED"]);
    expect(verdict.settled).toEqual({
      variantKey: "on",
      count: settledMinEvals,
    });
  });

  it("hai variant (env khác rơi variant khác) ⇒ không SETTLED", () => {
    const verdict = classifyStale(
      activeFlag(),
      [total("on", { settled: 80 }), total("off", { settled: 40 })],
      context(),
    );
    expect(verdict.categories).toEqual([]);
    expect(verdict.settled).toBeUndefined();
  });

  it("một hàng __error__ loại SETTLED", () => {
    expect(
      classifyStale(
        activeFlag(),
        [
          total("on", { settled: settledMinEvals }),
          total("__error__", { settled: 1 }),
        ],
        context(),
      ).categories,
    ).toEqual([]);
  });

  it("chỉ có __disabled__ (flag đang tắt mọi env) KHÔNG phải SETTLED (R20 (c))", () => {
    expect(
      classifyStale(
        activeFlag(),
        [total("__disabled__", { settled: 5_000 })],
        context(),
      ).categories,
    ).toEqual([]);
  });

  it("dưới ngưỡng số lượt tối thiểu ⇒ không SETTLED", () => {
    expect(
      classifyStale(
        activeFlag(),
        [total("on", { settled: settledMinEvals - 1 })],
        context(),
      ).categories,
    ).toEqual([]);
  });

  it("dữ liệu chưa phủ 14 ngày ⇒ không SETTLED (R20 (f))", () => {
    const young = activeFlag({ activatedAt: ago(settledDays, 1) });
    expect(
      classifyStale(
        young,
        [total("on", { settled: settledMinEvals })],
        context(),
      ).categories,
    ).toEqual([]);
  });

  it("permanent không bao giờ SETTLED (R20 (g))", () => {
    expect(
      classifyStale(
        activeFlag({ permanent: true }),
        [total("on", { settled: settledMinEvals })],
        context(),
      ).categories,
    ).toEqual([]);
  });

  it("0 lượt là UNUSED, không phải SETTLED — hai nhãn loại trừ nhau", () => {
    expect(classifyStale(activeFlag(), [], context()).categories).toEqual([
      "UNUSED",
    ]);
  });
});

describe("STALE_DRAFT", () => {
  it("DRAFT quá 30 ngày ⇒ STALE_DRAFT; đúng biên thì vào, thiếu 1 ms thì không", () => {
    const old = {
      lifecycleStatus: "DRAFT" as const,
      permanent: false,
      createdAt: ago(staleDraftDays),
      activatedAt: null,
    };
    expect(classifyStale(old, [], context()).categories).toEqual([
      "STALE_DRAFT",
    ]);
    expect(
      classifyStale(
        { ...old, createdAt: ago(staleDraftDays, 1) },
        [],
        context(),
      ).categories,
    ).toEqual([]);
  });

  it("DRAFT không cần telemetry — vẫn xếp khi project chưa có báo cáo nào", () => {
    expect(
      classifyStale(
        {
          lifecycleStatus: "DRAFT",
          permanent: false,
          createdAt: ago(staleDraftDays),
          activatedAt: null,
        },
        [],
        context(null),
      ).categories,
    ).toEqual(["STALE_DRAFT"]);
  });

  it("ACTIVE cũ không bao giờ STALE_DRAFT; ARCHIVED không bao giờ vào danh sách", () => {
    expect(
      classifyStale(
        activeFlag({ createdAt: ago(365) }),
        [total("on", { unused: 5 })],
        context(),
      ).categories,
    ).toEqual([]);
    expect(
      classifyStale(
        { ...activeFlag(), lifecycleStatus: "ARCHIVED" },
        [],
        context(),
      ).categories,
    ).toEqual([]);
  });
});

describe("tính chất", () => {
  const totalArb = fc.record({
    variantKey: fc.constantFrom(
      "on",
      "off",
      "beta",
      "__disabled__",
      "__error__",
    ),
    countUnusedWindow: fc.integer({ min: 0, max: 10_000 }),
    countSettledWindow: fc.integer({ min: 0, max: 10_000 }),
  });
  const flagArb = fc.record({
    lifecycleStatus: fc.constantFrom(
      "DRAFT" as const,
      "ACTIVE" as const,
      "ARCHIVED" as const,
    ),
    permanent: fc.boolean(),
    createdAt: fc.integer({ min: 0, max: 200 }).map((d) => ago(d)),
    activatedAt: fc
      .option(fc.integer({ min: 0, max: 200 }), { nil: null })
      .map((d) => (d === null ? null : ago(d))),
  });

  it("tối đa MỘT nhãn; ARCHIVED luôn rỗng; permanent không bao giờ UNUSED/SETTLED", () => {
    fc.assert(
      fc.property(
        flagArb,
        fc.array(totalArb, { maxLength: 8 }),
        (flag, rows) => {
          const verdict = classifyStale(flag, rows, context());
          expect(verdict.categories.length).toBeLessThanOrEqual(1);
          if (flag.lifecycleStatus === "ARCHIVED") {
            expect(verdict.categories).toEqual([]);
          }
          if (flag.permanent && flag.lifecycleStatus === "ACTIVE") {
            expect(verdict.categories).toEqual([]);
          }
          expect(verdict.settled === undefined).toBe(
            verdict.categories[0] !== "SETTLED",
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("nhãn là hàm của tổng theo variant — hoán vị mảng không đổi kết quả", () => {
    fc.assert(
      fc.property(
        flagArb,
        fc.uniqueArray(totalArb, {
          maxLength: 5,
          selector: (row) => row.variantKey,
        }),
        (flag, rows) => {
          const one = classifyStale(flag, rows, context());
          const other = classifyStale(flag, [...rows].reverse(), context());
          expect(other).toEqual(one);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("hàng NGOÀI cửa sổ (cả hai tổng bằng 0) không đổi kết quả", () => {
    fc.assert(
      fc.property(
        flagArb,
        fc.uniqueArray(totalArb, {
          maxLength: 4,
          selector: (row) => row.variantKey,
        }),
        (flag, rows) => {
          const before = classifyStale(flag, rows, context());
          const after = classifyStale(
            flag,
            [
              ...rows,
              {
                variantKey: "ngoai-cua-so",
                countUnusedWindow: 0,
                countSettledWindow: 0,
              },
            ],
            context(),
          );
          expect(after).toEqual(before);
        },
      ),
      { numRuns: 200 },
    );
  });
});

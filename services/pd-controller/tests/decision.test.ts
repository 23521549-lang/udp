import { ROLLOUT_ANALYSIS } from "@udp/config";
import { rolloutThresholdsSchema } from "@udp/shared-types";
import { describe, expect, it } from "vitest";
import {
  decide,
  settleGate,
  twoProportionZ,
  type AnalysisContext,
  type Samples,
} from "../src/reconciler/decision.js";

/**
 * Sáu vấn đề của §7.5 và ba ngưỡng của §7.4, kiểm bằng fixture — không cần
 * Prometheus. I7 nằm ở đây: `hasData = false` không bao giờ ra PROMOTE.
 */

const sample = (value: number, hasData = true) => ({
  value,
  query: `q(${String(value)})`,
  windowSeconds: 60,
  hasData,
});

const samples = (
  c: { req: number; err: number; p99?: number; hasData?: boolean },
  b: { req: number; err: number; hasData?: boolean } = {
    req: 0,
    err: 0,
    hasData: false,
  },
): Samples => ({
  canaryRequests: sample(c.req, c.hasData ?? true),
  canaryErrors: sample(c.err, c.hasData ?? true),
  canaryP99: sample(c.p99 ?? 0, c.p99 !== undefined),
  baselineRequests: sample(b.req, b.hasData ?? true),
  baselineErrors: sample(b.err, b.hasData ?? true),
});

const T0 = 1_800_000_000_000;
const ctx = (over: Partial<AnalysisContext> = {}): AnalysisContext => ({
  thresholds: rolloutThresholdsSchema.parse({}),
  warmUpRequests: 100,
  metricWindowSeconds: 60,
  lastStepAt: null,
  scrapeLagSeconds: 15,
  previous: null,
  now: T0,
  ...over,
});

describe("I7 — không có dữ liệu không bao giờ dẫn tới PROMOTE", () => {
  it("hasData=false ⇒ HOLD, kể cả khi số đọc được là 0 lỗi", () => {
    const d = decide(ctx(), samples({ req: 1_000, err: 0, hasData: false }));
    expect(d.decision).toBe("HOLD");
    expect(d.reason).toMatch(/không trả dữ liệu/);
    expect(d.breach).toBe(false);
    expect(d.metricSnapshot?.canary.hasData).toBe(false);
  });

  it("0 request với hasData=true và warm-up = 0 vẫn là HOLD — 0/0 không phải 'sạch'", () => {
    const d = decide(ctx({ warmUpRequests: 0 }), samples({ req: 0, err: 0 }));
    expect(d.decision).toBe("HOLD");
    expect(d.reason).toBe("Mới 0/0 request");
  });
});

describe("§7.5 — warm-up và cửa sổ", () => {
  it("chưa đủ warm-up ⇒ HOLD với số đếm cho Portal", () => {
    const d = decide(ctx(), samples({ req: 34, err: 34 }));
    expect(d.decision).toBe("HOLD");
    expect(d.reason).toBe("Mới 34/100 request");
  });

  it("settleGate chặn đo cho tới lastStepAt + window + scrapeLag", () => {
    const stepAt = new Date(T0);
    expect(
      settleGate(ctx({ lastStepAt: stepAt, now: T0 + 74_000 }))?.reason,
    ).toMatch(/ổn định/);
    expect(
      settleGate(ctx({ lastStepAt: stepAt, now: T0 + 75_000 })),
    ).toBeUndefined();
    expect(settleGate(ctx({ lastStepAt: null }))).toBeUndefined();
  });
});

describe("§7.4 — ba ngưỡng", () => {
  it("không vượt ngưỡng ⇒ PROMOTE, streak về 0, snapshot đúng hình §9 với hai nhánh và z", () => {
    const d = decide(
      ctx(),
      samples({ req: 3_000, err: 12, p99: 250 }, { req: 27_000, err: 81 }),
    );
    expect(d.decision).toBe("PROMOTE");
    expect(d.breachStreak).toBe(0);
    expect(d.metricSnapshot).toMatchObject({
      canary: {
        requestCount: 3_000,
        errorCount: 12,
        latencyP99Ms: 250,
        hasData: true,
      },
      baseline: { requestCount: 27_000, errorCount: 81, hasData: true },
      windowSeconds: 60,
      at: T0,
    });
    expect(d.metricSnapshot?.baseline.errorRate).toBeCloseTo(0.003);
    expect(d.metricSnapshot?.zScore).toBeCloseTo(
      twoProportionZ(12, 3_000, 81, 27_000),
    );
    expect(d.metricSnapshot?.queries.canary).toHaveLength(3);
    expect(d.metricSnapshot?.queries.baseline).toHaveLength(2);
  });

  it("không có baseline ⇒ baseline.hasData=false, zScore null, chỉ ngưỡng tuyệt đối áp dụng", () => {
    const d = decide(ctx(), samples({ req: 1_000, err: 0 }));
    expect(d.metricSnapshot?.baseline).toEqual({
      requestCount: 0,
      errorCount: 0,
      errorRate: 0,
      hasData: false,
    });
    expect(d.metricSnapshot?.zScore).toBeNull();
    expect(d.decision).toBe("PROMOTE");
  });

  it("ngưỡng tuyệt đối cần CẢ tỉ lệ lẫn minErrors — 1 lỗi trên 100 request không phải breach", () => {
    // 1% > 0.5% ngưỡng nhưng chỉ 1 lỗi < minErrors 5
    const strict = ctx({
      thresholds: rolloutThresholdsSchema.parse({ errorRate: 0.005 }),
    });
    expect(decide(strict, samples({ req: 100, err: 1 })).decision).toBe(
      "PROMOTE",
    );
    expect(decide(strict, samples({ req: 1_000, err: 10 })).decision).toBe(
      "HOLD",
    );
  });

  it("ngưỡng tương đối: nền lỗi sẵn có ở baseline không bị coi là breach", () => {
    // canary 2% và baseline 1.9%: tuyệt đối dưới 5%, tương đối < 1.5×, z nhỏ
    const d = decide(
      ctx(),
      samples({ req: 5_000, err: 100 }, { req: 50_000, err: 950 }),
    );
    expect(d.decision).toBe("PROMOTE");
  });

  it("ngưỡng tương đối bắt được lỗi nhỏ nhưng có ý nghĩa thống kê", () => {
    // canary 3% so với baseline 1%: dưới 5% tuyệt đối, nhưng 3× và z lớn
    const d = decide(
      ctx(),
      samples({ req: 5_000, err: 150 }, { req: 50_000, err: 500 }),
    );
    expect(d.decision).toBe("HOLD");
    expect(d.breach).toBe(true);
    expect(d.reason).toMatch(/× baseline/);
  });

  it("latency chỉ tính khi có dữ liệu", () => {
    expect(
      decide(ctx(), samples({ req: 1_000, err: 0, p99: 1_500 })).breach,
    ).toBe(true);
    expect(decide(ctx(), samples({ req: 1_000, err: 0 })).decision).toBe(
      "PROMOTE",
    );
  });
});

describe("§7.5 — spike thoáng qua không huỷ rollout", () => {
  const breach = samples({ req: 3_000, err: 210 }, { req: 27_000, err: 81 });

  it("lần vượt đầu ⇒ HOLD với breachStreak = 1", () => {
    const d = decide(ctx(), breach);
    expect(d).toMatchObject({
      decision: "HOLD",
      breach: true,
      breachStreak: 1,
    });
  });

  it("lần thứ hai chỉ tính LIÊN TIẾP nếu cách lần vượt ĐƯỢC ĐẾM trước ≥ một cửa sổ", () => {
    const first = decide(ctx({ now: T0 }), breach);
    expect(first.breachAt).toBe(T0);

    // Nhịp đo 30s < cửa sổ 60s: lần đo chồng lấn không cộng, không xoá, giữ mốc cũ
    const tooSoon = decide(ctx({ previous: first, now: T0 + 30_000 }), breach);
    expect(tooSoon).toMatchObject({
      decision: "HOLD",
      breachStreak: 1,
      breachAt: T0,
    });

    // Lần đo kế nối từ mốc T0 (không phải từ `at` của lần chồng lấn) ⇒ đủ 2
    const later = decide(ctx({ previous: tooSoon, now: T0 + 60_000 }), breach);
    expect(later.decision).toBe("ROLLBACK");
    expect(later.breachStreak).toBe(2);
    expect(later.breachAt).toBe(T0 + 60_000);
    expect(later.reason).toMatch(/2 lần đo liên tiếp/);
  });

  it("last_decision cũ không có breachAt thì nối từ `at`", () => {
    const first = decide(ctx({ now: T0 }), breach);
    const legacy = { ...first, breachAt: null };
    const later = decide(ctx({ previous: legacy, now: T0 + 60_000 }), breach);
    expect(later.breachStreak).toBe(2);
  });

  it("một lần đo sạch ở giữa xoá chuỗi", () => {
    const first = decide(ctx({ now: T0 }), breach);
    const ok = decide(
      ctx({ previous: first, now: T0 + 60_000 }),
      samples({ req: 3_000, err: 0 }),
    );
    expect(ok.decision).toBe("PROMOTE");
    const again = decide(ctx({ previous: ok, now: T0 + 120_000 }), breach);
    expect(again.breachStreak).toBe(1);
  });

  it("maxConsecutiveBreaches = 1 rollback ngay lần đầu", () => {
    const d = decide(
      ctx({
        thresholds: rolloutThresholdsSchema.parse({
          maxConsecutiveBreaches: 1,
        }),
      }),
      breach,
    );
    expect(d.decision).toBe("ROLLBACK");
  });
});

/**
 * [Plan #60 QĐ-1, UX-23] Mỗi lý do có MÃ + số đi cùng câu chữ: Portal viết câu theo ngôn ngữ người xem từ `detail`,
 * nên số trong `detail` phải đúng những số đã đem ra so — không phải số làm tròn của câu chữ.
 */
describe("mã lý do cho giao diện hai ngôn ngữ", () => {
  it("không dữ liệu, chưa đủ warm-up, chờ cửa sổ ổn định", () => {
    expect(
      decide(ctx(), samples({ req: 1_000, err: 0, hasData: false })).detail,
    ).toEqual({ code: "NO_DATA" });
    expect(decide(ctx(), samples({ req: 34.7, err: 0 })).detail).toEqual({
      code: "WARMING_UP",
      requests: 34,
      needed: 100,
    });
    expect(
      settleGate(ctx({ lastStepAt: new Date(T0), now: T0 + 60_000 }))?.detail,
    ).toEqual({ code: "SETTLING", waitSeconds: 15 });
  });

  it("không vượt ngưỡng ⇒ WITHIN_THRESHOLDS", () => {
    expect(
      decide(ctx(), samples({ req: 3_000, err: 12, p99: 250 })).detail,
    ).toEqual({ code: "WITHIN_THRESHOLDS" });
  });

  it("vượt ngưỡng: mọi nguyên nhân kèm số đo và ngưỡng, chuỗi streak/needed", () => {
    const d = decide(
      ctx(),
      samples({ req: 3_000, err: 210, p99: 1_500 }, { req: 27_000, err: 81 }),
    );
    expect(d.detail).toMatchObject({ code: "BREACH", streak: 1, needed: 2 });
    if (d.detail?.code !== "BREACH") throw new Error("thiếu BREACH");
    expect(d.detail.causes.map((c) => c.kind)).toEqual([
      "ERROR_RATE",
      "RELATIVE_ERROR_RATE",
      "LATENCY_P99",
    ]);
    expect(d.detail.causes[0]).toEqual({
      kind: "ERROR_RATE",
      rate: 0.07,
      limit: 0.05,
      errors: 210,
      minErrors: 5,
    });
    expect(d.detail.causes[1]).toMatchObject({
      kind: "RELATIVE_ERROR_RATE",
      rate: 0.07,
      factor: 1.5,
      baselineRate: 0.003,
    });
    expect(d.detail.causes[2]).toEqual({
      kind: "LATENCY_P99",
      p99Ms: 1_500,
      limitMs: 1_000,
    });
  });

  it("đủ số lần liên tiếp ⇒ ROLLBACK mang CÙNG nguyên nhân, streak = needed", () => {
    const breach = samples({ req: 3_000, err: 210 }, { req: 27_000, err: 81 });
    const first = decide(ctx({ now: T0 }), breach);
    const later = decide(ctx({ previous: first, now: T0 + 60_000 }), breach);
    expect(later.decision).toBe("ROLLBACK");
    expect(later.detail).toMatchObject({
      code: "BREACH",
      streak: 2,
      needed: 2,
    });
  });
});

describe("twoProportionZ", () => {
  it("bằng 0 khi không có khác biệt hoặc không có mẫu", () => {
    expect(twoProportionZ(10, 1_000, 10, 1_000)).toBe(0);
    expect(twoProportionZ(0, 0, 1, 10)).toBe(0);
  });
  it("dương và lớn khi canary lỗi nhiều hơn rõ rệt (kịch bản §7.7)", () => {
    expect(twoProportionZ(210, 3_000, 81, 27_000)).toBeGreaterThan(20);
    expect(twoProportionZ(12, 3_000, 81, 27_000)).toBeLessThan(
      ROLLOUT_ANALYSIS.zCritical,
    );
  });
});

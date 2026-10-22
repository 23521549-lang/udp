import { describe, expect, it } from "vitest";
import {
  blastEstimate,
  clockOffsetMs,
  decompose,
  errorRateBetween,
} from "../src/e5.js";

describe("phân rã MTTD của E5", () => {
  it("các thành phần cộng lại đúng bằng MTTD", () => {
    const b = decompose({
      t0: 1_000,
      tScrape: 13_000,
      tBreach1: 70_000,
      tDecision: 131_000,
      t3: 131_800,
    });
    expect(b).toEqual({
      scrapeLagMs: 12_000,
      detectMs: 57_000,
      streakConfirmMs: 61_000,
      mttdMs: 130_000,
      mttrMs: 800,
    });
    expect(
      (b.scrapeLagMs ?? 0) + (b.detectMs ?? 0) + (b.streakConfirmMs ?? 0),
    ).toBe(b.mttdMs);
  });

  it("mốc thiếu ⇒ thành phần undefined, không đoán", () => {
    expect(decompose({ t0: 0, tDecision: 5 })).toMatchObject({
      scrapeLagMs: undefined,
      mttdMs: 5,
      mttrMs: undefined,
    });
  });

  it("mốc trước T0 ⇒ ném (sai miền đồng hồ)", () => {
    expect(() => decompose({ t0: 100, tScrape: 50 })).toThrow(RangeError);
  });

  it("blast radius ước lượng = (MTTD + MTTR) × RPS × checkout × canary — cả khoảng [T0, T3]", () => {
    expect(
      blastEstimate({ mttdMs: 100_000, mttrMs: 1_000 }, 50, 0.7, 0.2),
    ).toBeCloseTo(707);
    expect(
      blastEstimate({ mttdMs: undefined, mttrMs: 1_000 }, 50, 0.7, 0.2),
    ).toBeUndefined();
  });

  it("tỉ lệ lỗi theo cửa sổ từ bộ đếm tích luỹ (đối chứng âm)", () => {
    const series = [
      { at: 0, servedAll: 0, failedAll: 0 },
      { at: 60_000, servedAll: 1_000, failedAll: 300 },
      { at: 120_000, servedAll: 2_000, failedAll: 600 },
    ];
    expect(errorRateBetween(series, 0, 60_000)).toBeCloseTo(0.3);
    expect(errorRateBetween(series, 60_000, 120_000)).toBeCloseTo(0.3);
    expect(errorRateBetween(series, 130_000, 140_000)).toBeUndefined();
  });

  it("độ lệch đồng hồ Prometheus so với máy đo", () => {
    expect(clockOffsetMs(1_000.25, 1_000_000, 1_000_100)).toBe(200);
  });
});

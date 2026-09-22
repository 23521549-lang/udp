import { describe, expect, it } from "vitest";
import { percentile, summarize } from "../src/stats.js";

describe("percentile nearest-rank", () => {
  it("là một mẫu THẬT, không nội suy", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.9)).toBe(9);
    expect(percentile(sorted, 0.99)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile([], 0.5)).toBeNaN();
  });

  it("summarize: median, IQR, min/max trên dữ liệu chưa sắp", () => {
    const s = summarize([9, 1, 5, 3, 7, 2, 8, 4, 6, 10]);
    expect(s).toMatchObject({
      n: 10,
      min: 1,
      p50: 5,
      p25: 3,
      p75: 8,
      max: 10,
      iqr: 5,
    });
  });
});

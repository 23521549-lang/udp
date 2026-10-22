/**
 * Thống kê của mọi phép đo §14 [v4.8] — MỘT định nghĩa percentile cho cả repo
 * (`packages/flag-evaluator/scripts/bench-evaluate.ts` dùng cùng công thức), để
 * hai con số E3 so được với nhau.
 *
 * Percentile nearest-rank: phần tử thứ ⌈p·n⌉ của dãy đã sắp (1-based). Không nội
 * suy: mọi con số báo cáo là một mẫu THẬT đã đo được.
 */

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? Number.NaN;
}

export interface Summary {
  n: number;
  min: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
  max: number;
  /** Khoảng tứ phân vị — E5 báo median + IQR (phân phối lệch phải, bị chặn dưới) */
  iqr: number;
}

export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);
  return {
    n: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p25,
    p50: percentile(sorted, 0.5),
    p75,
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    iqr: p75 - p25,
  };
}

/** Làm tròn cho báo cáo — giữ `digits` chữ số thập phân */
export const round = (value: number, digits = 3): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;

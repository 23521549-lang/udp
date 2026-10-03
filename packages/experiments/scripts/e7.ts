import { randomUUID } from "node:crypto";
import {
  evaluate,
  prepareSnapshot,
  type SnapshotFlag,
} from "@udp/flag-evaluator";
import type { E7Data } from "@udp/shared-types/measurements";
import { IN_PROCESS, writeResult } from "../src/index.js";

/**
 * **E7** (§14) — chất lượng phân phối của consistent hashing, đo TRÊN ĐƯỜNG ĐÁNH GIÁ THẬT (`evaluate`, không gọi
 * `bucketOf` trực tiếp): N userId ngẫu nhiên, tỉ lệ quan sát so với mong muốn, và kiểm định chi-square.
 *
 *     pnpm --filter @udp/experiments e7 [soNguoi]
 *
 * Ngưỡng: χ² với df = k − 1 so với giá trị tới hạn ở mức ý nghĩa 0,001. Vượt ⇒ thoát mã 1 (phân phối lệch có ý
 * nghĩa thống kê). [Plan #56] Kết quả ghi `docs/measurements/raw/E7-*.json` như mọi phép đo khác (trước đây chỉ in
 * ra console, không truy được nguồn).
 */

const N = Number(process.argv[2] ?? 1_000_000);
const ALPHA = 0.001;

/** Giá trị tới hạn χ² (α = 0,001) theo bậc tự do — bảng chuẩn */
const CRITICAL_001: Record<number, number> = {
  1: 10.828,
  2: 13.816,
  3: 16.266,
};

/** Trọng số theo phần trăm × 1000 (tổng 100 000), như `weight` của rule phân phối */
const SCENARIOS: { name: string; weights: [string, number][] }[] = [
  {
    name: "canary 10/90",
    weights: [
      ["on", 10_000],
      ["off", 90_000],
    ],
  },
  {
    name: "canary 1/99",
    weights: [
      ["on", 1_000],
      ["off", 99_000],
    ],
  },
  {
    name: "ba variant 20/30/50",
    weights: [
      ["a", 20_000],
      ["b", 30_000],
      ["c", 50_000],
    ],
  },
];

function measure(
  name: string,
  weights: [string, number][],
): E7Data["scenarios"][number] {
  const flag: SnapshotFlag = {
    key: "e7",
    type: "STRING",
    isEnabled: true,
    stickinessAttribute: "targetingKey",
    variants: Object.fromEntries(weights.map(([k]) => [k, k])),
    defaultVariantKey: weights[0]?.[0] ?? "",
    rules: [
      {
        id: "r1",
        type: "ALL",
        condition: {},
        serve: {
          kind: "distribution",
          weights: weights.map(([variantKey, weight]) => ({
            variantKey,
            weight,
          })),
        },
        bucketSalt: randomUUID(),
        priority: 0,
      },
    ],
  };
  const prepared = prepareSnapshot({
    flags: [flag],
    segments: [],
    trackedFlags: [],
  });
  const counts = new Map<string, number>(weights.map(([k]) => [k, 0]));
  for (let i = 0; i < N; i += 1) {
    const variant = evaluate(prepared, "e7", {
      targetingKey: randomUUID(),
    }).variant;
    if (variant !== undefined)
      counts.set(variant, (counts.get(variant) ?? 0) + 1);
  }
  let chi2 = 0;
  const variants = weights.map(([key, w]) => {
    const expected = (N * w) / 100_000;
    const observed = counts.get(key) ?? 0;
    chi2 += (observed - expected) ** 2 / expected;
    return { key, expectedShare: w / 100_000, observedShare: observed / N };
  });
  const df = weights.length - 1;
  const critical = CRITICAL_001[df];
  if (critical === undefined)
    throw new Error(`thiếu giá trị tới hạn df=${String(df)}`);
  return { name, n: N, df, critical, chi2, pass: chi2 < critical, variants };
}

const scenarios = SCENARIOS.map(({ name, weights }) => measure(name, weights));
for (const s of scenarios) {
  console.log(
    `${s.name} — N=${String(s.n)} — χ²=${s.chi2.toFixed(3)} (df=${String(s.df)}, tới hạn α=${String(ALPHA)}: ${String(s.critical)}) ${s.pass ? "ĐẠT" : "LỆCH"}`,
  );
}
const data: E7Data = { alpha: ALPHA, scenarios };
console.log(writeResult("E7", IN_PROCESS, data));
process.exitCode = scenarios.every((s) => s.pass) ? 0 : 1;

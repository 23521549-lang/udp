import { randomUUID } from "node:crypto";
import { evaluate, prepareSnapshot, type SnapshotFlag } from "../src/index.js";

/**
 * **E7** (§14) — chất lượng phân phối của consistent hashing, đo TRÊN ĐƯỜNG ĐÁNH
 * GIÁ THẬT (`evaluate`, không gọi `bucketOf` trực tiếp): 1 000 000 userId ngẫu
 * nhiên, sai lệch so với tỉ lệ mong muốn, và kiểm định chi-square.
 *
 *     pnpm --filter @udp/flag-evaluator e7 [soNguoi]
 *
 * Ngưỡng: χ² với df = k − 1 so với giá trị tới hạn ở mức ý nghĩa 0,001. Vượt ⇒
 * thoát mã 1 (phân phối lệch có ý nghĩa thống kê).
 */

const N = Number(process.argv[2] ?? 1_000_000);

/** Giá trị tới hạn χ² (α = 0,001) theo bậc tự do — bảng chuẩn */
const CRITICAL_001: Record<number, number> = {
  1: 10.828,
  2: 13.816,
  3: 16.266,
};

const scenarios: { name: string; weights: [string, number][] }[] = [
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

let failed = false;
for (const { name, weights } of scenarios) {
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
  const rows = weights.map(([k, w]) => {
    const expected = (N * w) / 100_000;
    const observed = counts.get(k) ?? 0;
    chi2 += (observed - expected) ** 2 / expected;
    return `${k}: ${((observed / N) * 100).toFixed(3)}% (mong muốn ${(w / 1000).toFixed(3)}%)`;
  });
  const df = weights.length - 1;
  const critical = CRITICAL_001[df] ?? Number.POSITIVE_INFINITY;
  const ok = chi2 < critical;
  failed ||= !ok;
  console.log(
    `${name} — N=${String(N)} — ${rows.join(", ")} — χ²=${chi2.toFixed(3)} (df=${String(df)}, tới hạn α=0.001: ${String(critical)}) ${ok ? "ĐẠT" : "LỆCH"}`,
  );
}
process.exitCode = failed ? 1 : 0;

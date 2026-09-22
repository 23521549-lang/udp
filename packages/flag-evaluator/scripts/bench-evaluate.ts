import { randomUUID } from "node:crypto";
import {
  evaluate,
  prepareSnapshot,
  type SnapshotFlag,
  type SnapshotRule,
} from "../src/index.js";

/**
 * Số NỀN cho **E3** (§14) — độ trễ của lõi `evaluate` trong tiến trình, theo lưới
 * 1/10/100 flag × 1/10/50 rule/flag. E3 đầy đủ (qua provider và SDK OpenFeature
 * thật, đối chứng OFREP) là `pnpm --filter @udp/experiments e3` [v4.8]; con số này
 * là trần dưới của nó: không SDK nào nhanh hơn lõi.
 *
 *     pnpm --filter @udp/flag-evaluator bench
 *
 * Mỗi ô: rule cuối cùng mới khớp (ca tệ nhất của vòng duyệt), 20 000 lượt sau
 * 2 000 lượt khởi động; in p50/p99 theo micro-giây.
 */

function ruleOf(i: number, last: boolean): SnapshotRule {
  return {
    id: `r${String(i)}`,
    type: "ATTRIBUTE_BASED",
    condition: {
      all: [
        {
          attribute: "plan",
          operator: "eq",
          value: last ? "pro" : `plan-${String(i)}`,
        },
        { attribute: "age", operator: "gte", value: 18 },
      ],
    },
    serve: {
      kind: "distribution",
      weights: [
        { variantKey: "on", weight: 50_000 },
        { variantKey: "off", weight: 50_000 },
      ],
    },
    bucketSalt: randomUUID(),
    priority: i,
  };
}

/**
 * Nearest-rank — CÙNG định nghĩa với `@udp/experiments` (`src/stats.ts`), để số
 * của lõi và số qua SDK so được; chép tại chỗ vì lõi không phụ thuộc experiments
 */
const percentile = (sorted: number[], p: number): number =>
  sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1] ?? 0;

for (const flagCount of [1, 10, 100]) {
  for (const ruleCount of [1, 10, 50]) {
    const flags: SnapshotFlag[] = Array.from({ length: flagCount }, (_, f) => ({
      key: `f${String(f)}`,
      type: "BOOLEAN",
      isEnabled: true,
      stickinessAttribute: "targetingKey",
      variants: { on: true, off: false },
      defaultVariantKey: "off",
      rules: Array.from({ length: ruleCount }, (_, r) =>
        ruleOf(r, r === ruleCount - 1),
      ),
    }));
    const prepared = prepareSnapshot({ flags, segments: [], trackedFlags: [] });
    const samples: number[] = [];
    for (let i = 0; i < 22_000; i += 1) {
      const key = `f${String(i % flagCount)}`;
      const context = {
        targetingKey: `user-${String(i)}`,
        plan: "pro",
        age: 30,
      };
      const t = process.hrtime.bigint();
      evaluate(prepared, key, context);
      const dt = Number(process.hrtime.bigint() - t) / 1000;
      if (i >= 2_000) samples.push(dt);
    }
    samples.sort((a, b) => a - b);
    console.log(
      `${String(flagCount).padStart(3)} flag × ${String(ruleCount).padStart(2)} rule — p50 ${percentile(samples, 0.5).toFixed(2)} µs, p99 ${percentile(samples, 0.99).toFixed(2)} µs`,
    );
  }
}

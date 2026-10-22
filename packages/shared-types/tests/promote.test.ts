import { describe, expect, it } from "vitest";
import {
  replaceVariantsFields,
  replaceVariantsRefine,
} from "../src/flag-api.js";
import { planPromotion, stableJson } from "../src/promote.js";
import type { RuleWire } from "../src/wire.js";

/**
 * [Plan #44] `planPromotion` dời từ Portal về đây để Service 1 áp ĐÚNG kế hoạch Portal hiện — các
 * phép dưới là bộ của Portal chuyển theo, thêm hai ca mà phía server cần.
 */

const VAR_ON = "11111111-1111-4111-8111-111111111111";
const VAR_OFF = "22222222-2222-4222-8222-222222222222";

const rule = (
  id: string,
  priority: number,
  over: Partial<RuleWire> = {},
): RuleWire => ({
  id,
  priority,
  ruleType: "ATTRIBUTE_BASED",
  condition: { all: [{ attribute: "country", operator: "eq", value: "VN" }] },
  serve: { kind: "variant", variantId: VAR_ON },
  description: null,
  ...over,
});

const SRC_A = "a0000000-0000-4000-8000-000000000001";
const SRC_B = "a0000000-0000-4000-8000-000000000002";
const DST_A = "d0000000-0000-4000-8000-000000000001";
const DST_X = "d0000000-0000-4000-8000-000000000009";

describe("planPromotion", () => {
  it("rule khớp (cùng loại + điều kiện) mang id của rule ĐÍCH, không bao giờ id nguồn", () => {
    const source = [
      rule(SRC_A, 10, {
        serve: {
          kind: "distribution",
          weights: [
            { variantId: VAR_OFF, weight: 50_000 },
            { variantId: VAR_ON, weight: 50_000 },
          ],
        },
      }),
      rule(SRC_B, 20, { ruleType: "ALL", condition: {} }),
    ];
    const target = [
      // cùng điều kiện nhưng khoá theo thứ tự khác — vẫn là một điều kiện
      rule(DST_A, 10, {
        condition: {
          all: [{ value: "VN", operator: "eq", attribute: "country" }],
        },
      }),
      rule(DST_X, 20, {
        ruleType: "USER_BASED",
        condition: { userIds: ["u1"] },
      }),
    ];
    const plan = planPromotion(source, target, "2026-09-25T01:00:00.000Z");
    expect(plan.body.rules.map((r) => r.id)).toEqual([DST_A, undefined]);
    expect(JSON.stringify(plan.body)).not.toContain(SRC_A);
    expect(JSON.stringify(plan.body)).not.toContain(SRC_B);
    expect(plan.body.lastKnownUpdatedAt).toBe("2026-09-25T01:00:00.000Z");
    expect(plan.diff.map((d) => d.kind)).toEqual([
      "changed",
      "added",
      "removed",
    ]);
    expect(plan.changes).toBe(3);
  });

  it("đích đã giống hệt ⇒ 0 thay đổi", () => {
    const plan = planPromotion([rule(SRC_A, 10)], [rule(DST_A, 10)], "x");
    expect(plan.changes).toBe(0);
    expect(plan.body.rules[0]?.id).toBe(DST_A);
  });

  it("thứ tự theo priority của NGUỒN, priority gửi đi chuẩn hoá (i + 1) × 10, mô tả rỗng thành null", () => {
    const plan = planPromotion(
      [
        rule(SRC_B, 7, { ruleType: "ALL", condition: {}, description: "  " }),
        rule(SRC_A, 3, { description: " VN " }),
      ],
      [],
      "x",
    );
    expect(plan.body.rules.map((r) => [r.ruleType, r.priority])).toEqual([
      ["ATTRIBUTE_BASED", 10],
      ["ALL", 20],
    ]);
    expect(plan.body.rules.map((r) => r.description)).toEqual(["VN", null]);
  });

  it("đổi chỗ hai rule khớp là `changed` — thứ tự quyết định rule nào khớp trước", () => {
    const all = { ruleType: "ALL" as const, condition: {} };
    const plan = planPromotion(
      [rule(SRC_A, 10), rule(SRC_B, 20, all)],
      [rule(DST_X, 10, all), rule(DST_A, 20)],
      "x",
    );
    expect(plan.diff.map((d) => [d.kind, d.keptId])).toEqual([
      ["changed", DST_A],
      ["changed", DST_X],
    ]);
  });

  it("stableJson không phụ thuộc thứ tự khoá", () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      stableJson({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
  });
});

describe("replaceVariantsFields", () => {
  const schema = replaceVariantsFields.superRefine(replaceVariantsRefine);
  const at = "2026-09-28T00:00:00.000Z";

  it("nhận variant cũ (có id) lẫn mới (không id)", () => {
    expect(
      schema.safeParse({
        lastKnownUpdatedAt: at,
        variants: [
          { id: VAR_ON, key: "blue", value: "#00f" },
          { key: "green", value: "#0f0" },
        ],
      }).success,
    ).toBe(true);
  });

  it("từ chối: < 2 variant, key trùng, id trùng, key `__`, trường lạ", () => {
    const bad = [
      [{ key: "a", value: 1 }],
      [
        { key: "a", value: 1 },
        { key: "a", value: 2 },
      ],
      [
        { id: VAR_ON, key: "a", value: 1 },
        { id: VAR_ON, key: "b", value: 2 },
      ],
      [
        { key: "__disabled__", value: 1 },
        { key: "b", value: 2 },
      ],
      [
        { key: "a", value: 1, bucketSalt: "x" },
        { key: "b", value: 2 },
      ],
    ];
    for (const variants of bad) {
      expect(
        schema.safeParse({ lastKnownUpdatedAt: at, variants }).success,
      ).toBe(false);
    }
  });
});

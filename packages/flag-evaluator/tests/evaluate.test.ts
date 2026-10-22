import fc from "fast-check";
import type { Evaluation } from "@udp/shared-types";
import { describe, expect, it } from "vitest";
import {
  evaluate,
  evaluateAll,
  fromOfrep,
  ofrepVisible,
  prepareSnapshot,
  toOfrep,
  type Snapshot,
  type SnapshotFlag,
} from "../src/index.js";

/**
 * Lõi đánh giá §6.5 [v4.6]: ngữ nghĩa toán tử, thứ tự đánh giá, sticky, segment,
 * I1 qua đường đánh giá thật, ánh xạ OFREP, và I33 (không bao giờ ném).
 */

const flag = (over: Partial<SnapshotFlag> = {}): SnapshotFlag => ({
  key: "f",
  type: "BOOLEAN",
  isEnabled: true,
  stickinessAttribute: "targetingKey",
  variants: { on: true, off: false },
  defaultVariantKey: "off",
  rules: [],
  ...over,
});

const snap = (flags: Snapshot["flags"], segments: Snapshot["segments"] = []) =>
  prepareSnapshot({ flags, segments, trackedFlags: [] });

const rule = (
  id: string,
  type: string,
  condition: unknown,
  variantKey = "on",
) => ({
  id,
  type,
  condition,
  serve: { kind: "variant" as const, variantKey },
  bucketSalt: `salt-${id}`,
  priority: 0,
});

const attr = (operator: string, value: unknown, attribute = "a") =>
  snap([
    flag({
      rules: [
        rule("r1", "ATTRIBUTE_BASED", {
          all: [{ attribute, operator, value }],
        }),
      ],
    }),
  ]);

const matches = (prepared: ReturnType<typeof snap>, context: object): boolean =>
  evaluate(prepared, "f", context).reason === "TARGETING_MATCH";

describe("toán tử — so chặt, vắng ⇒ false với mọi toán tử", () => {
  const table: [string, unknown, unknown, boolean][] = [
    ["eq", "vn", "vn", true],
    ["eq", "vn", "us", false],
    ["eq", 5, "5", false],
    ["eq", true, true, true],
    ["neq", "vn", "us", true],
    ["neq", "vn", "vn", false],
    ["neq", 5, "5", false],
    ["in", ["a", "b"], "b", true],
    ["in", ["a", "b"], 1, false],
    ["nin", ["a", "b"], "c", true],
    ["nin", ["a", "b"], "a", false],
    ["gt", 10, 11, true],
    ["gt", 10, 10, false],
    ["gt", 10, "11", false],
    ["gte", 10, 10, true],
    ["lt", 10, 9.5, true],
    ["lte", 10, Number.NaN, false],
    ["lte", 10, Number.NEGATIVE_INFINITY, false],
    ["contains", "ab", "xaby", true],
    ["startsWith", "ab", "abc", true],
    ["endsWith", "bc", "abc", true],
    ["contains", "ab", 12, false],
    ["semverGt", "1.2.3", "1.10.0", true],
    ["semverGt", "1.2.3", "1.2.3-rc.1", false],
    ["semverLt", "2.0.0", "2.0.0-alpha", true],
    ["semverLt", "2.0.0", "abc", false],
    ["regex", "^user-[0-9]+$", "user-42", true],
    ["regex", "^user-[0-9]+$", "admin-42", false],
  ];
  for (const [operator, value, actual, expected] of table) {
    it(`${operator} ${JSON.stringify(value)} vs ${String(actual)} ⇒ ${String(expected)}`, () => {
      expect(matches(attr(operator, value), { a: actual })).toBe(expected);
    });
  }

  it("vắng hoặc null ⇒ false, kể cả neq và nin", () => {
    for (const [op, v] of [
      ["neq", "vn"],
      ["nin", ["vn"]],
      ["eq", "vn"],
    ] as const) {
      expect(matches(attr(op, v), {})).toBe(false);
      expect(matches(attr(op, v), { a: null })).toBe(false);
    }
  });

  it("chỉ thuộc tính RIÊNG — prototype không phải thuộc tính", () => {
    expect(matches(attr("eq", "x", "toString"), {})).toBe(false);
  });

  it("NFC ở cả hai phía — NFD trong context khớp NFC trong rule", () => {
    const nfd = "Nguyễn".normalize("NFD");
    expect(matches(attr("eq", "Nguyễn".normalize("NFC")), { a: nfd })).toBe(
      true,
    );
  });

  it("context có khoá __proto__ (JSON.parse) không đổi prototype, không lộ thuộc tính giả", () => {
    const ctx = JSON.parse('{"__proto__":{"a":"x"}}') as object;
    expect(matches(attr("eq", "x"), ctx)).toBe(false);
  });

  it("regex chưa ở dạng NFC trong snapshot ⇒ rule HỎNG (ERROR), không chuẩn hoá hộ", () => {
    const acute = String.fromCharCode(0x0301);
    const p = attr("regex", `^(e${acute}|x)$`);
    expect(evaluate(p, "f", { a: "x" })).toMatchObject({
      reason: "ERROR",
      errorCode: "GENERAL",
    });
  });

  it("regex: chuỗi dài quá trần ⇒ false, không chạy", () => {
    expect(matches(attr("regex", "a"), { a: "a".repeat(257) })).toBe(false);
    expect(matches(attr("regex", "a"), { a: "a".repeat(256) })).toBe(true);
  });
});

describe("thứ tự đánh giá §6.5 (D2)", () => {
  it("không có ⇒ FLAG_NOT_FOUND; bia mộ ⇒ DISABLED + archived; tắt ⇒ DISABLED không value", () => {
    const p = snap([
      { key: "old", archived: true },
      flag({ isEnabled: false }),
    ]);
    expect(evaluate(p, "none", {})).toMatchObject({
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
    });
    expect(evaluate(p, "old", {})).toEqual({
      reason: "DISABLED",
      archived: true,
    });
    expect(evaluate(p, "f", {})).toEqual({ reason: "DISABLED" });
  });

  it("kiểu mong đợi lệch ⇒ TYPE_MISMATCH (chỉ khi được hỏi)", () => {
    const p = snap([flag()]);
    expect(evaluate(p, "f", {}, { expectedType: "STRING" })).toMatchObject({
      errorCode: "TYPE_MISMATCH",
    });
    expect(evaluate(p, "f", {}).reason).toBe("DEFAULT");
  });

  it("rule đầu khớp thắng; không khớp ⇒ DEFAULT kèm variant mặc định", () => {
    const p = snap([
      flag({
        rules: [
          rule("r1", "USER_BASED", { userIds: ["u1"] }, "off"),
          rule("r2", "ALL", {}, "on"),
        ],
      }),
    ]);
    expect(evaluate(p, "f", { targetingKey: "u1" })).toEqual({
      reason: "TARGETING_MATCH",
      value: false,
      variant: "off",
      ruleId: "r1",
    });
    expect(evaluate(p, "f", { targetingKey: "u2" })).toMatchObject({
      variant: "on",
      ruleId: "r2",
    });
    const none = snap([
      flag({ rules: [rule("r1", "USER_BASED", { userIds: ["u1"] })] }),
    ]);
    expect(evaluate(none, "f", { targetingKey: "x" })).toEqual({
      reason: "DEFAULT",
      value: false,
      variant: "off",
    });
  });

  it("rule hỏng ⇒ ERROR GENERAL tại chỗ, không bỏ qua (ADR-03 d)", () => {
    const p = snap([
      flag({
        rules: [
          rule("bad", "ATTRIBUTE_BASED", {
            all: [{ attribute: "a", operator: "gt", value: "x" }],
          }),
          rule("r2", "ALL", {}),
        ],
      }),
    ]);
    expect(evaluate(p, "f", { a: 1 })).toMatchObject({
      reason: "ERROR",
      errorCode: "GENERAL",
      ruleId: "bad",
    });
  });

  it("variant mồ côi ⇒ ERROR, không ném", () => {
    const p = snap([flag({ rules: [rule("r1", "ALL", {}, "ghost")] })]);
    expect(evaluate(p, "f", {})).toMatchObject({
      reason: "ERROR",
      ruleId: "r1",
    });
    const noDefault = snap([flag({ defaultVariantKey: "ghost" })]);
    expect(evaluate(noDefault, "f", {}).reason).toBe("ERROR");
  });

  it("USER_BASED: targetingKey vắng hoặc rỗng không khớp — kể cả userId tên 'undefined'", () => {
    const p = snap([
      flag({
        rules: [rule("r1", "USER_BASED", { userIds: ["undefined", ""] })],
      }),
    ]);
    expect(evaluate(p, "f", {}).reason).toBe("DEFAULT");
    expect(evaluate(p, "f", { targetingKey: "" }).reason).toBe("DEFAULT");
  });
});

describe("segment — khớp ⇔ userIds chứa targetingKey HOẶC (all không rỗng VÀ mọi điều kiện)", () => {
  const seg = (all: unknown[], userIds: string[]) =>
    snap(
      [
        flag({
          rules: [
            rule("r1", "SEGMENT", {
              segmentId: "00000000-0000-4000-8000-000000000001",
            }),
          ],
        }),
      ],
      [{ id: "00000000-0000-4000-8000-000000000001", all, userIds }],
    );

  it("cả hai rỗng khớp KHÔNG AI (sửa lỗi [].every của §6.5 cũ)", () => {
    expect(matches(seg([], []), { targetingKey: "u1" })).toBe(false);
  });

  it("userIds hoặc điều kiện", () => {
    const p = seg(
      [{ attribute: "plan", operator: "eq", value: "pro" }],
      ["u1"],
    );
    expect(matches(p, { targetingKey: "u1" })).toBe(true);
    expect(matches(p, { targetingKey: "u2", plan: "pro" })).toBe(true);
    expect(matches(p, { targetingKey: "u2", plan: "free" })).toBe(false);
  });

  it("targetingKey rỗng không khớp userIds — cùng luật USER_BASED", () => {
    expect(matches(seg([], [""]), { targetingKey: "" })).toBe(false);
  });

  it("segment không có trong snapshot ⇒ không khớp; segment hỏng ⇒ ERROR", () => {
    const missing = snap([
      flag({
        rules: [
          rule("r1", "SEGMENT", {
            segmentId: "00000000-0000-4000-8000-000000000009",
          }),
        ],
      }),
    ]);
    expect(evaluate(missing, "f", { targetingKey: "u1" }).reason).toBe(
      "DEFAULT",
    );
    const broken = snap(
      [
        flag({
          rules: [
            rule("r1", "SEGMENT", {
              segmentId: "00000000-0000-4000-8000-000000000001",
            }),
          ],
        }),
      ],
      [
        {
          id: "00000000-0000-4000-8000-000000000001",
          all: [{ x: 1 }],
          userIds: [],
        },
      ],
    );
    expect(evaluate(broken, "f", { targetingKey: "u1" })).toMatchObject({
      reason: "ERROR",
    });
  });
});

describe("sticky (D3) và I1 qua đường đánh giá thật", () => {
  const split = (on: number, stickinessAttribute = "targetingKey") =>
    snap([
      flag({
        stickinessAttribute,
        rules: [
          {
            id: "r1",
            type: "ALL",
            condition: {},
            serve: {
              kind: "distribution",
              weights: [
                { variantKey: "on", weight: on },
                { variantKey: "off", weight: 100_000 - on },
              ],
            },
            bucketSalt: "s",
            priority: 0,
          },
        ],
      }),
    ]);

  it("ramp 10% → 20%: mọi người đang thấy on vẫn thấy on (I1)", () => {
    const ten = split(10_000);
    const twenty = split(20_000);
    let seen = 0;
    for (let i = 0; i < 5000; i += 1) {
      const ctx = { targetingKey: `user-${String(i)}` };
      if (evaluate(ten, "f", ctx).variant === "on") {
        seen += 1;
        expect(evaluate(twenty, "f", ctx).variant).toBe("on");
      }
    }
    expect(seen).toBeGreaterThan(300);
  });

  it("không giá trị sticky ⇒ bỏ rule phân phối ⇒ DEFAULT; số và boolean qua String()", () => {
    const p = split(100_000, "orgId");
    expect(evaluate(p, "f", {}).reason).toBe("DEFAULT");
    expect(evaluate(p, "f", { orgId: { id: 1 } }).reason).toBe("DEFAULT");
    expect(evaluate(p, "f", { orgId: 42 }).reason).toBe("SPLIT");
    expect(evaluate(p, "f", { targetingKey: "u1" }).reason).toBe("SPLIT");
  });
});

describe("OFREP — một cặp hàm thuần, song ánh trên các trường dây mang", () => {
  const samples: Evaluation[] = [
    { reason: "TARGETING_MATCH", value: 1, variant: "a", ruleId: "r" },
    { reason: "SPLIT", value: { x: 1 }, variant: "b" },
    { reason: "DEFAULT", value: "s", variant: "c" },
    { reason: "DISABLED" },
    { reason: "DISABLED", archived: true },
    { reason: "ERROR", errorCode: "GENERAL", errorMessage: "chi tiết nội bộ" },
  ];

  it("DEFAULT ⇒ STATIC; DISABLED không có value; lỗi không mang chi tiết nội bộ", () => {
    expect(toOfrep("k", samples[2] as Evaluation)).toMatchObject({
      reason: "STATIC",
    });
    expect(toOfrep("k", samples[3] as Evaluation)).not.toHaveProperty("value");
    expect(JSON.stringify(toOfrep("k", samples[5] as Evaluation))).not.toMatch(
      /nội bộ/,
    );
    expect(JSON.stringify(toOfrep("k", samples[0] as Evaluation))).not.toMatch(
      /"r"/,
    );
  });

  it("fromOfrep(toOfrep(e)) = phần dây mang của e", () => {
    for (const e of samples) {
      expect(fromOfrep(toOfrep("k", e))).toEqual(ofrepVisible(e));
    }
  });
});

describe("I33 — lõi không bao giờ ném, với snapshot và context bất kỳ", () => {
  it("fuzz: đầu vào hỏng vẫn cho ra một Evaluation đúng hình", () => {
    fc.assert(
      fc.property(
        fc.anything(),
        fc.anything(),
        fc.anything(),
        (flags, segments, context) => {
          const p = prepareSnapshot({
            flags: flags as Snapshot["flags"],
            segments: segments as Snapshot["segments"],
            trackedFlags: [],
          });
          for (const { evaluation } of evaluateAll(p, context)) {
            expect([
              "TARGETING_MATCH",
              "SPLIT",
              "DEFAULT",
              "DISABLED",
              "ERROR",
            ]).toContain(evaluation.reason);
          }
          expect(evaluate(p, "f", context).reason).toBeDefined();
        },
      ),
      { numRuns: 300 },
    );
  });

  it("fuzz: flag gần đúng (rule/điều kiện ngẫu nhiên) không bao giờ ném", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string(),
            type: fc.constantFrom(
              "ALL",
              "USER_BASED",
              "ATTRIBUTE_BASED",
              "SEGMENT",
              "X",
            ),
            condition: fc.anything(),
            serve: fc.anything(),
            bucketSalt: fc.string(),
            priority: fc.integer(),
          }),
        ),
        fc.dictionary(fc.string(), fc.anything()),
        (rules, context) => {
          const p = snap([flag({ rules: rules as SnapshotFlag["rules"] })]);
          expect(evaluate(p, "f", context).reason).toBeDefined();
        },
      ),
      { numRuns: 300 },
    );
  });
});

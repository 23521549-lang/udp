import type { Prisma } from "@udp/db";
import fc from "fast-check";

/**
 * Bộ sinh của **I26** (§13.3) [v4.7: chuyển từ test của Service 2] — cấu hình flag
 * (rule đủ bốn loại, mọi toán tử, serve một variant hoặc phân phối) và context,
 * dùng chung cho I26 phía Service 2 (lõi trên `/sdk/config`) và phía provider
 * (qua `OpenFeature.getClient()`). Flag sinh ra là STRING với ba variant `a`/`b`/`c`.
 */

export const I26_USERS = ["u1", "u2", "u3", "u4", "u5"] as const;

/** "Nguyễn" — NFC trong rule; context gửi cả NFC lẫn NFD (I2 qua hai đường) */
export const I26_NAME = `Nguy${String.fromCharCode(0x1ec5)}n`;

export type I26VariantKey = "a" | "b" | "c";

/** Serve theo KEY variant — đổi sang id sau khi flag được tạo (id do service sinh) */
export type I26Serve =
  | { kind: "variant"; variant: I26VariantKey }
  | {
      kind: "distribution";
      weights: (readonly [I26VariantKey, number])[];
    };

/** Hai segment cố định mà rule SEGMENT trỏ tới — chèn TRƯỚC khi service nạp cache */
export function i26SegmentConditions(): {
  pro: Prisma.InputJsonObject;
  users: Prisma.InputJsonObject;
} {
  return {
    pro: {
      all: [{ attribute: "plan", operator: "eq", value: "pro" }],
      userIds: [],
    },
    users: { all: [], userIds: ["u2", "u3"] },
  };
}

export function i26Arbitraries(segmentIds: readonly [string, string]) {
  const USERS = [...I26_USERS];
  const NAME = I26_NAME;
  const condition = fc.oneof(
    fc.record({
      attribute: fc.constant("plan"),
      operator: fc.constantFrom("eq", "neq"),
      value: fc.constantFrom("free", "pro"),
    }),
    fc.record({
      attribute: fc.constant("plan"),
      operator: fc.constantFrom("in", "nin"),
      value: fc.subarray(["free", "pro", "team"], { minLength: 1 }),
    }),
    fc.record({
      attribute: fc.constant("age"),
      operator: fc.constantFrom("gt", "gte", "lt", "lte", "eq"),
      value: fc.integer({ min: 0, max: 100 }),
    }),
    fc.record({
      attribute: fc.constant("version"),
      operator: fc.constantFrom("semverGt", "semverLt"),
      value: fc.constantFrom("1.2.3", "2.0.0-rc.1", "2.0.0"),
    }),
    fc.record({
      attribute: fc.constant("email"),
      operator: fc.constantFrom("contains", "startsWith", "endsWith"),
      value: fc.constantFrom("@udp", "a", ".vn"),
    }),
    fc.record({
      attribute: fc.constant("email"),
      operator: fc.constant("regex"),
      value: fc.constantFrom("^[a-z]+@", "\\.vn$"),
    }),
    fc.record({
      attribute: fc.constant("beta"),
      operator: fc.constant("eq"),
      value: fc.boolean(),
    }),
    fc.record({
      attribute: fc.constant("name"),
      operator: fc.constantFrom("eq", "startsWith"),
      value: fc.constant(NAME),
    }),
  );

  /** Serve theo KEY variant — đổi sang id sau khi flag được tạo (id do S2 sinh) */
  const serveArb = fc.oneof(
    fc
      .constantFrom<I26VariantKey>("a", "b", "c")
      .map((k) => ({ kind: "variant" as const, variant: k })),
    fc
      .tuple(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
      )
      .map(([x, y]) => {
        const [lo, hi] = x <= y ? [x, y] : [y, x];
        return {
          kind: "distribution" as const,
          weights: (
            [
              ["a", lo],
              ["b", hi - lo],
              ["c", 100_000 - hi],
            ] as const
          ).filter(([, w]) => w > 0),
        };
      }),
  );

  const ruleArb = fc
    .record({
      ruleType: fc.constantFrom(
        "ALL",
        "USER_BASED",
        "ATTRIBUTE_BASED",
        "SEGMENT",
      ),
      users: fc.subarray(USERS, { minLength: 1 }),
      conditions: fc.array(condition, { minLength: 1, maxLength: 3 }),
      segmentId: fc.constantFrom(...segmentIds),
      serve: serveArb,
    })
    .map((r) => ({
      ruleType: r.ruleType,
      condition:
        r.ruleType === "ALL"
          ? {}
          : r.ruleType === "USER_BASED"
            ? { userIds: r.users }
            : r.ruleType === "ATTRIBUTE_BASED"
              ? { all: r.conditions }
              : { segmentId: r.segmentId },
      serve: r.serve,
    }));

  const toServe = (serve: I26Serve, ids: Record<string, string>) =>
    serve.kind === "variant"
      ? { kind: "variant", variantId: ids[serve.variant] }
      : {
          kind: "distribution",
          weights: serve.weights.map(([k, weight]) => ({
            variantId: ids[k],
            weight,
          })),
        };

  const contextArb = fc.record(
    {
      targetingKey: fc.constantFrom(...USERS, ""),
      plan: fc.constantFrom("free", "pro", "team"),
      age: fc.oneof(fc.integer({ min: 0, max: 100 }), fc.constant("30")),
      version: fc.constantFrom("1.2.3", "1.10.0", "2.0.0-rc.1", "2.0.0", "bad"),
      email: fc.constantFrom("an@udp.vn", "B@x.com", "a@udp.io"),
      beta: fc.boolean(),
      orgId: fc.oneof(fc.integer({ min: 1, max: 9 }), fc.constant("org-1")),
      name: fc.constantFrom(NAME, NAME.normalize("NFD"), "Tran"),
    },
    { requiredKeys: [] },
  );

  return { ruleArb, contextArb, toServe };
}

type RuleArb = ReturnType<typeof i26Arbitraries>["ruleArb"];
export type I26RuleSpec = RuleArb extends fc.Arbitrary<infer R> ? R : never;

/**
 * Ví dụ cố định bảo đảm phép so đi qua MỌI nhánh bất kể seed (SPLIT, TARGETING_MATCH,
 * DISABLED; DEFAULT gần như luôn có) — chốt "mỗi reason xuất hiện" không được đỏ
 * vì may rủi.
 */
export const I26_EXAMPLES: [
  boolean,
  string,
  I26RuleSpec[],
  Record<string, unknown>[],
][] = [
  [
    true,
    "targetingKey",
    [
      {
        ruleType: "ALL",
        condition: {},
        serve: {
          kind: "distribution",
          weights: [
            ["a", 50_000],
            ["b", 50_000],
          ],
        },
      },
    ] as I26RuleSpec[],
    I26_USERS.map((targetingKey) => ({ targetingKey })),
  ],
  [
    true,
    "targetingKey",
    [
      {
        ruleType: "USER_BASED",
        condition: { userIds: ["u1"] },
        serve: { kind: "variant", variant: "c" },
      },
    ] as I26RuleSpec[],
    [{ targetingKey: "u1" }, { targetingKey: "u2" }],
  ],
  [false, "targetingKey", [], [{ targetingKey: "u1" }]],
];

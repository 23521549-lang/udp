import { CONDITION_LIMITS as L } from "@udp/config/constants";
import { createSegmentFields } from "@udp/shared-types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { prepareSnapshot, type Snapshot } from "../src/index.js";

/**
 * R27 — schema GHI của segment và `prepareSnapshot` không được trôi khỏi nhau.
 *
 * Nếu Service 2 nhận một `conditions` mà evaluator đánh dấu `"broken"` thì MỌI
 * lượt đánh giá đi qua một rule SEGMENT trỏ tới nó trả `ERROR`/`GENERAL` ở mọi
 * environment — và không có gì ở đường ghi báo trước. Hai lớp cùng canh điều đó:
 * mỗi giá trị sinh ra vừa phải qua schema GHI, vừa không được thành `"broken"`.
 * Lớp thứ nhất là thứ giữ cho property không tự yếu đi: một arbitrary trôi khỏi
 * schema sẽ sinh giá trị mà cả hai phía cùng từ chối, và khi đó property vẫn
 * xanh trong khi không còn kiểm gì.
 */

const SEG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const attribute = fc.constantFrom(
  "plan",
  "orgId",
  "country",
  "age",
  "beta",
  "version",
  "email",
);
const text = fc.string({ maxLength: 20 });
const nonEmptyText = fc.string({ minLength: 1, maxLength: 20 });
const scalar = fc.oneof(
  text,
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
);
const semver = fc
  .tuple(
    fc.nat({ max: 99 }),
    fc.nat({ max: 99 }),
    fc.nat({ max: 99 }),
    fc.option(fc.constantFrom("alpha", "beta.1", "rc.2", "0.3"), {
      nil: undefined,
    }),
  )
  .map(([major, minor, patch, pre]) => {
    const core = `${String(major)}.${String(minor)}.${String(patch)}`;
    return pre === undefined ? core : `${core}-${pre}`;
  });
/** Pattern an toàn theo `regexSyntaxIssue` — chốt ReDoS nằm ở đường ghi của S2 */
const pattern = fc.constantFrom(
  "^[a-z]+$",
  "^(vn|us)-[0-9]{2}$",
  "beta",
  "^acme\\.",
  "[0-9]+",
);

/** Mười bốn toán tử của §2.2, mỗi cái đúng kiểu `value` của nó */
const conditionArb = fc.oneof(
  fc.record({
    attribute,
    operator: fc.constantFrom("eq" as const, "neq" as const),
    value: scalar,
  }),
  fc.record({
    attribute,
    operator: fc.constantFrom("in" as const, "nin" as const),
    value: fc.array(text, { minLength: 1, maxLength: 5 }),
  }),
  fc.record({
    attribute,
    operator: fc.constantFrom(
      "gt" as const,
      "gte" as const,
      "lt" as const,
      "lte" as const,
    ),
    value: fc.double({ noNaN: true, noDefaultInfinity: true }),
  }),
  fc.record({
    attribute,
    operator: fc.constantFrom(
      "contains" as const,
      "startsWith" as const,
      "endsWith" as const,
    ),
    value: nonEmptyText,
  }),
  fc.record({
    attribute,
    operator: fc.constantFrom("semverGt" as const, "semverLt" as const),
    value: semver,
  }),
  fc.record({
    attribute,
    operator: fc.constant("regex" as const),
    value: pattern,
  }),
);

describe("R27 — mọi conditions qua schema GHI đều KHÔNG broken ở evaluator", () => {
  it("property: 20 điều kiện × 14 toán tử, và userIds bất kỳ", () => {
    fc.assert(
      fc.property(
        fc.array(conditionArb, { maxLength: L.conditionsPerRule }),
        fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 10 }),
        (all, userIds) => {
          const conditions = { all, userIds };
          // Segment phải có ít nhất một điều kiện hoặc một userId (§6.5)
          if (all.length === 0 && userIds.length === 0) return;

          const written = createSegmentFields.shape.conditions.safeParse(
            structuredClone(conditions),
          );
          expect(
            written.success,
            `arbitrary đã trôi khỏi schema GHI: ${JSON.stringify(conditions)}`,
          ).toBe(true);

          const snapshot: Snapshot = {
            flags: [],
            segments: [{ id: SEG, ...conditions }],
            trackedFlags: [],
          };
          expect(prepareSnapshot(snapshot).segments.get(SEG)).not.toBe(
            "broken",
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

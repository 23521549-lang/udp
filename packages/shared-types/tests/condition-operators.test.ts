import { describe, expect, it } from "vitest";
import {
  attributeConditionSchema,
  compareSemver,
  conditionIssue,
  parseSemver,
  readSegmentConditionsSchema,
  regexSyntaxIssue,
  segmentConditionsSchema,
} from "../src/condition.js";

/**
 * [v4.6] Mỗi toán tử đúng MỘT kiểu `value` (§6.5) — trước đây `gt` nhận mảng,
 * `regex` nhận số, `semverGt` nhận "abc", và evaluator phải đoán nghĩa.
 */

const ok = (operator: string, value: unknown) =>
  attributeConditionSchema.safeParse({ attribute: "a", operator, value })
    .success;

describe("điều kiện thuộc tính — kiểu value theo toán tử", () => {
  it("chấp nhận đúng kiểu", () => {
    expect(ok("eq", "vn")).toBe(true);
    expect(ok("eq", 3)).toBe(true);
    expect(ok("neq", false)).toBe(true);
    expect(ok("in", ["a", "b"])).toBe(true);
    expect(ok("gt", 1.5)).toBe(true);
    expect(ok("contains", "x")).toBe(true);
    expect(ok("semverGt", "1.2.3-beta.1+build.5")).toBe(true);
    expect(ok("regex", "^user-[0-9]+$")).toBe(true);
  });

  it("từ chối kiểu lệch — mọi ca mà bản trước nhận", () => {
    expect(ok("gt", ["1"])).toBe(false);
    expect(ok("gt", "5")).toBe(false);
    expect(ok("in", "vn")).toBe(false);
    expect(ok("in", [])).toBe(false);
    expect(ok("eq", ["a"])).toBe(false);
    expect(ok("regex", 5)).toBe(false);
    expect(ok("contains", "")).toBe(false);
    expect(ok("semverGt", "abc")).toBe(false);
    expect(ok("semverLt", "v1.2.3")).toBe(false);
  });

  it("thuộc tính rỗng ⇒ lỗi; toán tử lạ ⇒ lỗi; trường thừa ⇒ lỗi", () => {
    expect(
      attributeConditionSchema.safeParse({
        attribute: "",
        operator: "eq",
        value: 1,
      }).success,
    ).toBe(false);
    expect(ok("like", "x")).toBe(false);
    expect(
      attributeConditionSchema.safeParse({
        attribute: "a",
        operator: "eq",
        value: 1,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("thuộc tính __proto__ bị từ chối — gán nó trên object thường đổi prototype", () => {
    expect(
      attributeConditionSchema.safeParse({
        attribute: "__proto__",
        operator: "eq",
        value: 1,
      }).success,
    ).toBe(false);
  });

  it("NaN/Infinity không phải số hợp lệ cho gt", () => {
    expect(ok("gt", Number.NaN)).toBe(false);
    expect(ok("gt", Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("conditionIssue chỉ ra đúng đường dẫn điều kiện hỏng", () => {
    const issue = conditionIssue("ATTRIBUTE_BASED", {
      all: [
        { attribute: "a", operator: "eq", value: 1 },
        { attribute: "b", operator: "gt", value: "x" },
      ],
    });
    expect(issue).toMatch(/all\.1/);
  });
});

describe("regex — cú pháp an toàn (tầng dùng chung, chạy cả trong SDK)", () => {
  it("backreference và lookaround bị từ chối; lớp ký tự chứa ký tự đó thì không", () => {
    expect(regexSyntaxIssue(String.raw`(a)\1`)).toMatch(/backreference/);
    expect(regexSyntaxIssue(String.raw`(?<n>a)\k<n>`)).toMatch(/backreference/);
    expect(regexSyntaxIssue("a(?=b)")).toMatch(/lookahead/);
    expect(regexSyntaxIssue("(?<!a)b")).toMatch(/lookahead/);
    expect(regexSyntaxIssue("(?<name>a)")).toBeUndefined();
    expect(regexSyntaxIssue("[(?=]")).toBeUndefined();
  });

  it("pattern chưa ở dạng NFC ⇒ lỗi — thứ được kiểm phải là thứ được chạy", () => {
    const acute = String.fromCharCode(0x0301);
    const precomposed = String.fromCharCode(0x00e9);
    // An toàn khi nguyên văn, nhưng NFC biến nó thành (é|é)* — backtracking hàm mũ
    expect(regexSyntaxIssue(`^(e${acute}|${precomposed})*$`)).toMatch(/NFC/);
    expect(regexSyntaxIssue(`^${precomposed}+$`)).toBeUndefined();
  });

  it("không biên dịch được với cờ u ⇒ lỗi", () => {
    expect(regexSyntaxIssue("(")).toMatch(/biên dịch/);
    expect(regexSyntaxIssue(String.raw`\q`)).toMatch(/biên dịch/);
  });
});

describe("SemVer 2.0 — thứ tự ưu tiên §11", () => {
  const cmp = (a: string, b: string): number => {
    const x = parseSemver(a);
    const y = parseSemver(b);
    if (x === undefined || y === undefined) throw new Error(`${a} ${b}`);
    return Math.sign(compareSemver(x, y));
  };

  it("chuỗi ví dụ của semver.org tăng nghiêm ngặt", () => {
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "2.0.0",
      "2.1.0",
      "2.1.1",
    ];
    for (let i = 1; i < chain.length; i += 1) {
      expect(cmp(chain[i - 1] as string, chain[i] as string)).toBe(-1);
    }
  });

  it("build metadata không tham gia; số lớn hơn 2^53 vẫn so đúng", () => {
    expect(cmp("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(cmp("99999999999999999999.0.0", "99999999999999999998.0.0")).toBe(1);
  });

  it("dạng không hợp lệ ⇒ undefined", () => {
    for (const bad of ["1.2", "01.2.3", "1.2.3-", "v1.2.3", "1.2.3-01"]) {
      expect(parseSemver(bad)).toBeUndefined();
    }
  });
});

describe("segment — một hình dạng cho §2.2, §6.5, §9", () => {
  it("ghi: phải có ít nhất một điều kiện hoặc một userId", () => {
    expect(
      segmentConditionsSchema.safeParse({ all: [], userIds: [] }).success,
    ).toBe(false);
    expect(
      segmentConditionsSchema.safeParse({ all: [], userIds: ["u1"] }).success,
    ).toBe(true);
    expect(segmentConditionsSchema.safeParse([]).success).toBe(false);
  });

  it("đọc: cả hai rỗng vẫn đọc được (khớp không ai)", () => {
    expect(
      readSegmentConditionsSchema.safeParse({ all: [], userIds: [] }).success,
    ).toBe(true);
  });
});

import type { FlagVariantWire, RuleWire } from "@udp/shared-types/wire";
import { describe, expect, it } from "vitest";
import {
  changeCount,
  draftsFromWire,
  evenDistribution,
  move,
  newRule,
  ruleProblems,
  setWeight,
  toReplaceBody,
  TOTAL_WEIGHT,
  weightSum,
  withRuleType,
} from "../src/features/flag/rules-model";

const V: FlagVariantWire[] = [
  { id: "11111111-1111-4111-8111-111111111111", key: "on", value: true },
  { id: "22222222-2222-4222-8222-222222222222", key: "off", value: false },
  { id: "33333333-3333-4333-8333-333333333333", key: "maybe", value: false },
];

const SERVER: RuleWire[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    priority: 20,
    ruleType: "USER_BASED",
    condition: { userIds: ["u1"] },
    serve: { kind: "variant", variantId: V[0]!.id },
    description: "beta",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    priority: 10,
    ruleType: "ALL",
    condition: {},
    serve: {
      kind: "distribution",
      weights: [
        { variantId: V[1]!.id, weight: 90_000 },
        { variantId: V[0]!.id, weight: 10_000 },
      ],
    },
    description: null,
  },
];

describe("mô hình rule: danh tính và thứ tự (I1)", () => {
  it("sắp theo priority tăng dần khi nạp", () => {
    expect(draftsFromWire(SERVER).map((d) => d.id)).toEqual([
      SERVER[1]!.id,
      SERVER[0]!.id,
    ]);
  });

  it("PUT mang lại id của rule cũ, rule mới KHÔNG có id, priority theo vị trí", () => {
    const drafts = [...draftsFromWire(SERVER), newRule(V)];
    const body = toReplaceBody(drafts, "2026-09-25T00:00:00.000Z");
    expect(body.lastKnownUpdatedAt).toBe("2026-09-25T00:00:00.000Z");
    expect(body.rules.map((r) => r.id)).toEqual([
      SERVER[1]!.id,
      SERVER[0]!.id,
      undefined,
    ]);
    expect(body.rules.map((r) => r.priority)).toEqual([10, 20, 30]);
    expect("id" in body.rules[2]!).toBe(false);
  });

  it("đổi chỗ không mất id — kéo lên/xuống không xáo nhóm người dùng", () => {
    const moved = move(draftsFromWire(SERVER), 0, 1);
    expect(moved.map((d) => d.id)).toEqual([SERVER[0]!.id, SERVER[1]!.id]);
    expect(move(moved, 0, -1).map((d) => d.id)).toEqual(moved.map((d) => d.id));
  });

  it("đổi loại điều kiện thay điều kiện cũ bằng điều kiện rỗng của loại mới", () => {
    const d = draftsFromWire(SERVER)[1]!;
    expect(withRuleType(d, "SEGMENT").condition).toEqual({ segmentId: "" });
    expect(withRuleType(d, "USER_BASED")).toBe(d);
  });
});

describe("mô hình rule: phân phối", () => {
  it("chia đều ba variant vẫn cộng ĐÚNG 100 000 (phần dư dồn vào variant đầu)", () => {
    const s = evenDistribution(V);
    expect(weightSum(s)).toBe(TOTAL_WEIGHT);
    expect(s.kind === "distribution" && s.weights.map((w) => w.weight)).toEqual(
      [33_334, 33_333, 33_333],
    );
  });

  it("đặt trọng số giữ NGUYÊN thứ tự mảng (§6.4: khoảng chỉ dịch, không đảo)", () => {
    const s = SERVER[1]!.serve;
    const next = setWeight(s, V[0]!.id, 20_000);
    expect(
      next.kind === "distribution" && next.weights.map((w) => w.variantId),
    ).toEqual([V[1]!.id, V[0]!.id]);
    expect(weightSum(next)).toBe(110_000);
  });

  it("tổng khác 100% ⇒ có lỗi ở đúng rule đó, không lưu được", () => {
    const drafts = draftsFromWire(SERVER);
    drafts[0] = {
      ...drafts[0]!,
      serve: setWeight(drafts[0]!.serve, V[0]!.id, 20_000),
    };
    const problems = ruleProblems(drafts, V);
    expect([...problems.keys()]).toEqual([0]);
    expect(problems.get(0)).toContain("100%");
  });

  it("điều kiện sai hình (USER_BASED rỗng) ⇒ có lỗi", () => {
    const d = {
      ...draftsFromWire(SERVER)[1]!,
      ruleType: "USER_BASED" as const,
      condition: { userIds: [] },
    };
    expect(ruleProblems([d], V).get(0)).toContain("Điều kiện");
  });

  it("rule hợp lệ ⇒ không lỗi", () => {
    expect(ruleProblems(draftsFromWire(SERVER), V).size).toBe(0);
  });
});

describe("mô hình rule: đếm thay đổi cho thanh lưu", () => {
  it("không đổi gì ⇒ 0; đổi một mô tả ⇒ 1; thêm một rule ⇒ +1", () => {
    const drafts = draftsFromWire(SERVER);
    expect(changeCount(drafts, SERVER)).toBe(0);
    drafts[0] = { ...drafts[0]!, description: "khác" };
    expect(changeCount(drafts, SERVER)).toBe(1);
    expect(changeCount([...drafts, newRule(V)], SERVER)).toBe(2);
  });

  it("mô tả chỉ khác khoảng trắng không tính là thay đổi", () => {
    const drafts = draftsFromWire(SERVER);
    drafts[1] = { ...drafts[1]!, description: "  beta " };
    expect(changeCount(drafts, SERVER)).toBe(0);
  });
});

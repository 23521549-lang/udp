import {
  conditionIssue,
  type AttributeCondition,
  type RuleType,
} from "@udp/shared-types/condition";
import type { ReplaceRulesFields } from "@udp/shared-types/flag-api";
import type { FlagVariantWire, RuleWire } from "@udp/shared-types/wire";

/**
 * Mô hình của trình sửa rule — hàm thuần, để phần dễ sai nhất (thứ tự, phân phối, danh
 * tính rule) được test không cần DOM.
 *
 * Ba bất biến mà trình sửa phải giữ:
 *
 * 1. **Danh tính rule (I1).** Rule đang có mang `id` của nó về server; server giữ nguyên
 *    `bucket_salt` theo `id`. Mất `id` (dựng lại rule từ đầu khi sửa) là xáo lại nhóm
 *    người dùng — một lần sửa trọng số thành một lần rollout ngoài ý muốn.
 * 2. **Thứ tự là ưu tiên.** Rule xét từ trên xuống; `priority` sinh lại theo vị trí lúc
 *    lưu, nên kéo lên/xuống là thứ duy nhất người dùng phải nghĩ.
 * 3. **Phân phối cộng đủ 100%.** Trọng số tính theo đơn vị 0,001% (`TOTAL_BUCKETS` =
 *    100 000), và `weights` KHÔNG BAO GIỜ bị sắp lại — §6.4: khoảng tích luỹ chỉ dịch,
 *    không đảo.
 */

export const TOTAL_WEIGHT = 100_000;

export type Serve = RuleWire["serve"];

export interface RuleDraft {
  /** Khoá cục bộ cho React — KHÔNG gửi lên server */
  localKey: string;
  /** Có ⇒ rule đang có trên server (giữ `bucket_salt`); không ⇒ rule mới */
  id?: string;
  ruleType: RuleType;
  condition: unknown;
  serve: Serve;
  description: string | null;
}

let counter = 0;
const nextKey = (): string => `r${String(++counter)}`;

export function draftsFromWire(rules: readonly RuleWire[]): RuleDraft[] {
  return [...rules]
    .sort((a, b) => a.priority - b.priority)
    .map((r) => ({
      localKey: r.id,
      id: r.id,
      ruleType: r.ruleType,
      condition: r.condition,
      serve: r.serve,
      description: r.description,
    }));
}

export function emptyCondition(ruleType: RuleType): unknown {
  switch (ruleType) {
    case "ALL":
      return {};
    case "USER_BASED":
      return { userIds: [] };
    case "ATTRIBUTE_BASED":
      return {
        all: [{ attribute: "", operator: "eq", value: "" }],
      } satisfies { all: AttributeCondition[] };
    case "SEGMENT":
      return { segmentId: "" };
  }
}

export function newRule(variants: readonly FlagVariantWire[]): RuleDraft {
  const first = variants[0];
  return {
    localKey: nextKey(),
    ruleType: "ATTRIBUTE_BASED",
    condition: emptyCondition("ATTRIBUTE_BASED"),
    serve: { kind: "variant", variantId: first?.id ?? "" },
    description: null,
  };
}

/** Đổi loại "ai khớp" — điều kiện cũ không hợp với loại mới nên được thay bằng rỗng */
export const withRuleType = (rule: RuleDraft, ruleType: RuleType): RuleDraft =>
  ruleType === rule.ruleType
    ? rule
    : { ...rule, ruleType, condition: emptyCondition(ruleType) };

export function move(
  drafts: readonly RuleDraft[],
  index: number,
  delta: -1 | 1,
): RuleDraft[] {
  const target = index + delta;
  if (target < 0 || target >= drafts.length) return [...drafts];
  const out = [...drafts];
  const a = out[index];
  const b = out[target];
  if (a === undefined || b === undefined) return out;
  out[index] = b;
  out[target] = a;
  return out;
}

// ------------------------------------------------------------- phân phối

export const percentOf = (weight: number): number => weight / 1000;
export const weightOf = (percent: number): number => Math.round(percent * 1000);

/** Chia đều, phần dư dồn vào variant ĐẦU — tổng luôn đúng 100 000 */
export function evenDistribution(variants: readonly FlagVariantWire[]): Serve {
  const n = Math.max(1, variants.length);
  const base = Math.floor(TOTAL_WEIGHT / n);
  const rest = TOTAL_WEIGHT - base * n;
  return {
    kind: "distribution",
    weights: variants.map((v, i) => ({
      variantId: v.id,
      weight: base + (i === 0 ? rest : 0),
    })),
  };
}

/** Đặt trọng số của MỘT variant; giữ nguyên thứ tự mảng (§6.4) */
export function setWeight(
  serve: Serve,
  variantId: string,
  weight: number,
): Serve {
  if (serve.kind !== "distribution") return serve;
  const clamped = Math.max(0, Math.min(TOTAL_WEIGHT, Math.round(weight)));
  return {
    kind: "distribution",
    weights: serve.weights.map((w) =>
      w.variantId === variantId ? { ...w, weight: clamped } : w,
    ),
  };
}

export const weightSum = (serve: Serve): number =>
  serve.kind === "distribution"
    ? serve.weights.reduce((acc, w) => acc + w.weight, 0)
    : TOTAL_WEIGHT;

// ------------------------------------------------------------- kiểm và gửi

/** Lỗi theo từng rule (chỉ số → câu), rỗng là lưu được */
export function ruleProblems(
  drafts: readonly RuleDraft[],
  variants: readonly FlagVariantWire[],
): Map<number, string> {
  const known = new Set(variants.map((v) => v.id));
  const out = new Map<number, string>();
  drafts.forEach((rule, i) => {
    const issue = conditionIssue(rule.ruleType, rule.condition);
    if (issue !== undefined) {
      out.set(i, `Điều kiện chưa hợp lệ: ${issue}`);
      return;
    }
    if (rule.serve.kind === "variant") {
      if (!known.has(rule.serve.variantId)) out.set(i, "Chưa chọn variant");
      return;
    }
    const sum = weightSum(rule.serve);
    if (sum !== TOTAL_WEIGHT) {
      out.set(
        i,
        `Tổng phân phối phải bằng 100%, đang là ${String(percentOf(sum))}%`,
      );
    } else if (rule.serve.weights.some((w) => !known.has(w.variantId))) {
      out.set(i, "Phân phối trỏ tới variant không còn tồn tại");
    }
  });
  return out;
}

/** Body của `PUT .../rules` — `priority` sinh lại theo vị trí */
export function toReplaceBody(
  drafts: readonly RuleDraft[],
  lastKnownUpdatedAt: string,
): ReplaceRulesFields {
  return {
    lastKnownUpdatedAt,
    rules: drafts.map((r, i) => ({
      ...(r.id === undefined ? {} : { id: r.id }),
      ruleType: r.ruleType,
      condition: r.condition,
      serve: r.serve,
      priority: (i + 1) * 10,
      description:
        r.description === null || r.description.trim() === ""
          ? null
          : r.description.trim(),
    })),
  };
}

const signature = (r: {
  id?: string | undefined;
  ruleType: string;
  condition: unknown;
  serve: unknown;
  description: string | null;
}): string =>
  JSON.stringify([
    r.id ?? null,
    r.ruleType,
    r.condition,
    r.serve,
    r.description === null || r.description.trim() === ""
      ? null
      : r.description.trim(),
  ]);

/** Số thay đổi so với server — cho thanh lưu "N thay đổi ở {env}" (DESIGN.md §6) */
export function changeCount(
  drafts: readonly RuleDraft[],
  server: readonly RuleWire[],
): number {
  const base = draftsFromWire(server);
  let n = Math.abs(drafts.length - base.length);
  const len = Math.min(drafts.length, base.length);
  for (let i = 0; i < len; i += 1) {
    const a = drafts[i];
    const b = base[i];
    if (a !== undefined && b !== undefined && signature(a) !== signature(b)) {
      n += 1;
    }
  }
  return n;
}

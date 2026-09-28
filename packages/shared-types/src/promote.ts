import type { ReplaceRulesFields } from "./flag-api.js";
import type { RuleWire } from "./wire.js";

/**
 * Sao chép rule từ một env sang env khác (§10.12 "Promote config dev → staging") — MỘT hàm cho
 * hai phía [v4.11, Plan #44]: Portal dựng diff để người dùng xem, Service 1 dựng lại đúng kế
 * hoạch đó trên dữ liệu đọc trong lời gọi `POST …/promote` rồi áp. Hai bản chép là hai cách hiểu
 * "diff đã xem" và "thứ được ghi".
 *
 * Bất biến quyết định cách khớp là **I1**: rule ở env đích mang `bucket_salt` của nó; server giữ
 * salt khi PUT gửi lại ĐÚNG `id` đó. Nên:
 *
 * - Rule nguồn KHỚP một rule đích (cùng loại, cùng điều kiện) ⇒ gửi `id` của rule ĐÍCH: nhóm
 *   người dùng ở env đích không bị xáo, chỉ `serve` (trọng số) đổi — đúng như một lần ramp.
 * - Không khớp ⇒ rule MỚI, không `id` (server sinh salt mới).
 * - Rule đích không được khớp ⇒ bị bỏ.
 * - `id` của rule NGUỒN không bao giờ được gửi: nó thuộc env-config khác, và dùng nó là mượn salt
 *   của env khác — người dùng của env đích bị xếp theo nhóm của env nguồn.
 *
 * Chỉ rule được chép. Bật/tắt và variant mặc định là quyết định riêng của từng env.
 */

export type PromotionDiffKind = "same" | "changed" | "added" | "removed";

export interface PromotionDiffLine {
  kind: PromotionDiffKind;
  /** Vị trí trong danh sách MỚI (removed: vị trí cũ ở đích) */
  index: number;
  ruleType: RuleWire["ruleType"];
  description: string | null;
  /** Rule đích được giữ (salt giữ) — không có với added/removed */
  keptId?: string;
}

export interface PromotionPlan {
  /** Thân `PUT …/rules` cho env ĐÍCH, mang mốc lock của đích */
  body: ReplaceRulesFields;
  diff: PromotionDiffLine[];
  /** Số dòng khác `same` — 0 thì không có gì để áp */
  changes: number;
}

/** JSON với khoá sắp xếp — so điều kiện theo nghĩa, không theo thứ tự khoá */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const whoKey = (rule: RuleWire): string =>
  `${rule.ruleType}|${stableJson(rule.condition)}`;

const byPriority = (rules: readonly RuleWire[]): RuleWire[] =>
  [...rules].sort((a, b) => a.priority - b.priority);

/** Mô tả rỗng hay chỉ khoảng trắng gửi đi là `null` — cùng luật với trình sửa rule của Portal */
const cleanDescription = (description: string | null): string | null =>
  description === null || description.trim() === "" ? null : description.trim();

export function planPromotion(
  source: readonly RuleWire[],
  target: readonly RuleWire[],
  targetUpdatedAt: string,
): PromotionPlan {
  const dst = byPriority(target);
  const used = new Set<string>();
  const diff: PromotionDiffLine[] = [];

  const rules = byPriority(source).map((rule, index) => {
    const next = {
      ruleType: rule.ruleType,
      condition: rule.condition,
      serve: rule.serve,
      priority: (index + 1) * 10,
      description: cleanDescription(rule.description),
    };
    const key = whoKey(rule);
    const match = dst.find((t) => !used.has(t.id) && whoKey(t) === key);
    if (match === undefined) {
      diff.push({
        kind: "added",
        index,
        ruleType: rule.ruleType,
        description: rule.description,
      });
      return next;
    }
    used.add(match.id);
    const same =
      stableJson(match.serve) === stableJson(rule.serve) &&
      match.description === rule.description &&
      dst.indexOf(match) === index;
    diff.push({
      kind: same ? "same" : "changed",
      index,
      ruleType: rule.ruleType,
      description: rule.description,
      keptId: match.id,
    });
    return { id: match.id, ...next };
  });

  dst.forEach((t, index) => {
    if (!used.has(t.id)) {
      diff.push({
        kind: "removed",
        index,
        ruleType: t.ruleType,
        description: t.description,
      });
    }
  });

  return {
    body: { lastKnownUpdatedAt: targetUpdatedAt, rules },
    diff,
    changes: diff.filter((d) => d.kind !== "same").length,
  };
}

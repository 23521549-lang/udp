import type { ReplaceRulesFields } from "@udp/shared-types/flag-api";
import type { RuleWire } from "@udp/shared-types/wire";
import { draftsFromWire, toReplaceBody } from "./rules-model";

/**
 * Sao chép rule từ một env sang env khác (§10.12 "Promote config dev → staging").
 *
 * Bất biến quyết định cách khớp là **I1**: rule ở env đích mang `bucket_salt` của nó;
 * server giữ salt khi PUT gửi lại ĐÚNG `id` đó (`rule-replace.integration.test.ts`). Nên:
 *
 * - Rule nguồn KHỚP một rule đích (cùng loại, cùng điều kiện) ⇒ gửi `id` của rule ĐÍCH:
 *   nhóm người dùng ở env đích không bị xáo, chỉ `serve` (trọng số) đổi — đúng như một
 *   lần ramp.
 * - Không khớp ⇒ rule MỚI, không `id` (server sinh salt mới).
 * - Rule đích không được khớp ⇒ bị bỏ.
 * - `id` của rule NGUỒN không bao giờ được gửi: nó thuộc env-config khác, và dùng nó là
 *   mượn salt của env khác — người dùng của env đích bị xếp theo nhóm của env nguồn.
 *
 * Chỉ rule được chép. Bật/tắt và variant mặc định là quyết định riêng của từng env.
 */

export type DiffKind = "same" | "changed" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  /** Vị trí trong danh sách MỚI (removed: vị trí cũ ở đích) */
  index: number;
  ruleType: string;
  description: string | null;
  /** Rule đích được giữ (salt giữ) — undefined với added/removed */
  keptId?: string;
}

export interface PromotionPlan {
  body: ReplaceRulesFields;
  diff: DiffLine[];
  /** Không có thay đổi nào thì không nên cho bấm áp */
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

const whoKey = (r: RuleWire): string =>
  `${r.ruleType}|${stableJson(r.condition)}`;

export function planPromotion(
  source: readonly RuleWire[],
  target: readonly RuleWire[],
  targetUpdatedAt: string,
): PromotionPlan {
  const src = draftsFromWire(source);
  const dst = [...target].sort((a, b) => a.priority - b.priority);
  const used = new Set<string>();
  const diff: DiffLine[] = [];

  const drafts = src.map((rule, index) => {
    const wire = source.find((s) => s.id === rule.id);
    const key = wire === undefined ? "" : whoKey(wire);
    const match = dst.find((t) => !used.has(t.id) && whoKey(t) === key);
    if (match === undefined) {
      diff.push({
        kind: "added",
        index,
        ruleType: rule.ruleType,
        description: rule.description,
      });
      // Bỏ `id` NGUỒN: rule mới ở đích
      const { id: _sourceId, ...rest } = rule;
      return rest;
    }
    used.add(match.id);
    const dstIndex = dst.indexOf(match);
    const same =
      stableJson(match.serve) === stableJson(rule.serve) &&
      (match.description ?? null) === (rule.description ?? null) &&
      dstIndex === index;
    diff.push({
      kind: same ? "same" : "changed",
      index,
      ruleType: rule.ruleType,
      description: rule.description,
      keptId: match.id,
    });
    return { ...rule, id: match.id };
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
    body: toReplaceBody(drafts, targetUpdatedAt),
    diff,
    changes: diff.filter((d) => d.kind !== "same").length,
  };
}

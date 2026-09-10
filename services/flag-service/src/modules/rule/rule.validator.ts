import type { Prisma } from "@udp/db";
import { canonicalJson } from "@udp/flag-evaluator";
import { UnprocessableError } from "@udp/http";
import { canonicalizeServe } from "@udp/shared-types";
import * as repository from "./rule.repository.js";
import type { PublicRule, RuleInput } from "./rule.types.js";

/**
 * Kiểm rule TRƯỚC khi ghi — §3.2 `rule.validator.ts`: "variantId thuộc flag?
 * tổng weight = 100 000? condition đúng schema?".
 *
 * Ba câu hỏi đó được trả lời ở ba tầng khác nhau, và việc chia tầng là có chủ ý:
 *
 *   - **Tổng weight, variant không trùng, `condition` đúng schema** — kiểm ở
 *     `replaceRulesSchema`, trước khi chạm database.
 *   - **`variantId` thuộc flag** — KHÔNG kiểm ở đây. Trigger `UDP01` đã cưỡng
 *     chế nó ở database cho MỌI writer, kể cả kill-switch của Service 3 vốn
 *     không đi qua Zod (I39). Viết lại ở tầng ứng dụng là tạo bản cài đặt thứ
 *     hai của cùng một luật, và hai bản thì trôi khỏi nhau. Thông điệp của
 *     trigger đã nói rõ variant NÀO sai, nên người dùng không mất gì.
 *   - **Segment thuộc cùng project** — kiểm ở ĐÂY, vì database KHÔNG canh được:
 *     `condition` là JSONB nên không đặt khoá ngoại được, và §2.2 nói segment
 *     thuộc project, dùng chung mọi environment.
 */
export async function assertSegmentsInProject(
  tx: Prisma.TransactionClient,
  projectId: string,
  rules: readonly RuleInput[],
): Promise<void> {
  const wanted = rules.flatMap((r) =>
    r.ruleType === "SEGMENT"
      ? [(r.condition as { segmentId: string }).segmentId]
      : [],
  );
  if (wanted.length === 0) return;

  const found = await repository.segmentsInProject(tx, projectId, wanted);
  const missing = wanted.filter((id) => !found.has(id));

  if (missing.length > 0) {
    throw new UnprocessableError(
      `Segment không thuộc project của flag: ${missing.join(", ")}`,
    );
  }
}

/**
 * Đưa `weights` về thứ tự chuẩn TRƯỚC khi so và trước khi ghi.
 *
 * Trước khi so: nếu không, một request gửi đúng rule cũ nhưng `weights` theo
 * thứ tự khác bị coi là "đổi", và với rule đang có rollout thì thành 409 cho một
 * thay đổi không tồn tại. Trước khi ghi: §6.4 — thứ tự cố định theo `variantId`.
 */
export const canonicalRules = (rules: readonly RuleInput[]): RuleInput[] =>
  rules.map((r) => ({ ...r, serve: canonicalizeServe(r.serve) }));

export interface RulePlan {
  create: RuleInput[];
  update: { id: string; next: RuleInput; trafficChanged: boolean }[];
  remove: string[];
}

/**
 * Đối chiếu danh sách gửi lên với danh sách đang có.
 *
 * `trafficChanged` tách "đổi mô tả" khỏi mọi thay đổi khác. Với rule đang bị
 * rollout giữ, sửa mô tả là vô hại, còn đổi `ruleType`, `condition`, `serve` hay
 * `priority` là đổi AI được phục vụ GÌ — tức giằng quyền điều khiển traffic với
 * Service 3.
 */
export function planRules(
  existing: readonly PublicRule[],
  incoming: readonly RuleInput[],
): RulePlan {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const plan: RulePlan = { create: [], update: [], remove: [] };

  for (const next of incoming) {
    if (next.id === undefined) {
      plan.create.push(next);
      continue;
    }

    const current = byId.get(next.id);
    /**
     * Một `id` không thuộc env-config này bị TỪ CHỐI, không bị coi là rule mới.
     *
     * Coi nó là rule mới thì một id của env-config khác "được chuyển" sang đây —
     * và với id của `prod` gửi vào `dev`, đó là đường vòng qua I14.
     */
    if (current === undefined) {
      throw new UnprocessableError(
        `Rule ${next.id} không thuộc cấu hình flag theo environment này`,
      );
    }

    const trafficChanged =
      current.ruleType !== next.ruleType ||
      current.priority !== next.priority ||
      canonicalJson(current.condition) !== canonicalJson(next.condition) ||
      canonicalJson(current.serve) !== canonicalJson(next.serve);
    const descriptionChanged =
      (current.description ?? null) !== (next.description ?? null);

    if (trafficChanged || descriptionChanged) {
      plan.update.push({ id: next.id, next, trafficChanged });
    }
    byId.delete(next.id);
  }

  plan.remove = [...byId.keys()];
  return plan;
}

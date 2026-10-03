import type { CreatedResource, ResourceStep } from "../cloud.js";
import type { ResolvedCredential } from "../credential.js";
import type { ProvisionedResourceRow } from "../ledger.js";

/**
 * [v4.11] Tài nguyên của một pha ĐÃ XONG, dựng lại cho `RunPlan.inherited` khi resume
 * (Plan #28 QĐ-3).
 *
 * Nguồn là sổ (hàng `READY` có `provider_id`) nhưng giá trị là của CLOUD: mỗi step được hỏi
 * lại bằng chính `lookupById` của nó. Dựng `CreatedResource` từ hàng sổ là đoán — sổ không
 * có tag, không có thời điểm tạo, và một id mà cloud không còn biết là cha chết của pha
 * sau. Pha trước chưa trọn (thiếu hàng, hàng chưa READY, cloud không thấy) ⇒ ném: chạy pha
 * sau trên nền thiếu là tạo cluster trỏ vào subnet không tồn tại.
 */
export class InheritedPhaseIncompleteError extends Error {
  readonly code = "INHERITED_PHASE_INCOMPLETE";
  constructor(
    readonly stepName: string,
    reason: string,
  ) {
    super(`pha trước chưa trọn ở step ${stepName}: ${reason}`);
    this.name = "InheritedPhaseIncompleteError";
  }
}

export async function inheritFromLedger(args: {
  steps: readonly ResourceStep[];
  rows: readonly ProvisionedResourceRow[];
  credential: ResolvedCredential;
}): Promise<Record<string, CreatedResource>> {
  const byKey = new Map(args.rows.map((r) => [r.idempotencyKey, r]));
  const out: Record<string, CreatedResource> = {};
  for (const step of args.steps) {
    const row = byKey.get(step.idempotencyKey);
    if (
      row === undefined ||
      row.status !== "READY" ||
      row.providerId === null
    ) {
      throw new InheritedPhaseIncompleteError(
        step.name,
        row === undefined ? "không có hàng sổ" : `hàng ở ${row.status}`,
      );
    }
    const outcome = await step.lookupById(args.credential, row.providerId);
    if (outcome.kind !== "found") {
      throw new InheritedPhaseIncompleteError(
        step.name,
        outcome.kind === "absent"
          ? `cloud không còn ${row.providerId}`
          : `tra cứu bất định: ${outcome.reason}`,
      );
    }
    out[step.name] = outcome.resource;
  }
  return out;
}

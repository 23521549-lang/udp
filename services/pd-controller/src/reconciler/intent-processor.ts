import type { PrismaClient } from "@udp/db";
import {
  markProcessedOrThrow,
  recordExecution,
} from "../rollout-session/event.repository.js";
import { updateIfVersion } from "../rollout-session/session.repository.js";
import type { IntentRow, SessionRow } from "../rollout-session/types.js";
import type { Fence } from "./fence.js";

/**
 * Ý định của người dùng (§7.6) — luôn xử lý TRƯỚC phân tích metrics, kể cả khi
 * session đang PAUSED (I27; SQL claim của v3 bỏ sót PAUSED nên RESUME/ROLLBACK
 * trên session tạm dừng không bao giờ chạy).
 *
 * Hai loại intent, hai đường:
 *   - PAUSE / RESUME chỉ đổi trạng thái — không side effect, một transaction:
 *     `updateIfVersion` + event thực thi + `processed_at`.
 *   - PROMOTE / ROLLBACK cần áp traffic lên S2 TRƯỚC (fence → PATCH → DB sau),
 *     nên reconciler thực hiện qua đúng đường `promote`/`rollback` của nó và chỉ
 *     truyền `causedByEventId`. File này chỉ quyết định "làm gì", không tự PATCH.
 */

export type IntentPlan =
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "promote-full" }
  | { kind: "rollback" }
  | { kind: "ignore"; reason: string };

export function planIntent(session: SessionRow, intent: IntentRow): IntentPlan {
  switch (intent.action) {
    case "PAUSE":
      return session.status === "PAUSED"
        ? { kind: "ignore", reason: "session đã PAUSED" }
        : { kind: "pause" };
    case "RESUME":
      return session.status === "PAUSED"
        ? { kind: "resume" }
        : {
            kind: "ignore",
            reason: `session đang ${session.status}, không có gì để resume`,
          };
    case "PROMOTE":
      return { kind: "promote-full" };
    case "ROLLBACK":
      return { kind: "rollback" };
  }
}

/**
 * PAUSE/RESUME/bỏ qua — chuyển trạng thái không side effect, trong MỘT transaction
 * cùng dấu `processed_at`: hoặc cả ba cùng commit, hoặc không gì cả.
 */
export async function applyStatusIntent(
  db: PrismaClient,
  session: SessionRow,
  fence: Fence,
  intent: IntentRow,
  plan: Extract<IntentPlan, { kind: "pause" | "resume" | "ignore" }>,
): Promise<boolean> {
  fence.assert();
  return db.$transaction(async (tx) => {
    if (plan.kind !== "ignore") {
      const ok = await updateIfVersion(tx, session.id, fence.version, {
        status: plan.kind === "pause" ? "PAUSED" : "IN_PROGRESS",
      });
      if (!ok) return false;
      await recordExecution(tx, {
        sessionId: session.id,
        action: plan.kind === "pause" ? "PAUSE" : "RESUME",
        trafficPercentage: session.currentTrafficPercentage,
        triggeredBy: "MANUAL",
        causedByEventId: intent.id,
      });
    }
    // Intent vô nghĩa vẫn được đánh dấu: không thì vòng nào cũng nhặt lại nó
    await markProcessedOrThrow(tx, intent.id);
    return true;
  });
}

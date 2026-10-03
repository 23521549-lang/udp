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
  /** Về `PENDING` khi rollout chưa từng áp bậc nào — xem `planIntent` */
  | { kind: "resume"; to: "IN_PROGRESS" | "PENDING" }
  | { kind: "promote-full" }
  | { kind: "rollback" }
  /** [v4.4] ROLLBACK trên rollout chưa áp bậc nào: đóng, không đụng traffic */
  | { kind: "cancel" }
  | { kind: "ignore"; reason: string };

/**
 * Rollout chưa từng đổi traffic: PENDING, hoặc PAUSED mà `last_step_at` NULL
 * (PAUSED-từ-PENDING — bậc đầu của `start()` là lần đầu `last_step_at` được đặt).
 * IN_PROGRESS luôn đã áp ít nhất một bậc: chỉ `stepUp` đưa session vào đó.
 *
 * [v4.4] Ba intent đổi nghĩa ở trạng thái này (§7.6 dòng PENDING). Service 1 đã
 * chỉ nhận ROLLBACK khi PENDING; đây là lớp thứ hai, cho hàng ghi trước khi S1 có
 * luật đó và cho PAUSED-từ-PENDING:
 *   - RESUME về PENDING, không về IN_PROGRESS: IN_PROGRESS đi thẳng vào phân tích,
 *     vượt cổng probe pha 2 và ramp từ `current_traffic_percentage` thay vì đi qua
 *     `start()` — đúng thứ "không bao giờ chạy mù" cấm.
 *   - PROMOTE bị bỏ qua: đẩy 100% một rollout chưa từng thấy nhãn `ff` là chạy mù
 *     bằng tay; người dùng huỷ rồi tạo lại khi app đã sẵn sàng.
 *   - ROLLBACK là HUỶ: không có bậc nào để lùi, và PATCH về baseline khi traffic
 *     vốn đang ở baseline chỉ tạo một DeploymentEvent(ROLLBACK) giả làm lệch
 *     change-failure-rate của DORA (§8.5 E10).
 */
const neverStepped = (session: SessionRow): boolean =>
  session.status === "PENDING" ||
  (session.status === "PAUSED" && session.lastStepAt === null);

export function planIntent(session: SessionRow, intent: IntentRow): IntentPlan {
  switch (intent.action) {
    case "PAUSE":
      return session.status === "PAUSED"
        ? { kind: "ignore", reason: "session đã PAUSED" }
        : { kind: "pause" };
    case "RESUME":
      return session.status === "PAUSED"
        ? {
            kind: "resume",
            to: neverStepped(session) ? "PENDING" : "IN_PROGRESS",
          }
        : {
            kind: "ignore",
            reason: `session đang ${session.status}, không có gì để resume`,
          };
    case "PROMOTE":
      return neverStepped(session)
        ? {
            kind: "ignore",
            reason:
              "rollout chưa bắt đầu (chưa thấy nhãn ff) — không promote mù; huỷ rồi tạo lại",
          }
        : { kind: "promote-full" };
    case "ROLLBACK":
      return neverStepped(session) ? { kind: "cancel" } : { kind: "rollback" };
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
        status: plan.kind === "pause" ? "PAUSED" : plan.to,
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

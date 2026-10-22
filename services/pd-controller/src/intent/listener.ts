import {
  createListenAccelerator,
  type ListenAccelerator,
  type ListenTiming,
  type SessionConnector,
} from "@udp/db";
import { logger } from "@udp/http";
import {
  parseRolloutIntentNotice,
  ROLLOUT_INTENT_CHANNEL,
} from "@udp/shared-types";
import { SERVICE_ROLE } from "../core/db.js";

/**
 * Kênh `LISTEN rollout_intent` (§7.6 [v4.3]) — Service 1 phát khi ghi intent,
 * Service 3 xử lý session đó NGAY thay vì chờ vòng quét (≤ 5 giây ⇒ ~0,5 giây,
 * đo 12/09/2026 qua pooler).
 *
 * Chỉ đánh thức: reconciler vẫn claim lease và đọc intent từ `rollout_events`,
 * nên notice giả, trùng hay mất chỉ tốn một lượt thừa hoặc chậm một vòng. Máy
 * trạng thái của kênh là `createListenAccelerator` dùng chung với tầng 3 của S2.
 */
export interface IntentListenerDeps {
  connect: SessionConnector;
  /** `Reconciler.wake` — qua cùng semaphore với vòng quét */
  onIntent: (sessionId: string) => void;
  /** Vừa nghe được: intent ghi lúc kênh vắng đã mất notice, nên quét một lượt */
  onListening: () => void;
  timing?: ListenTiming;
}

export function createIntentListener({
  onIntent,
  ...deps
}: IntentListenerDeps): ListenAccelerator {
  return createListenAccelerator({
    ...deps,
    expectedRole: SERVICE_ROLE,
    channel: ROLLOUT_INTENT_CHANNEL,
    label: "rollout_intent",
    logger,
    onNotice: (payload) => {
      const notice = parseRolloutIntentNotice(payload);
      // Mọi role nối được database đều phát được lên kênh — rác chỉ ghi debug
      if (notice === null) {
        logger.debug(
          { channel: ROLLOUT_INTENT_CHANNEL },
          "Bỏ qua notice rollout_intent sai hình dạng",
        );
        return;
      }
      onIntent(notice.sessionId);
    },
  });
}

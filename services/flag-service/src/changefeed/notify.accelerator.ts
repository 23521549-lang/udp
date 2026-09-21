import {
  createListenAccelerator,
  type ListenAccelerator,
  type ListenTiming,
  type SessionConnector,
} from "@udp/db";
import { logger } from "@udp/http";
import {
  CONFIG_CHANGE_CHANNEL,
  parseConfigChangeNotice,
} from "@udp/shared-types/change-feed";

/**
 * TẦNG 3 — đánh thức vòng poll bằng `NOTIFY` (ADR-05).
 *
 * Đúng như ADR-05 khai: "ĐÁNH THỨC vòng poll, không mang dữ liệu". Notice chỉ nói
 * "environment X vừa lên version N"; dữ liệu vẫn đi đường tầng 1 + 2, nên mọi bảo
 * đảm của hai tầng đó giữ nguyên. Mất tầng này thì hệ thống về ĐÚNG hành vi không
 * có nó — chậm hơn (≤ 700ms thay vì ~150–190ms), không sai hơn.
 *
 * Máy trạng thái của kênh (nối lại, ping, sai role) nằm ở `createListenAccelerator`
 * của `@udp/db` [v4.3], dùng chung với kênh `rollout_intent` của Service 3. File
 * này chỉ giữ phần riêng của tầng 3: đọc notice và lọc theo environment đang giữ.
 */

export type NotifyAccelerator = ListenAccelerator;

export interface NotifyAcceleratorDeps {
  connect: SessionConnector;
  expectedRole: string;
  /** Replica này có đang giữ environment đó không — `SnapshotCache.holds` */
  holds: (environmentId: string) => boolean;
  /** `VersionWatcher.wake` — tự gộp nhiều lần gọi, không bao giờ chồng vòng */
  wake: () => void;
  timing?: ListenTiming;
  random?: () => number;
}

export function createNotifyAccelerator({
  holds,
  wake,
  ...channel
}: NotifyAcceleratorDeps): NotifyAccelerator {
  return createListenAccelerator({
    ...channel,
    channel: CONFIG_CHANGE_CHANNEL,
    label: "tầng 3",
    logger,
    onNotice: (payload) => {
      const notice = parseConfigChangeNotice(payload);
      /**
       * Payload rác chỉ ghi ở mức debug. PostgreSQL không có quyền trên `NOTIFY`:
       * mọi role nối được database đều phát được lên kênh này, nên cảnh báo từng
       * cái là trao vòi xả log cho bất kỳ ai. Bỏ qua thì không mất gì — tầng 1 vẫn
       * bắt mọi thay đổi.
       */
      if (notice === null) {
        logger.debug(
          { channel: CONFIG_CHANGE_CHANNEL },
          "Bỏ qua notice sai hình dạng của tầng 3",
        );
        return;
      }
      // Mọi lần ghi trên MỌI project đều tới đây; chỉ đánh thức vì env replica này giữ
      if (holds(notice.environmentId)) wake();
    },
    onListening: wake,
  });
}

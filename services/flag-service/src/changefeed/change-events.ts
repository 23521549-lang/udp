import { logger } from "@udp/http";
import type { ChangeRecord } from "./change-feed.interface.js";
import type { ConfigEntry } from "./snapshot.cache.js";

/**
 * Sự kiện "cấu hình của một `(environment, keyType)` vừa đổi" — từ watcher ra ngoài.
 *
 * Vì sao một kênh riêng thay vì để `sdk/` gọi thẳng watcher: hướng phụ thuộc là
 * `sdk → changefeed`, không bao giờ ngược lại. Watcher không biết có ai nghe; ai cần
 * — hôm nay là hub SSE — tự đăng ký.
 *
 * Hai loại, đúng bằng hai cách cache đổi:
 *   - `delta`: tầng 2 vừa áp `records` lên `previous` và ra `next`.
 *   - `snapshot`: vừa nạp lại cả bộ ba — rơi tầng, chế độ `snapshot`, hoặc tự sửa
 *     sau khi lệch hash (khi đó `next` có thể CÙNG version với `previous`).
 */
export type ConfigChange =
  | {
      kind: "delta";
      previous: ConfigEntry;
      next: ConfigEntry;
      records: readonly ChangeRecord[];
    }
  | { kind: "snapshot"; previous: ConfigEntry; next: ConfigEntry };

/** Được phép bất đồng bộ — lỗi của promise trả về cũng được bắt, không thả nổi */
export type ConfigChangeListener = (
  change: ConfigChange,
) => void | Promise<void>;

export interface ConfigChangeEvents {
  publish(change: ConfigChange): void;
  /** Trả hàm huỷ đăng ký */
  subscribe(listener: ConfigChangeListener): () => void;
}

export function createConfigChangeEvents(): ConfigChangeEvents {
  const listeners = new Set<ConfigChangeListener>();

  const report = (err: unknown, change: ConfigChange): void => {
    logger.error(
      { err, environmentId: change.next.environmentId, kind: change.kind },
      "Listener của change feed hỏng — bỏ qua, các listener khác vẫn nhận",
    );
  };

  return {
    publish(change) {
      for (const listener of listeners) {
        /**
         * Một listener hỏng KHÔNG được chặn listener khác, và càng không được ném
         * ngược vào watcher: `publish` chạy giữa vòng poll, nên một exception ở đây
         * sẽ bị watcher coi là lỗi của environment và bỏ qua nó tới vòng sau.
         */
        try {
          const result = listener(change);
          if (result instanceof Promise) {
            result.catch((err: unknown) => {
              report(err, change);
            });
          }
        } catch (err) {
          report(err, change);
        }
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

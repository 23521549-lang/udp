import { CHANGE_FEED } from "@udp/config";
import { incrementCounter } from "./metrics.js";

/**
 * Ngắt mạch tầng 2, theo từng environment (ADR-05, §1.4).
 *
 * "Rơi về snapshot 3 lần liên tiếp ⇒ tắt tầng 2 cho environment đó 5 phút."
 *
 * Vì sao ngắt mạch chứ không cứ thử lại: rơi tầng không miễn phí. Mỗi lần rơi là
 * một `snapshotOf` đầy đủ — câu lệnh nặng nhất hệ thống có — nên một environment
 * mà tầng 2 hỏng vĩnh viễn (dòng outbox bị dọn, `change_type` chưa hiểu, bug
 * trong phép áp delta) sẽ vừa trả tiền cho tầng 2 vừa trả tiền cho tầng 1 ở MỌI
 * vòng poll. Tắt tầng 2 làm nó chỉ còn trả tiền một lần, và vẫn ĐÚNG — đó là
 * toàn bộ ý của "tầng 2 không thể làm hỏng trạng thái, chỉ có thể chậm".
 *
 * Theo từng environment chứ không theo tiến trình: một environment có dữ liệu
 * hỏng không được kéo theo mọi environment khác vào đường chậm.
 *
 * Đồng hồ nhận từ ngoài để test không phải chờ 5 phút thật. Nhận `now()` chứ
 * không nhận một đối tượng clock: thứ duy nhất cần thay là "bây giờ là mấy giờ".
 */

export interface CircuitBreaker {
  /** Tầng 2 có đang bị tắt cho environment này không */
  isOpen(environmentId: string): boolean;
  /** Một lần rơi về snapshot — có thể làm mạch ngắt */
  recordFallback(environmentId: string): void;
  /** Một vòng tầng 2 trót lọt — chuỗi liên tiếp đứt */
  recordSuccess(environmentId: string): void;
}

interface State {
  consecutiveFallbacks: number;
  openUntil: number;
}

export function createCircuitBreaker(
  now: () => number = Date.now,
): CircuitBreaker {
  const states = new Map<string, State>();

  const stateOf = (environmentId: string): State => {
    const existing = states.get(environmentId);
    if (existing !== undefined) return existing;

    const fresh: State = { consecutiveFallbacks: 0, openUntil: 0 };
    states.set(environmentId, fresh);
    return fresh;
  };

  return {
    isOpen(environmentId) {
      return now() < stateOf(environmentId).openUntil;
    },

    recordFallback(environmentId) {
      incrementCounter("changefeed_fallback_total");

      const state = stateOf(environmentId);
      state.consecutiveFallbacks += 1;

      if (state.consecutiveFallbacks >= CHANGE_FEED.circuitBreakerThreshold) {
        state.openUntil = now() + CHANGE_FEED.circuitBreakerCooldownMs;
        /**
         * Đặt lại bộ đếm khi ngắt: hết 5 phút, environment được thử lại từ đầu
         * với đủ ba cơ hội. Không đặt lại thì lần rơi kế tiếp — lần đầu sau khi
         * hồi phục — ngắt mạch ngay, và environment đó không bao giờ ra khỏi
         * đường chậm nữa.
         */
        state.consecutiveFallbacks = 0;
      }
    },

    recordSuccess(environmentId) {
      stateOf(environmentId).consecutiveFallbacks = 0;
    },
  };
}

import { CHANGE_FEED } from "@udp/config";
import { logger } from "@udp/http";
import { verifyHash } from "./checksum.verifier.js";
import type { ChangeFeed, EnvironmentState } from "./change-feed.interface.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { pollDeltas } from "./outbox.poller.js";
import type { ConfigEntry, SnapshotCache } from "./snapshot.cache.js";

/**
 * TẦNG 1 — nguồn sự thật của ADR-05. Luôn bật, không thể sai.
 *
 * Mỗi vòng đọc `config_version` thật rồi so với con trỏ đang giữ, và rẽ đúng BA
 * nhánh mà §1.4 liệt kê:
 *
 *     con trỏ == version thật   ✓ khớp   → dùng cache
 *     con trỏ <  version thật   → còn delta chưa đọc → đọc tiếp TẦNG 2
 *     con trỏ >  version thật   ✗ lùi    → environment bị restore → snapshot
 *
 * Nhánh giữa là chỗ dễ viết sai nhất, và bản plan đầu đã viết sai đúng chỗ đó:
 * "version đổi thì vô hiệu hoá cache". Câu ấy gộp hai nhánh cuối làm một và làm
 * TẦNG 2 KHÔNG BAO GIỜ CHẠY — hệ thống vẫn đúng, vẫn xanh, chỉ là tầng delta
 * không tồn tại. Phép đo E4 khi đó sẽ báo `delta` ngang `snapshot` và kết luận
 * sai rằng kiến trúc ba tầng không đáng giá.
 */

export interface VersionWatcher {
  /** Một vòng. Tách khỏi lịch để test gọi thẳng thay vì chờ đồng hồ thật */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

export interface WatcherDeps {
  feed: ChangeFeed;
  cache: SnapshotCache;
  breaker: CircuitBreaker;
  /**
   * `CHANGEFEED_MODE === "delta"`.
   *
   * Mặc định của biến môi trường là `snapshot`, tức TẦNG 2 TẮT. Nối tầng 2 vô
   * điều kiện sẽ biến `CHANGEFEED_MODE` thành biến chết và giết luôn phép đo đối
   * chứng E4 — vốn là toàn bộ lý do biến đó tồn tại.
   */
  deltaMode: boolean;
  now?: () => number;
}

export function createVersionWatcher({
  feed,
  cache,
  breaker,
  deltaMode,
  now = Date.now,
}: WatcherDeps): VersionWatcher {
  const lastVerifiedAt = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const keyOf = (entry: ConfigEntry): string =>
    `${entry.environmentId}:${entry.keyType}`;

  /**
   * Rơi về snapshot: nạp lại bộ ba từ một lần đọc nhất quán.
   *
   * "Đặt con trỏ = version của snapshot" của §1.4 xảy ra ở đây mà không cần một
   * dòng lệnh riêng — con trỏ CHÍNH LÀ `configVersion` trong bộ ba, nên nạp bộ
   * ba mới là đặt lại con trỏ. Tách hai thứ đó ra là mở lại đúng khe hở mà
   * `ConfigEntry` sinh ra để đóng.
   */
  const fallbackToSnapshot = async (
    entry: ConfigEntry,
    reason: string,
  ): Promise<void> => {
    logger.warn(
      {
        environmentId: entry.environmentId,
        cursor: entry.configVersion,
        reason,
      },
      "Change feed rơi về snapshot",
    );
    await cache.reload(entry.environmentId, entry.keyType);
  };

  /**
   * Tự kiểm định kỳ 60 giây (§1.4).
   *
   * Chỉ chạy ở chế độ `delta`, vì chỉ ở đó snapshot trong bộ nhớ mới được dựng
   * bằng cách áp từng phần. Ở chế độ `snapshot`, mỗi mục cache đến từ MỘT lần
   * đọc nhất quán của cả version lẫn nội dung, nên phép so này chỉ có thể so một
   * thứ với chính nó — tốn CPU để khẳng định điều đã đúng bằng cấu trúc.
   *
   * Phần lớn công việc của nó đã được `pollDeltas` làm ngay lúc áp (miễn phí, vì
   * tầng 1 vừa mang hash thật về). Vòng 60 giây còn lại bắt đúng một ca mà phép
   * kiểm tức thì không bắt được: environment có `config_hash` rỗng lúc áp delta
   * — lúc đó không có mốc để so — rồi được ghi lần đầu sau đó.
   */
  const verifyIfDue = async (
    entry: ConfigEntry,
    state: EnvironmentState,
  ): Promise<void> => {
    if (!deltaMode) return;

    const key = keyOf(entry);
    const at = now();
    if (at - (lastVerifiedAt.get(key) ?? 0) < CHANGE_FEED.hashVerifyIntervalMs)
      return;
    lastVerifiedAt.set(key, at);

    if (verifyHash(entry.snapshot, state.configHash) !== "mismatch") return;

    logger.error(
      {
        environmentId: entry.environmentId,
        configVersion: entry.configVersion,
        expected: state.configHash,
      },
      "config_hash lệch sau khi áp delta — đây là BUG, không phải chuyện thường",
    );
    breaker.recordFallback(entry.environmentId);
    await fallbackToSnapshot(entry, "hash-mismatch-periodic");
  };

  const tick = async (): Promise<void> => {
    const tracked = cache.tracked();
    if (tracked.length === 0) return;

    const states = await feed.statesOf([
      ...new Set(tracked.map((e) => e.environmentId)),
    ]);

    for (const entry of tracked) {
      const state = states.get(entry.environmentId);

      /**
       * Environment biến mất khỏi database — project đã bị xoá.
       *
       * Không nạp lại (sẽ ném), không xoá khỏi cache (guard SDK key sẽ từ chối
       * mọi request tới nó trước khi chạm tới đây). Bỏ qua là đúng: mục cache
       * chết sẽ tự hết khi tiến trình khởi động lại.
       */
      if (state === undefined) continue;

      if (state.configVersion === entry.configVersion) {
        await verifyIfDue(entry, state);
        continue;
      }

      if (state.configVersion < entry.configVersion) {
        await fallbackToSnapshot(entry, "version-lui");
        continue;
      }

      /**
       * Còn delta chưa đọc.
       *
       * `recordFallback` CHỈ gọi khi tầng 2 đang bật và đang được phép chạy. Ở
       * chế độ `snapshot`, lấy snapshot không phải "rơi tầng" mà là đường chính
       * thức — đếm nó vào `changefeed_fallback_total` sẽ làm bộ đếm tăng ở mọi
       * thay đổi flag trong cấu hình MẶC ĐỊNH, và biến một chỉ số cảnh báo thành
       * tiếng ồn.
       */
      if (deltaMode && !breaker.isOpen(entry.environmentId)) {
        const outcome = await pollDeltas(feed, entry, state);

        if (outcome.kind === "applied") {
          cache.put(outcome.entry);
          breaker.recordSuccess(entry.environmentId);
          continue;
        }

        breaker.recordFallback(entry.environmentId);
        await fallbackToSnapshot(entry, outcome.reason);
        continue;
      }

      await fallbackToSnapshot(entry, "snapshot-mode");
    }
  };

  /**
   * `setTimeout` tự lập lịch, KHÔNG phải `setInterval` — hai lý do độc lập:
   *
   * 1. **Jitter.** `setInterval(500 + jitter)` tính jitter đúng MỘT lần lúc đăng
   *    ký, nên mọi vòng của một tiến trình vẫn đồng pha với nhau mãi mãi. Đó
   *    đúng là thứ §1.4 thêm jitter để phá.
   * 2. **Chồng vòng.** `setInterval` bắn bất kể vòng trước xong chưa. Khi
   *    database chậm, các vòng chồng lên nhau và cùng rút từ pool 5 khe — chính
   *    là đường cạn pool, mà `P2024` lại không có trong bảng ánh xạ lỗi nên
   *    `/internal/flags` sẽ trả 500. Lên lịch ở `finally` làm hình dạng đó không
   *    tồn tại.
   *
   * `unref()` để vòng lặp không giữ tiến trình sống: nó là công việc nền, không
   * phải lý do tồn tại của tiến trình. Cổng HTTP mới là thứ giữ tiến trình.
   */
  const scheduleNext = (): void => {
    if (stopped) return;

    const delay =
      CHANGE_FEED.pollIntervalMs + Math.random() * CHANGE_FEED.pollJitterMs;

    timer = setTimeout(() => {
      void runTick();
    }, delay);
    timer.unref();
  };

  const runTick = (): Promise<void> =>
    tick()
      .catch((err: unknown) => {
        logger.error({ err }, "Vòng poll của change feed hỏng");
      })
      .finally(scheduleNext);

  return {
    tick,

    start() {
      if (timer !== undefined) return;
      stopped = false;
      scheduleNext();
    },

    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

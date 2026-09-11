import { CHANGE_FEED } from "@udp/config";
import { logger } from "@udp/http";
import { verifyHash } from "./checksum.verifier.js";
import type { ChangeFeed, EnvironmentState } from "./change-feed.interface.js";
import type { ConfigChangeEvents } from "./change-events.js";
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
  /**
   * Một vòng, gọi THẲNG — không qua cổng chung. Tách khỏi lịch để test gọi thẳng
   * thay vì chờ đồng hồ thật; mã chạy thật đi qua `start()` và `wake()`.
   */
  tick(): Promise<void>;
  /**
   * Tầng 3: chạy một vòng NGAY, qua cổng chung với timer. Đang có vòng bay thì chạy
   * lại đúng một lần ngay sau nó. Sau `stop()` là no-op; trước `start()` thì chạy
   * đúng một vòng mà không tự bật polling.
   */
  wake(): void;
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
  /**
   * Nơi phát sự kiện "cấu hình đổi" cho `sdk/`. Tuỳ chọn, mặc định không ai nghe:
   * test của tầng 1 và 2 dựng watcher mà không cần nó.
   */
  events?: ConfigChangeEvents;
  now?: () => number;
}

/** Mặc định khi không ai nghe — watcher không phải hỏi "có listener không" ở mỗi chỗ phát */
const SILENT: ConfigChangeEvents = {
  publish: () => undefined,
  subscribe: () => () => undefined,
};

export function createVersionWatcher({
  feed,
  cache,
  breaker,
  deltaMode,
  events = SILENT,
  now = Date.now,
}: WatcherDeps): VersionWatcher {
  const lastVerifiedAt = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  /** Đã `start()` — chỉ khi đó vòng kế tiếp mới được tự lập lịch */
  let started = false;
  /** Đã `stop()` — `wake()` của tầng 3 thành no-op */
  let stopped = false;
  /** Vòng đang bay — CỔNG DUY NHẤT cho cả timer lẫn `wake()` */
  let inFlight: Promise<void> | undefined;
  /** Có `wake()` tới trong lúc vòng đang bay ⇒ chạy lại NGAY sau, đúng một lần */
  let rerun = false;

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
    const next = await cache.reload(entry.environmentId, entry.keyType);
    /**
     * Phát SAU MỌI lần nạp lại vì rơi tầng — kể cả khi version và hash không đổi.
     * Nhánh tự kiểm 60 giây nạp lại đúng khi nội dung SAI mà SỐ đúng (I15a): bỏ qua
     * "vì version không đổi" là giữ SDK ở lại đúng cái nội dung sai đó.
     */
    events.publish({ kind: "snapshot", previous: entry, next });
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

  /**
   * Xử lý MỘT mục cache trong một vòng.
   *
   * Tách khỏi vòng lặp để lỗi của một environment không thoát ra ngoài và cuốn
   * theo những environment còn lại — xem chỗ bắt lỗi trong `tick`.
   */
  const handle = async (
    entry: ConfigEntry,
    state: EnvironmentState | undefined,
  ): Promise<void> => {
    /**
     * Environment biến mất khỏi database — project đã bị xoá.
     *
     * Không nạp lại (sẽ ném), không xoá khỏi cache (guard SDK key đã từ chối mọi
     * request tới nó trước khi chạm tới đây). Bỏ qua là đúng: mục cache chết sẽ
     * tự hết khi tiến trình khởi động lại.
     */
    if (state === undefined) return;

    if (state.configVersion === entry.configVersion) {
      await verifyIfDue(entry, state);
      return;
    }

    if (state.configVersion < entry.configVersion) {
      await fallbackToSnapshot(entry, "version-lui");
      return;
    }

    /**
     * Còn delta chưa đọc.
     *
     * `recordFallback` CHỈ gọi khi tầng 2 đang bật và đang được phép chạy. Ở chế
     * độ `snapshot`, lấy snapshot không phải "rơi tầng" mà là đường chính thức —
     * đếm nó vào `changefeed_fallback_total` sẽ làm bộ đếm tăng ở mọi thay đổi
     * flag trong cấu hình MẶC ĐỊNH, và biến một chỉ số cảnh báo thành tiếng ồn.
     */
    if (deltaMode && !breaker.isOpen(entry.environmentId)) {
      const outcome = await pollDeltas(feed, entry, state);

      if (outcome.kind === "applied") {
        cache.put(outcome.entry);
        breaker.recordSuccess(entry.environmentId);
        // CÙNG khối đồng bộ với `put`: không `await` nào chen giữa, nên không ai đọc
        // được bộ ba mới mà lỡ sự kiện của nó — hub SSE dựa vào đúng điều này
        events.publish({
          kind: "delta",
          previous: entry,
          next: outcome.entry,
          records: outcome.records,
        });
        return;
      }

      breaker.recordFallback(entry.environmentId);
      await fallbackToSnapshot(entry, outcome.reason);
      return;
    }

    await fallbackToSnapshot(entry, "snapshot-mode");
  };

  const tick = async (): Promise<void> => {
    const tracked = cache.tracked();
    if (tracked.length === 0) return;

    const states = await feed.statesOf([
      ...new Set(tracked.map((e) => e.environmentId)),
    ]);

    for (const entry of tracked) {
      /**
       * Một environment hỏng KHÔNG được làm đói những environment còn lại.
       *
       * `cache.reload` gọi `snapshotOf`, mà `snapshotOf` NÉM có chủ đích khi dữ
       * liệu không dựng nổi hình dạng dây: variant mồ côi, `conditions` sai kiểu,
       * flag không có variant mặc định. Không bắt ở đây thì lỗi ấy thoát khỏi cả
       * vòng lặp — mọi environment đứng sau nó trong `Map` bị bỏ qua, và vòng kế
       * tiếp lại gặp đúng nó trước, nên chúng đói VĨNH VIỄN. Một flag hỏng ở một
       * project sẽ đóng băng cấu hình của mọi project khác trên replica này.
       */
      try {
        await handle(entry, states.get(entry.environmentId));
      } catch (err) {
        logger.error(
          { err, environmentId: entry.environmentId },
          "Bỏ qua environment này trong vòng poll — những environment khác vẫn chạy",
        );
      }
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
   *    là đường cạn pool: `$transaction` của `/internal/flags` hết `maxWait` và
   *    người ghi nhận 503. Lên lịch ở `finally` làm hình dạng đó không
   *    tồn tại.
   *
   * `unref()` để vòng lặp không giữ tiến trình sống: nó là công việc nền, không
   * phải lý do tồn tại của tiến trình. Cổng HTTP mới là thứ giữ tiến trình.
   */
  const scheduleNext = (): void => {
    // LUÔN huỷ timer cũ trước: đặt đè mà không huỷ là để lại một chuỗi timer thứ hai
    clearTimeout(timer);
    timer = undefined;
    if (!started || stopped) return;

    const delay =
      CHANGE_FEED.pollIntervalMs + Math.random() * CHANGE_FEED.pollJitterMs;

    timer = setTimeout(() => {
      timer = undefined;
      void runTick();
    }, delay);
    timer.unref();
  };

  /**
   * CỔNG DUY NHẤT vào một vòng — timer và `wake()` của tầng 3 đều đi qua đây.
   *
   * Hai lối vào mà không có cổng chung thì hỏng theo hai kiểu, cả hai đã mô phỏng:
   * `wake` gọi thẳng `tick()` là chồng vòng (một env bị nạp lại hai lần, phát hai
   * sự kiện, SSE gửi thêm một snapshot thừa); còn để vòng của `wake` tự lập lịch là
   * nhân chuỗi timer (nhịp poll từ 1,3 lên 4,8 vòng/giây sau 20 lần wake, và vẫn còn
   * vòng chạy sau `stop()`). Ở đây: đang có vòng bay thì chỉ đánh dấu `rerun`; xong
   * vòng thì hoặc chạy lại ngay đúng một lần, hoặc lập lịch như thường.
   */
  const runTick = (): Promise<void> => {
    if (inFlight !== undefined) {
      rerun = true;
      return inFlight;
    }

    inFlight = tick()
      .catch((err: unknown) => {
        logger.error({ err }, "Vòng poll của change feed hỏng");
      })
      .finally(() => {
        inFlight = undefined;
        if (rerun && !stopped) {
          rerun = false;
          void runTick();
          return;
        }
        rerun = false;
        scheduleNext();
      });

    return inFlight;
  };

  return {
    tick,

    wake() {
      if (stopped) return;
      // Vòng này thay cho vòng đang chờ trên timer — không để hai chuỗi song song
      clearTimeout(timer);
      timer = undefined;
      void runTick();
    },

    start() {
      if (started) return;
      started = true;
      stopped = false;
      if (inFlight === undefined) scheduleNext();
    },

    stop() {
      stopped = true;
      started = false;
      rerun = false;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

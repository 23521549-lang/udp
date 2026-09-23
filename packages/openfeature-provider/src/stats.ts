import { SDK_STATS } from "@udp/config/constants";
import { statsVariantOf, type Evaluation } from "@udp/shared-types";
import type { StatsPostResult, Transport } from "./transport.js";

/**
 * Telemetry `reportStats` của provider (§6.8, V7/V8) [v4.9] — đếm lượt đánh giá
 * TẠI CHỖ rồi báo về Service 2 mỗi ~60 giây.
 *
 * Ba ràng buộc định hình toàn bộ file này (R19, R21):
 *
 *   - **Đường nóng không cấp phát.** `record` chỉ `Map.get`/`Map.set` trên hai tầng
 *     `Map<flagKey, Map<variant, number>>`; không nối chuỗi khoá (`f + "|" + v` là
 *     một chuỗi mới MỖI lượt đánh giá, tức áp lực GC trên chính đường E3 đo). Chỉ
 *     cặp (flag, variant) LẦN ĐẦU gặp mới cấp phát một `Map` con.
 *   - **Telemetry không bao giờ làm hỏng đánh giá.** `record` được gọi SAU khi
 *     `ResolutionDetails` đã dựng xong, trong `try/catch` riêng của provider
 *     (I26, R19 (d)).
 *   - **Thà mất một báo cáo còn hơn đếm đôi** (V7). Chỉ những kết quả CHẮC CHẮN là
 *     "server chưa xử lý" mới được gộp lại; mọi kết quả mơ hồ (quá hạn, huỷ, mã lạ)
 *     đều bỏ lô. Lệch 60 giây không ảnh hưởng chốt archive 7 ngày, còn đếm đôi làm
 *     lệch phân bố variant mà không ai phát hiện được.
 */

export interface StatsEntry {
  flagKey: string;
  variant: string;
  count: number;
}

/**
 * Bộ đếm trong tiến trình của ứng dụng khách.
 *
 * Trần `maxPendingEntries` tính theo số cặp (flag, variant), không theo số lượt:
 * một ứng dụng gọi flag không tồn tại trong vòng lặp cũng không làm phình bộ nhớ
 * của nó (`statsVariantOf` đã bỏ `FLAG_NOT_FOUND` — V8 — nên tới đây chỉ còn key
 * CÓ trong snapshot). Chạm trần thì cặp MỚI bị bỏ im lặng: một bộ đếm telemetry
 * không được phép ném hay ghi log trên đường đánh giá.
 */
export class StatsCounter {
  private readonly byFlag = new Map<string, Map<string, number>>();
  private pairs = 0;

  constructor(
    private readonly maxPendingEntries: number,
    private readonly maxCountPerEntry: number,
  ) {}

  get isEmpty(): boolean {
    return this.pairs === 0;
  }

  record(flagKey: string, variant: string): void {
    this.add(flagKey, variant, 1);
  }

  /**
   * Lấy ra tối đa `limit` mục và XOÁ chúng khỏi bộ đếm. Phần dư ở lại cho lượt
   * sau: một báo cáo không được vượt `maxEntriesPerReport` (schema của Service 2
   * từ chối cả báo cáo, tức mất sạch chứ không mất một phần).
   */
  take(limit: number): StatsEntry[] {
    const batch: StatsEntry[] = [];
    for (const [flagKey, byVariant] of this.byFlag) {
      for (const [variant, count] of byVariant) {
        batch.push({ flagKey, variant, count });
        // Xoá trong lúc duyệt một `Map` là hành vi đã định nghĩa của JS
        byVariant.delete(variant);
        this.pairs -= 1;
        if (batch.length >= limit) break;
      }
      if (byVariant.size === 0) this.byFlag.delete(flagKey);
      if (batch.length >= limit) break;
    }
    return batch;
  }

  /** Gộp một lô CHƯA được server xử lý trở lại (V7) — vẫn tôn trọng trần */
  restore(batch: readonly StatsEntry[]): void {
    for (const entry of batch)
      this.add(entry.flagKey, entry.variant, entry.count);
  }

  private add(flagKey: string, variant: string, n: number): void {
    const byVariant = this.byFlag.get(flagKey);
    if (byVariant === undefined) {
      if (this.pairs >= this.maxPendingEntries) return;
      this.pairs += 1;
      const fresh = new Map<string, number>();
      fresh.set(variant, Math.min(n, this.maxCountPerEntry));
      this.byFlag.set(flagKey, fresh);
      return;
    }
    const current = byVariant.get(variant);
    if (current === undefined) {
      if (this.pairs >= this.maxPendingEntries) return;
      this.pairs += 1;
      byVariant.set(variant, Math.min(n, this.maxCountPerEntry));
      return;
    }
    // Bão hoà ở trần của schema: một `count` vượt trần làm Service 2 trả 400 và
    // cả báo cáo bị bỏ, tức mất nhiều hơn phần bị cắt
    byVariant.set(variant, Math.min(current + n, this.maxCountPerEntry));
  }
}

export interface StatsOptions {
  intervalMs: number;
  /** 0..1 — N tiến trình khởi động cùng lúc không báo cùng một giây */
  jitterRatio: number;
  requestTimeoutMs: number;
  /** Hạn TỔNG của lần gửi cuối trong `onClose()` */
  shutdownFlushTimeoutMs: number;
  maxEntriesPerReport: number;
  maxPendingEntries: number;
  maxCountPerEntry: number;
  /** 0..1 — tiêm được để test tất định */
  random: () => number;
}

export const DEFAULT_STATS_OPTIONS: StatsOptions = {
  intervalMs: SDK_STATS.report.intervalMs,
  jitterRatio: SDK_STATS.report.jitterRatio,
  requestTimeoutMs: SDK_STATS.report.requestTimeoutMs,
  shutdownFlushTimeoutMs: SDK_STATS.report.shutdownFlushTimeoutMs,
  maxEntriesPerReport: SDK_STATS.report.maxEntriesPerReport,
  maxPendingEntries: SDK_STATS.report.maxPendingEntries,
  maxCountPerEntry: SDK_STATS.report.maxCountPerEntry,
  random: Math.random,
};

/** Chỉ để Service 2 ghi log — không tham gia vào bất kỳ quyết định nào */
const SDK_LABEL = { name: "udp-openfeature-provider" } as const;

/**
 * Đồng hồ báo cáo. Một lượt mỗi `intervalMs` ± `jitterRatio`, timer `unref()` (một
 * CLI hay một test của khách phải thoát được dù quên `OpenFeature.close()` — R19
 * (b)), không chồng lượt, và không bao giờ ném ra ngoài.
 */
export class StatsReporter {
  private readonly counter: StatsCounter;
  /** Huỷ mọi lời gọi đang bay khi `close()` hết hạn — không để lại handle mở */
  private readonly abort = new AbortController();
  private readonly options: StatsOptions;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private started = false;
  private closed = false;
  /** 401/403/404/405: ngừng gửi TỚI lần READY kế (V7) */
  private stopped = false;
  /** 400/413: `onDiagnostic` đúng MỘT lần mỗi phiên (V7) */
  private warned = false;
  /** `Retry-After` của lần từ chối gần nhất — dùng một lần rồi bỏ */
  private retryAfterMs: number | undefined;

  constructor(
    private readonly transport: Pick<Transport, "postStats">,
    private readonly onDiagnostic: (message: string) => void,
    options: Partial<StatsOptions> = {},
  ) {
    this.options = { ...DEFAULT_STATS_OPTIONS, ...options };
    this.counter = new StatsCounter(
      this.options.maxPendingEntries,
      this.options.maxCountPerEntry,
    );
  }

  /** ĐƯỜNG NÓNG — gọi sau khi `ResolutionDetails` đã dựng xong (I26) */
  record(flagKey: string, evaluation: Evaluation): void {
    if (this.closed) return;
    // CÙNG hàm mà OFREP dùng: một kết quả cho một nhãn, dù đánh giá ở đâu (INV-23.9)
    const variant = statsVariantOf(evaluation);
    if (variant !== undefined) this.counter.record(flagKey, variant);
  }

  /** Bắt đầu đồng hồ — `initialize()` gọi, không phải constructor */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.schedule();
  }

  /**
   * Cấu hình lại READY. Khoá bị từ chối (401/403) hay Service 2 chưa có
   * `/sdk/stats` (404/405) chỉ ngừng báo cáo TỚI ĐÂY: khoá được cấp lại, hay
   * Service 2 được nâng cấp, thì telemetry chạy tiếp mà không cần khởi động lại
   * ứng dụng khách.
   */
  resume(): void {
    this.stopped = false;
  }

  /**
   * Lần gửi cuối, có hạn, KHÔNG BAO GIỜ ném (R19 (a)): `OpenFeature.close()` của
   * ứng dụng khách không được treo vì Service 2 không tới được. Bộ đếm rỗng thì
   * không phát sinh một request nào (V7).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const deadlineAt = Date.now() + this.options.shutdownFlushTimeoutMs;
    try {
      // Lượt đang bay đã RÚT lô ra khỏi bộ đếm: chờ nó xong (trong hạn) rồi mới
      // gửi phần còn lại, nếu không thì lô đó vừa mất vừa có thể bị đếm đôi
      if (this.inFlight !== undefined)
        await untilDeadline(this.inFlight, deadlineAt);
      await untilDeadline(this.flushOnce(deadlineAt - Date.now()), deadlineAt);
    } catch {
      // Không có đường nào tới đây (mọi nhánh đã nuốt lỗi), nhưng `onClose` là
      // hợp đồng "không ném" nên hàng rào cuối cùng vẫn phải có
    } finally {
      this.abort.abort();
    }
  }

  private schedule(): void {
    const { intervalMs, jitterRatio, random } = this.options;
    const jittered = intervalMs * (1 + (random() * 2 - 1) * jitterRatio);
    const delay = Math.max(jittered, this.retryAfterMs ?? 0);
    this.retryAfterMs = undefined;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    await this.flushOnce(this.options.requestTimeoutMs);
    if (!this.closed) this.schedule();
  }

  /** Không bao giờ ném; không chồng lượt */
  private async flushOnce(timeoutMs: number): Promise<void> {
    if (
      timeoutMs <= 0 ||
      this.stopped ||
      this.inFlight !== undefined ||
      this.counter.isEmpty
    ) {
      return;
    }
    const batch = this.counter.take(this.options.maxEntriesPerReport);
    const sending = this.send(batch, timeoutMs);
    this.inFlight = sending;
    try {
      await sending;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async send(batch: StatsEntry[], timeoutMs: number): Promise<void> {
    let result: StatsPostResult;
    try {
      result = await this.transport.postStats(
        { counts: batch, sdk: SDK_LABEL },
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]),
      );
    } catch {
      // `Transport` phân loại mọi thứ và không ném; một transport giả của ứng dụng
      // khách thì có thể — coi như mơ hồ, bỏ lô
      return;
    }
    if (result.kind === "retry") {
      this.retryAfterMs = result.retryAfterMs;
      this.counter.restore(batch);
      return;
    }
    if (result.kind === "stop") {
      this.stopped = true;
      return;
    }
    if (result.kind === "rejected" && !this.warned) {
      this.warned = true;
      this.onDiagnostic(
        "Service 2 từ chối báo cáo /sdk/stats (400/413) — bỏ lô; kiểm tra phiên bản provider",
      );
    }
    // `accepted`, `rejected` và `ambiguous` đều KHÔNG gộp lại (V7)
  }
}

/** `promise` hoặc mốc hạn, tuỳ cái nào tới trước; timer không giữ tiến trình sống */
async function untilDeadline(
  promise: Promise<void>,
  deadlineAt: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((done) => {
    timer = setTimeout(done, Math.max(0, deadlineAt - Date.now()));
    timer.unref();
  });
  try {
    await Promise.race([promise, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

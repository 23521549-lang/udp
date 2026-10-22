import {
  hashVerdict,
  parseSdkConfig,
  parseSdkDelta,
} from "@udp/flag-evaluator";
import type { ConfigStore, ResyncReason } from "./store.js";
import type { Transport } from "./transport.js";

/**
 * Vòng đồng bộ cấu hình với Service 2 (§6.3, §6.8) [v4.7].
 *
 *   - Bootstrap: `GET /sdk/config` (§6.3). 429/503/mạng hỏng/quá hạn ⇒ KHÔNG chờ:
 *     mở stream không con trỏ — event `snapshot` đầu tiên cũng là bootstrap, và
 *     limiter mở stream (1 000/phút/khoá) rộng hơn `/sdk/config` (100) nhiều.
 *   - Mỗi lần `GET /sdk/config` có hạn riêng (`requestTimeoutMs`): server nhận kết
 *     nối rồi im không được treo cả vòng đồng bộ.
 *   - Stream: con trỏ = version ĐÃ ÁP; cần RESYNC thì mở lại KHÔNG con trỏ.
 *     "Còn sống" = mọi byte (kể cả nhịp tim); rỗi quá `heartbeatTimeoutMs` ⇒ huỷ
 *     và đếm một lần hỏng — kết nối nửa mở không bao giờ tự báo lỗi. Bộ đếm lỗi chỉ
 *     về 0 khi stream đã GỬI một byte: proxy trả header rồi giữ mọi byte phải vẫn
 *     dẫn tới polling.
 *   - Stream kết thúc sạch (server tắt êm) ⇒ nối lại sau `retry:` mà server vừa gửi
 *     — Service 2 rải giá trị đó 1–10 giây để N tiến trình không nối lại cùng một
 *     mili-giây; không tính là hỏng. Kết thúc mà chưa gửi byte nào ⇒ tính là hỏng
 *     (proxy trả 200 rồi đóng ngay không được thành vòng nối lại nóng).
 *   - `sseFailuresBeforeFallback` lần hỏng liên tiếp ⇒ DEGRADED: polling
 *     `/sdk/config` (revalidate bằng `If-None-Match`) song song với việc thử lại
 *     stream có backoff; stream gửi được byte ⇒ thôi polling.
 *   - Không xác nhận được cấu hình còn tươi quá `staleAfterMs` ⇒ STALE (vẫn phục vụ
 *     cache — fail-static, I34); xác nhận lại được ⇒ hết STALE.
 *   - 401/403 ⇒ khoá bị thu hồi: thôi stream, thử `/sdk/config` theo chu kỳ polling
 *     (một 401 thoáng qua không được đóng băng cấu hình — kể cả kill-switch — tới
 *     lúc ứng dụng khởi động lại). Đang 401 thì không báo STALE chồng lên.
 *
 * Hai nguồn cùng ghi cache (stream và polling) không đè nhau: polling chỉ áp khi
 * version TIẾN (hoặc cache đang cần RESYNC); chỉ snapshot của stream được lùi version.
 * Mỗi đợt polling mang một epoch: lượt poll của đợt cũ còn bay khi polling bị tắt
 * rồi bật lại không được hẹn thêm một chuỗi thứ hai.
 */

export interface SyncListener {
  /** Lần đầu có dữ liệu */
  onFirstData(): void;
  onChanged(flagKeys: string[]): void;
  onStale(): void;
  /** Hết STALE */
  onFresh(): void;
  onUnauthorized(): void;
  /** Hết 401 — gọi SAU khi cấu hình của lần thử thành công đã được áp */
  onAuthorized(): void;
  /** Chẩn đoán cho người vận hành ứng dụng khách (RESYNC, DEGRADED, lỗi lạ) */
  onDiagnostic(message: string): void;
}

export interface SyncOptions {
  pollingIntervalMs: number;
  sseFailuresBeforeFallback: number;
  staleAfterMs: number;
  heartbeatTimeoutMs: number;
  backoffMinMs: number;
  /** Hạn của một lần `GET /sdk/config` */
  requestTimeoutMs: number;
  /** Chu kỳ kiểm STALE */
  staleCheckMs: number;
  /** 0..1 — tiêm được để test tất định */
  random: () => number;
  now: () => number;
}

type StreamOutcome = "ended" | "failed" | "resync" | "unauthorized";

export class Synchronizer {
  private readonly abort = new AbortController();
  private closed = false;
  private started = false;
  private seenData = false;
  private failures = 0;
  private resyncStreak = 0;
  private degraded = false;
  private unauthorized = false;
  private stale = false;
  private lastFreshAt = 0;
  /** `retry:` của stream — theo WHATWG, giữ cho mọi lần nối lại sau */
  private retryHintMs: number | undefined;
  /** `Retry-After` của lần từ chối gần nhất — dùng MỘT lần rồi bỏ */
  private retryAfterMs: number | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollEpoch = 0;
  private staleTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly transport: Transport,
    private readonly store: ConfigStore,
    private readonly options: SyncOptions,
    private readonly listener: SyncListener,
  ) {}

  /** Cache có thể không còn đúng — cờ `stale` của `flagMetadata` */
  get isStale(): boolean {
    return this.stale || this.unauthorized;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastFreshAt = this.options.now();
    this.staleTimer = setInterval(
      () => this.checkStale(),
      this.options.staleCheckMs,
    );
    this.staleTimer.unref();
    void this.run();
  }

  private isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
    if (this.staleTimer !== undefined) clearInterval(this.staleTimer);
    this.stopPolling();
  }

  // ------------------------------------------------------------- vòng chính

  private async run(): Promise<void> {
    await this.guarded(() => this.bootstrap());
    let attempt = 0;
    while (!this.closed) {
      // Lỗi lạ trong một vòng không được giết cả vòng đồng bộ (cấu hình đóng băng
      // vĩnh viễn, không sự kiện nào báo): ghi chẩn đoán, lùi lại, đi tiếp
      const ok = await this.guarded(() => this.step());
      // Đọc qua hàm: `close()` đổi cờ trong lúc `await`
      if (this.isClosed()) break;
      attempt = ok ? 0 : attempt + 1;
      if (!ok) await this.sleep(this.backoff(attempt));
    }
  }

  private async step(): Promise<void> {
    if (this.unauthorized) {
      await this.sleep(this.options.pollingIntervalMs);
      await this.pollOnce();
      return;
    }
    const outcome = await this.streamOnce();
    if (this.isClosed() || outcome === "unauthorized") return;
    if (outcome === "ended") {
      await this.sleep(this.reconnectDelay());
      return;
    }
    if (outcome === "resync") {
      // Hash lệch LẶP LẠI (vd lệch phiên bản evaluator) không được thành bão mở
      // stream: lần đầu nối lại ngay, các lần sau có backoff
      this.resyncStreak += 1;
      if (this.resyncStreak > 1)
        await this.sleep(this.backoff(this.resyncStreak - 1));
      return;
    }
    this.failures += 1;
    if (
      this.failures >= this.options.sseFailuresBeforeFallback &&
      !this.degraded
    ) {
      this.degraded = true;
      this.listener.onDiagnostic(
        `${String(this.failures)} lần stream hỏng liên tiếp — chuyển sang polling /sdk/config`,
      );
      this.startPolling();
    }
    await this.sleep(this.backoff(this.failures));
  }

  /** `true` nếu `fn` chạy xong; ngoại lệ ⇒ chẩn đoán, `false` */
  private async guarded(fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      if (!this.closed)
        this.listener.onDiagnostic(`lỗi không lường trước: ${String(err)}`);
      return false;
    }
  }

  private async bootstrap(): Promise<void> {
    const result = await this.transport.getConfig(
      undefined,
      this.requestSignal(),
    );
    if (result.kind === "ok")
      this.acceptConfig(result.body, result.etag, false);
    else if (result.kind === "unauthorized") this.markUnauthorized();
    // 429/503/mạng/quá hạn: stream không con trỏ lo bootstrap
  }

  private async streamOnce(): Promise<StreamOutcome> {
    const since =
      this.store.hasData && !this.store.needsResync
        ? this.store.configVersion
        : undefined;
    const connection = new AbortController();
    const cancel = (): void => connection.abort();
    this.abort.signal.addEventListener("abort", cancel);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (watchdog !== undefined) clearTimeout(watchdog);
      watchdog = setTimeout(cancel, this.options.heartbeatTimeoutMs);
      watchdog.unref();
    };
    let received = false;
    try {
      arm();
      const open = await this.transport.openStream(since, connection.signal);
      if (open.kind === "unauthorized") {
        this.markUnauthorized();
        return "unauthorized";
      }
      if (open.kind === "bad-cursor") {
        return this.resync("bad-cursor");
      }
      if (open.kind === "unavailable") {
        this.retryAfterMs = open.retryAfterMs;
        return "failed";
      }
      for await (const item of open.items) {
        if (this.closed) return "ended";
        arm();
        if (!received) this.streamProvedAlive();
        received = true;
        this.fresh();
        if (item.kind === "retry") this.retryHintMs = item.ms;
        if (item.kind !== "event") continue;
        const handled = this.handleEvent(item.event, item.data);
        if (handled === "resync") return "resync";
      }
      return received ? "ended" : "failed";
    } catch {
      return "failed";
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      this.abort.signal.removeEventListener("abort", cancel);
      connection.abort();
    }
  }

  /** Byte đầu tiên của một stream — lúc này mới biết đường stream thật sự chạy */
  private streamProvedAlive(): void {
    this.failures = 0;
    this.retryAfterMs = undefined;
    if (this.degraded) {
      this.degraded = false;
      this.stopPolling();
    }
  }

  private resync(reason: ResyncReason): "resync" {
    this.store.markNeedsResync();
    this.listener.onDiagnostic(
      `RESYNC (${reason}) — mở lại stream không con trỏ`,
    );
    return "resync";
  }

  private handleEvent(event: string, data: string): "ok" | "resync" {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return this.resync("malformed-event");
    }
    if (event === "snapshot") {
      // Snapshot là sự thật của server — thay cache kể cả khi version LÙI (DB
      // restore) và không RESYNC vì hash (lệch ở đây là lệch evaluator, không phải
      // delta sai; RESYNC chỉ nhận lại đúng snapshot này) — chỉ báo chẩn đoán
      const config = parseSdkConfig(raw);
      if (config === undefined) return this.resync("malformed-event");
      this.resyncStreak = 0;
      this.emitData(this.store.replace(config, undefined));
      this.checkSnapshotHash(config.configHash);
      return "ok";
    }
    if (event === "flag_changed") {
      const delta = parseSdkDelta(raw);
      if (delta === undefined) return this.resync("malformed-event");
      const out = this.store.applyDelta(delta);
      if (out.kind === "resync") return this.resync(out.reason);
      if (out.kind === "applied") this.emitData(out.changed);
      return "ok";
    }
    // Event lạ ⇒ RESYNC, không đoán (§6.8)
    return this.resync("unknown-event");
  }

  private checkSnapshotHash(expected: string): void {
    const snapshot = this.store.snapshot;
    if (snapshot === undefined) return;
    if (hashVerdict(snapshot, expected) === "mismatch") {
      this.listener.onDiagnostic(
        "hash của snapshot không khớp configHash của server — provider và Service 2 lệch phiên bản chuẩn hoá?",
      );
    }
  }

  // ------------------------------------------------------------- polling

  private startPolling(): void {
    if (this.pollTimer !== undefined || this.closed) return;
    this.pollEpoch += 1;
    // Lượt đầu rải ngẫu nhiên: N tiến trình mất stream cùng lúc không cùng gọi
    // `/sdk/config` (100/phút/khoá) trong một mili-giây
    this.schedulePoll(
      this.options.random() * this.options.pollingIntervalMs,
      this.pollEpoch,
    );
  }

  private schedulePoll(delayMs: number, epoch: number): void {
    this.pollTimer = setTimeout(() => {
      const next = (): void => {
        if (epoch === this.pollEpoch && !this.closed && this.degraded)
          this.schedulePoll(this.options.pollingIntervalMs, epoch);
      };
      void this.guarded(() => this.pollOnce()).then(next);
    }, delayMs);
    this.pollTimer.unref();
  }

  private stopPolling(): void {
    this.pollEpoch += 1;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async pollOnce(): Promise<void> {
    const result = await this.transport.getConfig(
      this.store.needsResync ? undefined : this.store.etag,
      this.requestSignal(),
    );
    if (this.closed) return;
    if (result.kind === "unauthorized") {
      this.markUnauthorized();
      return;
    }
    if (result.kind === "unavailable") return;
    const wasUnauthorized = this.unauthorized;
    this.unauthorized = false;
    if (result.kind === "not-modified") this.fresh();
    else this.acceptConfig(result.body, result.etag, true);
    if (wasUnauthorized) this.listener.onAuthorized();
  }

  // ------------------------------------------------------------- trạng thái

  private acceptConfig(
    raw: unknown,
    etag: string | undefined,
    fromPoll: boolean,
  ): void {
    const config = parseSdkConfig(raw);
    if (config === undefined) {
      this.store.markNeedsResync();
      this.listener.onDiagnostic("body /sdk/config sai hình — RESYNC");
      return;
    }
    const regresses =
      this.store.hasData && config.configVersion <= this.store.configVersion;
    if (fromPoll && regresses && !this.store.needsResync) {
      // Không tiến: xác nhận tươi, KHÔNG đè — stream có thể đã đi trước lượt poll này
      this.fresh();
      return;
    }
    const changed = this.store.replace(config, etag);
    this.fresh();
    this.emitData(changed);
    this.checkSnapshotHash(config.configHash);
  }

  private emitData(changed: string[]): void {
    if (this.closed) return;
    if (!this.seenData) {
      this.seenData = true;
      this.listener.onFirstData();
      return;
    }
    if (changed.length > 0) this.listener.onChanged(changed);
  }

  private fresh(): void {
    this.lastFreshAt = this.options.now();
    if (this.stale && !this.unauthorized) {
      this.stale = false;
      if (!this.closed) this.listener.onFresh();
    }
  }

  private checkStale(): void {
    // Đang 401 thì trạng thái công bố là ERROR — STALE chồng lên sẽ che mất việc
    // khoá bị thu hồi; `flagMetadata.stale` vẫn đúng vì `isStale` gồm cả 401
    if (this.closed || this.stale || this.unauthorized || !this.store.hasData)
      return;
    if (this.options.now() - this.lastFreshAt > this.options.staleAfterMs) {
      this.stale = true;
      this.listener.onStale();
    }
  }

  private markUnauthorized(): void {
    this.stopPolling();
    this.degraded = false;
    if (this.unauthorized) return;
    this.unauthorized = true;
    if (!this.closed) this.listener.onUnauthorized();
  }

  // ------------------------------------------------------------- thời gian

  /** Tín hiệu của MỘT lần `GET /sdk/config`: huỷ khi provider đóng HOẶC quá hạn */
  private requestSignal(): AbortSignal {
    return AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(this.options.requestTimeoutMs),
    ]);
  }

  /**
   * Nhân đôi từ `backoffMinMs`, trần là chu kỳ polling, jitter xuống tới một nửa —
   * nhưng KHÔNG BAO GIỜ sớm hơn `Retry-After` (dùng một lần) hay `retry:` của server.
   */
  private backoff(attempt: number): number {
    const exponential = Math.min(
      this.options.pollingIntervalMs,
      this.options.backoffMinMs * 2 ** Math.max(0, attempt - 1),
    );
    const floor = Math.max(this.retryAfterMs ?? 0, this.retryHintMs ?? 0);
    this.retryAfterMs = undefined;
    return Math.max(floor, exponential * (0.5 + this.options.random() / 2));
  }

  /** Sau khi stream kết thúc sạch: `retry:` của server (hoặc mức tối thiểu), rải lên trên */
  private reconnectDelay(): number {
    const floor = this.retryHintMs ?? this.options.backoffMinMs;
    return floor * (1 + this.options.random() / 2);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((done) => {
      if (this.closed) {
        done();
        return;
      }
      // Gỡ listener khi hẹn giờ xong trước: signal sống suốt đời provider, mỗi lần
      // ngủ để lại một listener là rò dần theo thời gian
      const onAbort = (): void => {
        clearTimeout(timer);
        done();
      };
      const timer = setTimeout(() => {
        this.abort.signal.removeEventListener("abort", onAbort);
        done();
      }, ms);
      timer.unref();
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

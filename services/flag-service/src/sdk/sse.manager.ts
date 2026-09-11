import { RATE_LIMIT, SSE } from "@udp/config";
import type { SdkKeyType } from "@udp/db";
import {
  SDK_STREAM_EVENTS,
  type SdkStreamChange,
  type SdkStreamDelta,
} from "@udp/flag-evaluator";
import { logger } from "@udp/http";
import type { ResolvedSdkKey } from "../auth/sdk-key.guard.js";
import type { EnvironmentState } from "../changefeed/change-feed.interface.js";
import type { ConfigChange } from "../changefeed/change-events.js";
import { flagOf } from "../changefeed/outbox.poller.js";
import type { ConfigEntry } from "../changefeed/snapshot.cache.js";
import { sdkConfigBody } from "./config-body.js";
import {
  formatEvent,
  HEARTBEAT,
  retryField,
  STREAM_HEADERS,
} from "./sse.protocol.js";

/**
 * Hub SSE của `GET /sdk/stream` (§6.3) — MỘT thể cho cả tiến trình.
 *
 * Việc của hub: giữ các stream đang mở, và biến mỗi `ConfigChange` của watcher
 * thành đúng MỘT thứ cho từng stream — `flag_changed`, `snapshot`, hoặc không gì
 * cả. Luật chọn nằm ở `deliver` và là hợp đồng §6.3. Mọi thứ còn lại ở đây là để
 * luật đó đứng vững trước ba loại sự cố đã đo:
 *
 *   - Client ngắt: chỉ nghe `res`, thứ chỉ đóng khi client thật sự đi. `req` bắn
 *     `close` SỚM — đã đo: +1ms khi GET mang `Content-Length: 0`, vì
 *     `express.json` đọc xong body rỗng — nên nghe `req` là hoặc gỡ stream ngay,
 *     hoặc (khi `close` đã qua trước lúc gắn listener) không bao giờ trả chỗ.
 *   - Client không đọc: `end()` không giải phóng backlog, và ghi sau `end()` là
 *     `ERR_STREAM_WRITE_AFTER_END` làm SẬP tiến trình (đã đo). Nên mọi lần ghi đi
 *     qua `writeTo`, mọi lần đóng đi qua `closeStream`.
 *   - Sự kiện tới trễ: giao bất đồng bộ (khoá được kiểm trước mỗi lần đẩy) nghĩa
 *     là một stream có thể mở SAU khi sự kiện tới nhưng TRƯỚC khi nó được giao. Số
 *     thứ tự `seq` làm sự kiện cũ hơn vị trí của stream không bao giờ kéo SDK lùi.
 */

/** Phần của `http.ServerResponse` mà hub dùng — hẹp, để test dựng được bằng tay */
export interface StreamResponse {
  statusCode: number;
  readonly writableLength: number;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  setHeader(name: string, value: string): unknown;
  flushHeaders(): void;
  write(chunk: Buffer): boolean;
  end(): unknown;
  destroy(): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface SseLimits {
  heartbeatMs: number;
  revocationCheckMs: number;
  retryMs: { min: number; max: number };
  maxBacklogBytesPerStream: number;
  maxBacklogBytesTotal: number;
  maxStreamsPerKey: number;
  closeGraceMs: number;
}

const DEFAULT_LIMITS: SseLimits = {
  heartbeatMs: SSE.heartbeatMs,
  revocationCheckMs: SSE.revocationCheckMs,
  retryMs: SSE.retryMs,
  maxBacklogBytesPerStream: SSE.maxBacklogBytesPerStream,
  maxBacklogBytesTotal: SSE.maxBacklogBytesTotal,
  maxStreamsPerKey: RATE_LIMIT.sdk.maxStreamsPerKey,
  closeGraceMs: SSE.closeGraceMs,
};

export interface SseHubDeps {
  cache: {
    get(environmentId: string, keyType: SdkKeyType): Promise<ConfigEntry>;
    peek(environmentId: string, keyType: SdkKeyType): ConfigEntry | undefined;
  };
  /** Tầng 1: version THẬT trong database — cho stream có con trỏ đi trước replica */
  statesOf: (
    environmentIds: readonly string[],
  ) => Promise<Map<string, EnvironmentState>>;
  /** `VersionWatcher.wake` */
  wake: () => void;
  /** Trong số các khoá này, khoá nào còn hiệu lực — tồn tại VÀ chưa thu hồi */
  activeKeysAmong: (keyIds: readonly string[]) => Promise<Set<string>>;
  limits?: SseLimits;
  random?: () => number;
}

export type OpenResult =
  | { kind: "accepted" }
  /** Chưa gì được ghi lên `res` — controller trả problem+json kèm `Retry-After` */
  | { kind: "rejected"; status: 429 | 503; retryAfterSeconds: number };

export interface SseHub {
  open(
    res: StreamResponse,
    key: ResolvedSdkKey,
    cursor: number | undefined,
  ): Promise<OpenResult>;
  /** Listener của `configChanges` */
  onChange(change: ConfigChange): void;
  /** Tắt máy: `retry:` rồi đóng mọi stream; từ đây `open` trả 503 */
  closeAll(): void;
  size(): number;
}

/**
 * Vị trí của SDK ở đầu bên kia — thứ quyết định nó cần gì tiếp theo.
 *
 *   - `synced`: SDK giữ ĐÚNG bộ ba này, biết cả version lẫn hash.
 *   - `ahead`: con trỏ của SDK đi TRƯỚC cache của replica này (SDK vừa lấy cấu
 *     hình ở replica khác). Chờ cache đuổi kịp; không bao giờ gửi thứ cũ hơn.
 *   - `restored`: database xác nhận environment bị restore xuống DƯỚI con trỏ —
 *     snapshot kế tiếp thay hết, kể cả khi version thấp hơn (§6.8).
 */
type Position =
  | { kind: "synced"; version: number; hash: string }
  | { kind: "ahead"; version: number }
  | { kind: "restored"; version: number };

interface Stream {
  readonly res: StreamResponse;
  readonly keyId: string;
  readonly environmentId: string;
  readonly keyType: SdkKeyType;
  readonly slot: string;
  position: Position;
  /** Số thứ tự của sự kiện cuối cùng mà vị trí này đã tính tới */
  seq: number;
  closed: boolean;
}

interface Budget {
  /** Tổng backlog của mọi stream, cập nhật dần trong một lượt ghi */
  total: number;
}

const ACCEPTED: OpenResult = { kind: "accepted" };
const HEARTBEAT_CHUNK = Buffer.from(HEARTBEAT);

const slotOf = (environmentId: string, keyType: SdkKeyType): string =>
  `${environmentId}:${keyType}`;

const synced = (entry: ConfigEntry): Position => ({
  kind: "synced",
  version: entry.configVersion,
  hash: entry.configHash,
});

export function createSseHub({
  cache,
  statesOf,
  wake,
  activeKeysAmong,
  limits = DEFAULT_LIMITS,
  random = Math.random,
}: SseHubDeps): SseHub {
  const streams = new Set<Stream>();
  const bySlot = new Map<string, Set<Stream>>();
  const perKey = new Map<string, number>();
  /** Bộ ba bất biến ⇒ khối snapshot của nó dựng MỘT lần, dùng cho mọi stream */
  const snapshotChunks = new WeakMap<ConfigEntry, Buffer>();

  /** Số thứ tự của sự kiện cuối cùng đã NHẬN (chưa chắc đã giao) */
  let received = 0;
  const pending: { seq: number; change: ConfigChange }[] = [];
  let draining = false;
  let closing = false;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let checkTimer: NodeJS.Timeout | undefined;

  const retryMs = (): number =>
    limits.retryMs.min + random() * (limits.retryMs.max - limits.retryMs.min);

  const reject = (status: 429 | 503): OpenResult => ({
    kind: "rejected",
    status,
    retryAfterSeconds: Math.ceil(retryMs() / 1_000),
  });

  const snapshotChunk = (entry: ConfigEntry): Buffer => {
    let chunk = snapshotChunks.get(entry);
    if (chunk === undefined) {
      chunk = Buffer.from(
        formatEvent({
          id: entry.configVersion,
          name: SDK_STREAM_EVENTS.snapshot,
          data: sdkConfigBody(entry),
        }),
      );
      snapshotChunks.set(entry, chunk);
    }
    return chunk;
  };

  /** `undefined` khi một dòng không chiếu được — khi đó gửi snapshot, không bao giờ gửi delta thiếu */
  const deltaChunk = (
    change: Extract<ConfigChange, { kind: "delta" }>,
  ): Buffer | undefined => {
    const changes: SdkStreamChange[] = [];
    for (const record of change.records) {
      const flag = flagOf(record.payload);
      if (flag === null) return undefined;
      changes.push({ configVersion: record.configVersion, kind: "flag", flag });
    }
    const data: SdkStreamDelta = {
      fromVersion: change.previous.configVersion,
      toVersion: change.next.configVersion,
      configHash: change.next.configHash,
      changes,
    };
    return Buffer.from(
      formatEvent({
        id: data.toVersion,
        name: SDK_STREAM_EVENTS.flagChanged,
        data,
      }),
    );
  };

  const backlogTotal = (): number => {
    let total = 0;
    for (const s of streams) total += s.res.writableLength;
    return total;
  };

  /** Chỗ DUY NHẤT đóng stream — đóng hai lần, hay ghi sau khi đóng, là không thể */
  const closeStream = (s: Stream, how: "end" | "destroy"): void => {
    if (s.closed) return;
    s.closed = true;
    if (how === "destroy") s.res.destroy();
    else s.res.end();
  };

  const shed = (s: Stream, scope: "stream" | "process", budget: Budget) => {
    logger.warn(
      {
        keyId: s.keyId,
        environmentId: s.environmentId,
        backlogBytes: s.res.writableLength,
        scope,
      },
      "Huỷ stream SSE vì client đọc quá chậm — SDK sẽ nối lại và nhận snapshot",
    );
    budget.total -= s.res.writableLength;
    // HUỶ chứ không `end()`: `end()` không giải phóng backlog của client không đọc
    closeStream(s, "destroy");
  };

  /**
   * Chỗ DUY NHẤT ghi lên stream, qua hai chốt backlog (§6.3, "Client chậm").
   *
   * Xét backlog ĐANG CÓ, không cộng khối sắp ghi: một snapshot lớn hơn 1 MiB vẫn
   * phải đi được tới client đọc kịp — cộng vào là huỷ ngay lúc mở, SDK nối lại,
   * lại bị huỷ, mãi mãi. Trần của tiến trình chỉ cắt stream ĐANG kẹt: stream đọc
   * kịp không phải trả giá cho stream không đọc.
   */
  const writeTo = (s: Stream, chunk: Buffer, budget: Budget): boolean => {
    if (s.closed || s.res.writableEnded || s.res.destroyed) return false;
    const backlog = s.res.writableLength;
    if (backlog > limits.maxBacklogBytesPerStream) {
      shed(s, "stream", budget);
      return false;
    }
    if (
      backlog > 0 &&
      budget.total + chunk.length > limits.maxBacklogBytesTotal
    ) {
      shed(s, "process", budget);
      return false;
    }
    s.res.write(chunk);
    budget.total += s.res.writableLength - backlog;
    return true;
  };

  const pushSnapshot = (s: Stream, entry: ConfigEntry, budget: Budget) => {
    if (!writeTo(s, snapshotChunk(entry), budget)) return;
    s.position = synced(entry);
    // Lấy từ cache ⇒ đã phản ánh mọi sự kiện nhận được tới giờ
    s.seq = received;
  };

  /** Luật §6.3: mỗi stream nhận đúng MỘT thứ cho một sự kiện, hoặc không gì cả */
  const deliver = (
    change: ConfigChange,
    seq: number,
    active: ReadonlySet<string>,
    budget: Budget,
  ): void => {
    const targets = bySlot.get(
      slotOf(change.next.environmentId, change.next.keyType),
    );
    if (targets === undefined) return;

    const { next } = change;
    /** Dựng MỘT lần cho mọi stream; `null` = không chiếu được thành delta */
    let delta: Buffer | null | undefined;

    for (const s of targets) {
      if (s.closed || seq <= s.seq) continue;
      /**
       * Khoá không còn hiệu lực ⇒ không đẩy gì (§12 T7). KHÔNG đóng ở đây: stream
       * mở SAU lượt kiểm này không có trong `active` mà vẫn hợp lệ. Đóng là việc
       * của vòng kiểm định kỳ, nơi tập khoá được hỏi đầy đủ.
       */
      if (!active.has(s.keyId)) continue;
      s.seq = seq;

      const at = s.position;
      if (at.kind === "ahead") {
        // Replica còn đang đuổi theo con trỏ của SDK: gửi thứ cũ hơn là kéo SDK lùi
        if (next.configVersion < at.version) continue;
        // Đuổi kịp ĐÚNG con trỏ — như ETag khớp: SDK đã có đúng thứ này
        if (next.configVersion === at.version) {
          s.position = synced(next);
          continue;
        }
      } else if (at.kind === "synced") {
        if (at.version === next.configVersion && at.hash === next.configHash) {
          continue;
        }
        /**
         * `flag_changed` CHỈ khi stream đang ở đúng `(version, hash)` mà delta xuất
         * phát. Cùng version mà khác hash là SDK đang giữ nội dung khác — áp delta
         * lên đó cho ra một thứ không bao giờ khớp `configHash` (I15c).
         */
        if (
          change.kind === "delta" &&
          at.version === change.previous.configVersion &&
          at.hash === change.previous.configHash
        ) {
          if (delta === undefined) delta = deltaChunk(change) ?? null;
          if (delta !== null) {
            if (writeTo(s, delta, budget)) s.position = synced(next);
            continue;
          }
        }
      }

      if (writeTo(s, snapshotChunk(next), budget)) s.position = synced(next);
    }
  };

  /**
   * Giao theo lô, TUẦN TỰ theo thứ tự nhận: `flag_changed` chỉ đúng khi các delta
   * tới SDK đúng thứ tự chúng xảy ra. MỘT lần kiểm khoá cho cả lô.
   */
  const drain = async (): Promise<void> => {
    draining = true;
    try {
      while (pending.length > 0) {
        const batch = pending.splice(0);
        const keyIds = new Set<string>();
        for (const { change } of batch) {
          const slot = slotOf(change.next.environmentId, change.next.keyType);
          for (const s of bySlot.get(slot) ?? []) keyIds.add(s.keyId);
        }
        if (keyIds.size === 0) continue;

        let active: Set<string>;
        try {
          active = await activeKeysAmong([...keyIds]);
        } catch (err) {
          // Không kiểm được thì KHÔNG đẩy — vòng kiểm định kỳ sẽ bù bằng snapshot
          logger.warn(
            { err },
            "Không kiểm được SDK key trước khi đẩy — bỏ lượt này, vòng kiểm định kỳ sẽ bù",
          );
          continue;
        }

        const budget = { total: backlogTotal() };
        for (const { seq, change } of batch)
          deliver(change, seq, active, budget);
      }
    } finally {
      draining = false;
    }
  };

  /**
   * Stream mà vị trí đến từ con trỏ của SDK, không từ cache của replica này —
   * hỏi version THẬT trong database rồi quyết (§6.3, dòng "Con trỏ > version").
   */
  const resolveWaiting = async (targets: Stream[]): Promise<void> => {
    let states: Map<string, EnvironmentState>;
    try {
      states = await statesOf([
        ...new Set(targets.map((s) => s.environmentId)),
      ]);
    } catch (err) {
      logger.warn(
        { err },
        "Không đọc được version thật cho stream đi trước replica — thử lại ở vòng kiểm sau",
      );
      wake();
      return;
    }

    let nudge = false;
    const budget = { total: backlogTotal() };
    for (const s of targets) {
      // Một sự kiện có thể đã giải quyết stream này trong lúc chờ database
      if (s.closed || s.position.kind === "synced") continue;

      const truth = states.get(s.environmentId);
      if (truth === undefined) {
        closeStream(s, "end"); // environment đã bị xoá
        continue;
      }
      if (
        s.position.kind === "ahead" &&
        truth.configVersion >= s.position.version
      ) {
        nudge = true; // replica đang tụt: đánh thức watcher, chưa gửi gì
        continue;
      }

      // Database DƯỚI con trỏ ⇒ environment bị restore
      s.position = { kind: "restored", version: s.position.version };
      const current = cache.peek(s.environmentId, s.keyType);
      if (current?.configVersion === truth.configVersion) {
        pushSnapshot(s, current, budget);
      } else {
        nudge = true; // cache chưa theo kịp restore — snapshot tới qua watcher
      }
    }
    if (nudge) wake();
  };

  /**
   * Vòng kiểm định kỳ — MỘT truy vấn khoá cho mọi stream:
   *   1. Đóng stream của khoá đã thu hồi hoặc đã xoá, trong ≤ `revocationCheckMs`.
   *   2. Bù cho stream lệch khỏi cache (lượt đẩy bị bỏ vì không kiểm được khoá).
   *   3. Hỏi lại database cho stream còn đang chờ.
   */
  const check = async (): Promise<void> => {
    const open = [...streams].filter((s) => !s.closed);
    if (open.length === 0) return;

    let active: Set<string>;
    try {
      active = await activeKeysAmong([...new Set(open.map((s) => s.keyId))]);
    } catch (err) {
      logger.warn(
        { err },
        "Vòng kiểm SDK key của stream hỏng — giữ nguyên, thử lại vòng sau",
      );
      return;
    }

    const budget = { total: backlogTotal() };
    const waiting: Stream[] = [];
    for (const s of open) {
      if (s.closed) continue;
      if (!active.has(s.keyId)) {
        closeStream(s, "destroy");
        continue;
      }
      if (s.position.kind !== "synced") {
        waiting.push(s);
        continue;
      }
      // Lượt giao đang dở thì để nó giao — bù lúc này biến delta thành snapshot thừa
      if (draining) continue;
      const current = cache.peek(s.environmentId, s.keyType);
      if (
        current !== undefined &&
        (current.configVersion !== s.position.version ||
          current.configHash !== s.position.hash)
      ) {
        pushSnapshot(s, current, budget);
      }
    }
    if (waiting.length > 0) await resolveWaiting(waiting);
  };

  /**
   * Hai timer ĐỘC LẬP, tự lập lịch, `unref`, và CHỈ chạy khi có stream: không
   * stream nào mở thì hub không tốn một truy vấn nền nào — cùng lý do watcher
   * không khởi động trong `createApp()`. Nhịp tim 20 giây là quá dài cho một hành
   * động an ninh, nên vòng kiểm khoá có nhịp riêng.
   */
  const scheduleHeartbeat = (): void => {
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      if (closing) return;
      const budget = { total: backlogTotal() };
      for (const s of streams) writeTo(s, HEARTBEAT_CHUNK, budget);
      if (streams.size > 0) scheduleHeartbeat();
    }, limits.heartbeatMs);
    heartbeatTimer.unref();
  };

  const scheduleCheck = (): void => {
    checkTimer = setTimeout(() => {
      check()
        .catch((err: unknown) => {
          logger.error({ err }, "Vòng kiểm stream SSE hỏng ngoài dự kiến");
        })
        .finally(() => {
          checkTimer = undefined;
          if (streams.size > 0 && !closing) scheduleCheck();
        });
    }, limits.revocationCheckMs);
    checkTimer.unref();
  };

  const register = (s: Stream): void => {
    streams.add(s);
    const peers = bySlot.get(s.slot);
    if (peers === undefined) bySlot.set(s.slot, new Set([s]));
    else peers.add(s);
    if (heartbeatTimer === undefined) scheduleHeartbeat();
    if (checkTimer === undefined) scheduleCheck();
  };

  const unregister = (s: Stream): void => {
    s.closed = true;
    streams.delete(s);
    const peers = bySlot.get(s.slot);
    peers?.delete(s);
    if (peers?.size === 0) bySlot.delete(s.slot);
  };

  /**
   * Đọc qua hàm, không đọc thẳng biến: `closeAll()` có thể chạy trong lúc `open`
   * đang `await`, mà TypeScript giữ nguyên phép thu hẹp của lần kiểm trước đó qua
   * `await` — kiểm lại bằng biến trần bị coi là "luôn sai" và bị lint gỡ đi.
   */
  const shuttingDown = (): boolean => closing;

  return {
    async open(res, key, cursor) {
      if (shuttingDown()) return reject(503);
      // Giữ chỗ ĐỒNG BỘ, trước mọi `await`: N lần mở cùng lúc không cùng lọt trần
      const held = perKey.get(key.id) ?? 0;
      if (held >= limits.maxStreamsPerKey) return reject(429);
      perKey.set(key.id, held + 1);

      /** Chỗ vừa giữ — trả ĐÚNG MỘT lần, khi `res` đóng, dù đóng ở giai đoạn nào */
      const lease: { released: boolean; stream: Stream | undefined } = {
        released: false,
        stream: undefined,
      };
      const release = (): void => {
        if (lease.released) return;
        lease.released = true;
        const left = (perKey.get(key.id) ?? 1) - 1;
        if (left > 0) perKey.set(key.id, left);
        else perKey.delete(key.id);
        if (lease.stream !== undefined) unregister(lease.stream);
      };
      // `res`, KHÔNG `req`, và TRƯỚC mọi `await` — xem chú thích đầu file
      res.on("close", release);
      res.on("error", (err) => {
        logger.debug({ err }, "Stream SSE báo lỗi — client đã đi");
        release();
      });

      const loaded = await cache.get(key.environmentId, key.keyType);
      if (lease.released || res.destroyed) return ACCEPTED;
      if (shuttingDown()) return reject(503);

      res.statusCode = 200;
      for (const [name, value] of Object.entries(STREAM_HEADERS)) {
        res.setHeader(name, value);
      }
      // Header đi NGAY: SDK biết đã nối mà không phải chờ event hay nhịp tim
      res.flushHeaders();

      // Đọc cache và đăng ký trong CÙNG một khối đồng bộ: không sự kiện nào chen giữa
      const current = cache.peek(key.environmentId, key.keyType) ?? loaded;
      const s: Stream = {
        res,
        keyId: key.id,
        environmentId: key.environmentId,
        keyType: key.keyType,
        slot: slotOf(key.environmentId, key.keyType),
        position: synced(current),
        seq: received,
        closed: false,
      };
      lease.stream = s;
      register(s);

      const budget = { total: backlogTotal() };
      writeTo(s, Buffer.from(retryField(retryMs())), budget);

      if (cursor === undefined || cursor < current.configVersion) {
        writeTo(s, snapshotChunk(current), budget);
        return ACCEPTED;
      }
      // Bằng: chỉ header — tin con trỏ như tin ETag của `/sdk/config`
      if (cursor === current.configVersion) return ACCEPTED;

      s.position = { kind: "ahead", version: cursor };
      await resolveWaiting([s]);
      return ACCEPTED;
    },

    onChange(change) {
      received += 1;
      const slot = slotOf(change.next.environmentId, change.next.keyType);
      // Không stream nào nghe environment này trên replica này ⇒ không có gì để giao
      if (!bySlot.has(slot)) return;
      pending.push({ seq: received, change });
      if (!draining) {
        drain().catch((err: unknown) => {
          logger.error({ err }, "Giao sự kiện SSE hỏng ngoài dự kiến");
        });
      }
    },

    closeAll() {
      closing = true;
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
      clearTimeout(checkTimer);
      checkTimer = undefined;

      const budget = { total: backlogTotal() };
      for (const s of [...streams]) {
        // `retry:` ngẫu nhiên: N tiến trình mất kết nối cùng lúc không nối lại cùng lúc
        writeTo(s, Buffer.from(retryField(retryMs())), budget);
        closeStream(s, "end");
      }
      /**
       * Client không đọc thì `end()` không bao giờ xong, và `server.close()` chờ
       * theo tới lúc thoát cưỡng bức. Huỷ phần còn lại sau một nhịp ngắn.
       */
      const leftovers = [...streams];
      if (leftovers.length > 0) {
        const grace = setTimeout(() => {
          for (const s of leftovers) if (streams.has(s)) s.res.destroy();
        }, limits.closeGraceMs);
        grace.unref();
      }
    },

    size() {
      return streams.size;
    },
  };
}

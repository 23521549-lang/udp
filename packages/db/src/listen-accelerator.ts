import { LISTEN_TIMING } from "@udp/config/constants";
import type { SessionClient, SessionConnector } from "./session.js";

/**
 * Kênh `LISTEN` dùng chung — đánh thức một vòng poll bằng `NOTIFY` (ADR-05).
 *
 * Hai người dùng: tầng 3 của Service 2 (kênh `flag_changed`) và Service 3 (kênh
 * `rollout_intent`, §7.6 [v4.3]). Cả hai cùng một hợp đồng: notification chỉ
 * ĐÁNH THỨC, không mang dữ liệu; mất kênh thì hệ thống về đúng hành vi poll —
 * chậm hơn, không sai hơn. Vì thế mọi sự cố ở đây là cảnh báo, không bao giờ là
 * lý do để service ngừng phục vụ. Ngoại lệ duy nhất là SAI ROLE — xem
 * `verifyIdentity`.
 *
 * Vì sao ở `@udp/db`: máy trạng thái dưới đây (thế hệ kết nối, ping, backoff có
 * jitter, dừng hẳn khi sai role) đã trả giá bằng ba lần sửa ở Service 2; chép nó
 * sang Service 3 là mời hai bản trôi khỏi nhau. Logger TIÊM VÀO vì `@udp/http`
 * (nơi có logger) phụ thuộc `@udp/db` — import ngược là vòng phụ thuộc.
 */

export type IdentityVerdict =
  | { kind: "ok" }
  | { kind: "wrong-role"; actual: string }
  | { kind: "unreachable"; error: unknown };

export interface ListenAccelerator {
  /**
   * Nối thử MỘT lần và đọc `current_user` — cho lúc khởi động.
   *
   * Tách khỏi `start()` vì hai kết cục đòi hai phản ứng ngược nhau. Sai role là
   * lỗi CẤU HÌNH, phải chặn khởi động — cùng lý do với chốt danh tính của pool: ma
   * trận writer §1.2 chỉ có hiệu lực khi MỌI kết nối mang role của service. Còn
   * không nối được chỉ là kênh tạm vắng — service vẫn đúng nhờ vòng poll.
   */
  verifyIdentity(): Promise<IdentityVerdict>;
  start(): void;
  /** Dừng hẳn: huỷ lịch nối lại, huỷ ping, đóng kết nối — xong trong `stopTimeoutMs` */
  stop(): Promise<void>;
}

/** Hạn giờ của kênh — mặc định `LISTEN_TIMING`; test thay bằng số của nó */
export interface ListenTiming {
  reconnectInitialMs: number;
  reconnectMaxMs: number;
  healthCheckMs: number;
  healthCheckTimeoutMs: number;
  identityTimeoutMs: number;
  stopTimeoutMs: number;
}

type LogFn = (fields: Record<string, unknown>, message: string) => void;

/** Tập con của pino mà kênh cần — logger của `@udp/http` có đúng hình dạng này */
export interface ListenLogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
}

export interface ListenAcceleratorDeps {
  /** Mỗi lần gọi là một kết nối MỚI — client đã chết không bao giờ được dùng lại */
  connect: SessionConnector;
  expectedRole: string;
  channel: string;
  /** Tên kênh trong log — "tầng 3", "rollout_intent" */
  label: string;
  /**
   * Một notification trên đúng kênh. Chạy BÊN TRONG vòng đọc socket của `pg`:
   * ném ra từ đây là sập tiến trình, nên kênh tự bắt mọi exception của nó.
   */
  onNotice: (payload: string) => void;
  /**
   * Vừa nghe được (lần đầu hoặc sau khi nối lại). Notification phát ra lúc kênh
   * vắng đã mất hẳn — PostgreSQL không giữ cho ai chưa `LISTEN` — nên bên dùng
   * thường đánh thức MỘT lần ở đây để phủ khoảng trống đó.
   */
  onListening: () => void;
  logger: ListenLogger;
  timing?: ListenTiming;
  random?: () => number;
}

export function createListenAccelerator({
  connect,
  expectedRole,
  channel,
  label,
  onNotice,
  onListening,
  logger,
  timing = LISTEN_TIMING,
  random = Math.random,
}: ListenAcceleratorDeps): ListenAccelerator {
  /** Đã `start()`, chưa `stop()`, và chưa bị dừng vì sai role */
  let running = false;
  /**
   * Thế hệ kết nối. Mọi callback của một client so thế hệ của NÓ với biến này
   * trước khi làm gì — client đã bị thay, hoặc đã qua `stop()`, không bao giờ còn
   * được lập lịch nối lại hay ping.
   */
  let generation = 0;
  let current: SessionClient | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let pingTimer: NodeJS.Timeout | undefined;
  /** Số lần mất kênh liên tiếp chưa xen một kết nối ổn định — số mũ của backoff */
  let failures = 0;

  const onNotification = (
    received: string,
    payload: string | undefined,
  ): void => {
    if (received !== channel || payload === undefined) return;
    try {
      onNotice(payload);
    } catch (err) {
      logger.error({ err, channel }, `Xử lý notice của ${label} hỏng — bỏ qua`);
    }
  };

  const scheduleReconnect = (): void => {
    if (!running) return;
    const base = Math.min(
      timing.reconnectMaxMs,
      timing.reconnectInitialMs * 2 ** failures,
    );
    /**
     * Nửa cố định, nửa ngẫu nhiên: database khởi động lại làm MỌI replica mất kênh
     * cùng lúc — không có jitter thì chúng nối lại cùng một mili-giây, lần nào
     * cũng vậy.
     */
    const delay = base / 2 + random() * (base / 2);
    failures += 1;
    logger.warn(
      { delayMs: Math.round(delay), failures, channel },
      `Kênh LISTEN của ${label} mất — sẽ nối lại`,
    );
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      openSession();
    }, delay);
    reconnectTimer.unref();
  };

  /**
   * Ping định kỳ — bắt kết nối chết IM, thứ mà `end` không bao giờ báo: TCP còn
   * sống, không byte nào về, notification ngừng tới mà client vẫn trông khoẻ.
   * Hỏng ⇒ đóng (quá hạn thì huỷ socket) ⇒ `end` bắn ⇒ về đúng con đường nối lại
   * duy nhất. Tự lập lịch SAU khi ping xong, nên hai ping không bao giờ chồng nhau.
   */
  const schedulePing = (client: SessionClient, gen: number): void => {
    pingTimer = setTimeout(() => {
      pingTimer = undefined;
      void client.ping(timing.healthCheckTimeoutMs).then(
        () => {
          if (gen !== generation) return;
          // Sống trọn một chu kỳ ping mới là ổn định — kênh chập chờn không được xoá backoff
          failures = 0;
          schedulePing(client, gen);
        },
        (err: unknown) => {
          if (gen !== generation) return;
          logger.warn(
            { err, channel },
            `Ping kênh LISTEN của ${label} hỏng — đóng để nối lại`,
          );
          void client.close(timing.stopTimeoutMs);
        },
      );
    }, timing.healthCheckMs);
    pingTimer.unref();
  };

  /**
   * MỘT vòng đời kết nối: nối → kiểm role → LISTEN → báo đã nghe → ping.
   *
   * Tín hiệu nối lại DUY NHẤT là "kết nối này đã hết": `end`, hoặc thiết lập
   * hỏng — và nó có hiệu lực ĐÚNG MỘT lần mỗi client (cờ `lost`). KHÔNG nối lại
   * theo `error`: client chết phát `error` HAI lần rồi mới `end` (đã đo với
   * `pg_terminate_backend`); nối lại theo từng tín hiệu là đẻ ba client, hai cái
   * mồ côi giữ chỗ trên trần 60 kết nối của Supabase free tier. Kết nối báo lỗi mà
   * không `end` là việc của ping.
   */
  const session = async (): Promise<void> => {
    generation += 1;
    const gen = generation;
    const client = connect();
    current = client;

    let lost = false;
    const onLost = (): void => {
      if (lost) return;
      lost = true;
      if (gen !== generation) return;
      clearTimeout(pingTimer);
      pingTimer = undefined;
      current = undefined;
      scheduleReconnect();
    };

    client.onError((err) => {
      if (gen === generation) {
        logger.warn({ err, channel }, `Kênh LISTEN của ${label} báo lỗi`);
      }
    });
    client.onceEnd(onLost);
    client.onNotification(onNotification);

    try {
      await client.connect(timing.identityTimeoutMs);
      const role = await client.currentUser(timing.identityTimeoutMs);
      if (role !== expectedRole) {
        /**
         * Lúc khởi động `verifyIdentity` đã chặn ca này, nên tới được đây là cấu
         * hình đổi dưới chân tiến trình (DNS, pooler định tuyến sai). Dừng HẲN
         * kênh, không nối lại — nối lại chỉ lặp đúng cái sai đó mỗi 30 giây.
         * Service vẫn đúng nhờ vòng poll.
         */
        logger.fatal(
          { actual: role, expected: expectedRole, channel },
          `Kênh LISTEN của ${label} mang sai role — dừng hẳn kênh`,
        );
        running = false;
        generation += 1;
        current = undefined;
        await client.close(timing.stopTimeoutMs);
        return;
      }
      await client.listen(channel, timing.identityTimeoutMs);
    } catch (err) {
      if (gen === generation) {
        logger.warn({ err, channel }, `Không mở được kênh LISTEN của ${label}`);
      }
      await client.close(timing.stopTimeoutMs);
      onLost();
      return;
    }

    if (gen !== generation) {
      // `stop()` đã chạy trong lúc đang nối — client này không được giữ lại
      await client.close(timing.stopTimeoutMs);
      return;
    }

    logger.info({ channel }, `Kênh LISTEN của ${label} đang nghe`);
    try {
      onListening();
    } catch (err) {
      logger.error({ err, channel }, `onListening của ${label} hỏng — bỏ qua`);
    }
    schedulePing(client, gen);
  };

  const openSession = (): void => {
    session().catch((err: unknown) => {
      logger.error(
        { err, channel },
        `Vòng đời kênh LISTEN của ${label} hỏng ngoài dự kiến`,
      );
    });
  };

  return {
    async verifyIdentity() {
      const client = connect();
      try {
        await client.connect(timing.identityTimeoutMs);
        const actual = await client.currentUser(timing.identityTimeoutMs);
        return actual === expectedRole
          ? { kind: "ok" }
          : { kind: "wrong-role", actual };
      } catch (error) {
        return { kind: "unreachable", error };
      } finally {
        await client.close(timing.stopTimeoutMs);
      }
    },

    start() {
      if (running) return;
      running = true;
      failures = 0;
      openSession();
    },

    async stop() {
      running = false;
      // Vô hiệu mọi callback đang chờ của client hiện tại — kể cả lần nối đang bay
      generation += 1;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      clearTimeout(pingTimer);
      pingTimer = undefined;

      const client = current;
      current = undefined;
      if (client !== undefined) await client.close(timing.stopTimeoutMs);
    },
  };
}

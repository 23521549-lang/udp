import { CHANGE_FEED } from "@udp/config";
import type { SessionClient, SessionConnector } from "@udp/db";
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
 * có nó — chậm hơn (≤ 700ms thay vì ~150–190ms), không sai hơn. Vì thế mọi sự cố
 * ở đây là cảnh báo, không bao giờ là lý do để service ngừng phục vụ. Ngoại lệ duy
 * nhất là SAI ROLE — xem `verifyIdentity`.
 */

export type IdentityVerdict =
  | { kind: "ok" }
  | { kind: "wrong-role"; actual: string }
  | { kind: "unreachable"; error: unknown };

export interface NotifyAccelerator {
  /**
   * Nối thử MỘT lần và đọc `current_user` — cho lúc khởi động.
   *
   * Tách khỏi `start()` vì hai kết cục đòi hai phản ứng ngược nhau. Sai role là
   * lỗi CẤU HÌNH, phải chặn khởi động — cùng lý do với chốt danh tính của pool: ma
   * trận writer §1.2 chỉ có hiệu lực khi MỌI kết nối mang role của service. Còn
   * không nối được chỉ là tầng 3 tạm vắng — service vẫn đúng nhờ tầng 1.
   */
  verifyIdentity(): Promise<IdentityVerdict>;
  start(): void;
  /** Dừng hẳn: huỷ lịch nối lại, huỷ ping, đóng kết nối — xong trong `stopTimeoutMs` */
  stop(): Promise<void>;
}

/** Hạn giờ của kênh — mặc định `CHANGE_FEED.notify`; test thay bằng số của nó */
export interface NotifyTiming {
  reconnectInitialMs: number;
  reconnectMaxMs: number;
  healthCheckMs: number;
  healthCheckTimeoutMs: number;
  identityTimeoutMs: number;
  stopTimeoutMs: number;
}

export interface NotifyAcceleratorDeps {
  /** Mỗi lần gọi là một kết nối MỚI — client đã chết không bao giờ được dùng lại */
  connect: SessionConnector;
  expectedRole: string;
  /** Replica này có đang giữ environment đó không — `SnapshotCache.holds` */
  holds: (environmentId: string) => boolean;
  /** `VersionWatcher.wake` — tự gộp nhiều lần gọi, không bao giờ chồng vòng */
  wake: () => void;
  timing?: NotifyTiming;
  random?: () => number;
}

export function createNotifyAccelerator({
  connect,
  expectedRole,
  holds,
  wake,
  timing = CHANGE_FEED.notify,
  random = Math.random,
}: NotifyAcceleratorDeps): NotifyAccelerator {
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
    channel: string,
    payload: string | undefined,
  ): void => {
    if (channel !== CONFIG_CHANGE_CHANNEL || payload === undefined) return;
    /**
     * Không gì ở đây được ném ngược vào `pg`: listener chạy bên trong vòng đọc
     * socket của nó, và một exception thoát ra từ đó là sập tiến trình.
     */
    try {
      const notice = parseConfigChangeNotice(payload);
      /**
       * Payload rác chỉ ghi ở mức debug. PostgreSQL không có quyền trên `NOTIFY`:
       * mọi role nối được database đều phát được lên kênh này, nên cảnh báo từng
       * cái là trao vòi xả log cho bất kỳ ai. Bỏ qua thì không mất gì — tầng 1 vẫn
       * bắt mọi thay đổi.
       */
      if (notice === null) {
        logger.debug({ channel }, "Bỏ qua notice sai hình dạng của tầng 3");
        return;
      }
      // Mọi lần ghi trên MỌI project đều tới đây; chỉ đánh thức vì env replica này giữ
      if (holds(notice.environmentId)) wake();
    } catch (err) {
      logger.error({ err }, "Xử lý notice của tầng 3 hỏng — bỏ qua");
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
      { delayMs: Math.round(delay), failures },
      "Kênh LISTEN của tầng 3 mất — sẽ nối lại",
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
            { err },
            "Ping kênh LISTEN của tầng 3 hỏng — đóng để nối lại",
          );
          void client.close(timing.stopTimeoutMs);
        },
      );
    }, timing.healthCheckMs);
    pingTimer.unref();
  };

  /**
   * MỘT vòng đời kết nối: nối → kiểm role → LISTEN → đánh thức → ping.
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
        logger.warn({ err }, "Kênh LISTEN của tầng 3 báo lỗi");
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
         * tầng 3, không nối lại — nối lại chỉ lặp đúng cái sai đó mỗi 30 giây.
         * Service vẫn đúng nhờ tầng 1.
         */
        logger.fatal(
          { actual: role, expected: expectedRole },
          "Kênh LISTEN của tầng 3 mang sai role — dừng hẳn tầng 3",
        );
        running = false;
        generation += 1;
        current = undefined;
        await client.close(timing.stopTimeoutMs);
        return;
      }
      await client.listen(CONFIG_CHANGE_CHANNEL, timing.identityTimeoutMs);
    } catch (err) {
      if (gen === generation) {
        logger.warn({ err }, "Không mở được kênh LISTEN của tầng 3");
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

    logger.info({ channel: CONFIG_CHANGE_CHANNEL }, "Tầng 3 đang nghe");
    /**
     * Đánh thức MỘT lần ngay khi nghe được: notice phát ra lúc kênh vắng đã mất
     * hẳn — PostgreSQL không giữ notification cho ai chưa `LISTEN`. Một vòng poll
     * phủ trọn khoảng trống đó.
     */
    wake();
    schedulePing(client, gen);
  };

  const openSession = (): void => {
    session().catch((err: unknown) => {
      logger.error(
        { err },
        "Vòng đời kênh LISTEN của tầng 3 hỏng ngoài dự kiến",
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

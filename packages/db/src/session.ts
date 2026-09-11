import { Client } from "pg";
import { DB_TLS_OPTIONS, sanitizeConnectionString } from "./adapter.js";

/**
 * Kết nối SESSION riêng, ngoài pool — cho việc cần trạng thái sống qua nhiều câu
 * lệnh. Hôm nay đúng một người dùng: kênh `LISTEN` của tầng 3 (ADR-05).
 *
 * Vì sao không dùng pool của Prisma: `LISTEN` gắn với MỘT kết nối và chỉ nhận
 * notification khi chính kết nối đó còn sống giữa các câu lệnh. Pool trả kết nối
 * về sau mỗi câu, pooler ở transaction mode cũng vậy — đã đo: nghe qua cổng 6543
 * không nhận gì trong 5 giây, qua cổng session 5432 nhận sau 95–190ms.
 *
 * Vì sao một interface hẹp thay vì trả `pg.Client`: mọi cái bẫy của `pg` trên
 * đường này đã được đo và gói ở đây, để service không phải biết chúng — và không
 * phải phụ thuộc `pg`:
 *
 *   - Kết nối chết IM (TCP còn, không byte nào về) làm truy vấn treo vô hạn, và
 *     `end()` cũng treo vì nó chờ phía bên kia đóng. Nên mọi thao tác có hạn chờ,
 *     và quá hạn thì HUỶ SOCKET — đường thoát duy nhất không cần server hợp tác.
 *   - Client chết vì `pg_terminate_backend` phát `error`, `error` rồi `end` (đã
 *     đo). Chỉ `end` nói chắc rằng kết nối đã hết, nên interface chỉ mở `onceEnd`
 *     cho việc đó.
 *   - `error` không ai nghe là exception làm SẬP tiến trình. Lỗi của một kênh tuỳ
 *     chọn không được phép giết cả service, nên client luôn có một listener nền.
 */
export interface SessionClient {
  /** Mở kết nối. Quá hạn ⇒ huỷ socket rồi ném */
  connect(timeoutMs: number): Promise<void>;
  /** `current_user` — role THẬT mà kết nối mang, không phải cái tên trong URL */
  currentUser(timeoutMs: number): Promise<string>;
  /** `LISTEN` một kênh. Tên kênh được quote, không bao giờ nối chuỗi thô */
  listen(channel: string, timeoutMs: number): Promise<void>;
  /** `SELECT 1` có hạn — bắt kết nối chết im mà TCP chưa báo */
  ping(timeoutMs: number): Promise<void>;
  onNotification(
    handler: (channel: string, payload: string | undefined) => void,
  ): void;
  onError(handler: (err: Error) => void): void;
  /** Kết nối đã hết hẳn — bắn ĐÚNG MỘT lần, dù chết vì lý do gì */
  onceEnd(handler: () => void): void;
  /** Đóng êm; quá hạn thì huỷ socket. KHÔNG bao giờ ném */
  close(timeoutMs: number): Promise<void>;
}

/** Mỗi lần gọi là một client MỚI, chưa nối */
export type SessionConnector = () => SessionClient;

/**
 * Trả một NHÀ MÁY client chứ không phải một client: kênh LISTEN nối lại bằng
 * client MỚI mỗi lần, vì `pg.Client` đã chết không dùng lại được.
 *
 * Chuỗi kết nối được kiểm và chuẩn hoá NGAY ở đây, qua đúng hàm mà pool của
 * Prisma dùng. Sai thì ném lúc dựng — tức lúc nạp module khi khởi động, cùng chỗ
 * và cùng cách với `DATABASE_URL_S<n>` — chứ không đợi tới lần nối đầu tiên, nơi
 * nó sẽ chỉ còn là một dòng cảnh báo "không nối được".
 */
export function createSessionConnector(
  connectionString: string,
): SessionConnector {
  const sanitized = sanitizeConnectionString(connectionString);
  return () => sessionClient(sanitized);
}

function sessionClient(connectionString: string): SessionClient {
  const client = new Client({
    connectionString,
    ssl: DB_TLS_OPTIONS,
    /**
     * Keepalive TCP để NAT và pooler không cắt im một kết nối chỉ ngồi chờ
     * notification. Không thay được `ping`: keepalive của hệ điều hành mặc định
     * chờ hàng giờ mới kết luận kết nối đã chết.
     */
    keepAlive: true,
  });

  // Listener nền — xem chú thích đầu file
  client.on("error", () => undefined);

  /** Đang nối — lúc đó `close` phải HUỶ chứ không `end()`, xem `close` */
  let connecting = false;

  /**
   * Chạy `work` với hạn chờ; quá hạn ⇒ huỷ socket rồi ném.
   *
   * Huỷ chứ không chỉ ném: sau một truy vấn quá hạn, không còn biết kết nối đang ở
   * trạng thái nào — câu trả lời có thể tới muộn và bị gán nhầm cho câu kế tiếp.
   * Kết nối như thế chỉ còn một việc đúng để làm là chết; chết thì `end` bắn, đưa
   * người dùng về con đường nối lại duy nhất của họ.
   */
  const bounded = async <T>(
    work: Promise<T>,
    timeoutMs: number,
    what: string,
  ): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        client.connection.stream.destroy();
        reject(
          new Error(`${what} quá ${String(timeoutMs)}ms — đã huỷ kết nối`),
        );
      }, timeoutMs);
    });
    try {
      // `race` gắn handler cho `work`, nên nó reject muộn (sau khi socket bị huỷ)
      // cũng không thành unhandled rejection
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async connect(timeoutMs) {
      connecting = true;
      try {
        await bounded(client.connect(), timeoutMs, "Nối database");
      } finally {
        connecting = false;
      }
    },

    async currentUser(timeoutMs) {
      const result = await bounded(
        client.query<{ current_user: string }>("SELECT current_user"),
        timeoutMs,
        "Đọc current_user",
      );
      const role = result.rows[0]?.current_user;
      if (role === undefined) {
        throw new Error("SELECT current_user không trả dòng nào");
      }
      return role;
    },

    async listen(channel, timeoutMs) {
      await bounded(
        client.query(`LISTEN ${client.escapeIdentifier(channel)}`),
        timeoutMs,
        `LISTEN ${channel}`,
      );
    },

    async ping(timeoutMs) {
      await bounded(client.query("SELECT 1"), timeoutMs, "Ping");
    },

    onNotification(handler) {
      client.on("notification", (message) => {
        handler(message.channel, message.payload);
      });
    },

    onError(handler) {
      client.on("error", handler);
    },

    onceEnd(handler) {
      client.once("end", handler);
    },

    async close(timeoutMs) {
      /**
       * Đang nối thì HUỶ, không `end()`. `pg` bỏ qua callback của lần nối khi
       * client đã `_ending`, nên `end()` giữa lúc nối làm `connect()` không bao
       * giờ settle — đã đo: treo trọn hạn chờ của chính nó. Huỷ socket thì lần
       * nối hỏng ngay ("Connection terminated unexpectedly") và `end` vẫn bắn.
       */
      if (connecting) {
        client.connection.stream.destroy();
        return;
      }
      try {
        await bounded(client.end(), timeoutMs, "Đóng kết nối");
      } catch {
        // `bounded` đã huỷ socket: kết nối đã đóng, chỉ là không êm
      }
    },
  };
}

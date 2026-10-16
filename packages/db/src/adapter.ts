import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { DB_POOL } from "@udp/config/constants";

/**
 * Nơi DUY NHẤT biết cách mở kết nối tới database.
 *
 * Tách ra thành module riêng vì có ít nhất ba bên cần kết nối và mỗi bên dùng
 * một chuỗi khác nhau: runtime của service (pooled), seed và các script quản trị
 * (session mode), và sau này là pg-boss. Nếu mỗi bên tự dựng adapter thì cấu hình
 * TLS và trần pool sẽ lệch nhau, và kiểu lệch đó chỉ lộ ra khi chạy thật.
 */

/**
 * CA gốc của Supabase, ghim vào repo.
 *
 * Vì sao cần: Supavisor trình ra chuỗi chứng chỉ do CHÍNH Supabase ký
 * (`*.pooler.supabase.com` ← `Supabase Intermediate 2021 CA` ← `Supabase Root
 * 2021 CA`), và root đó không nằm trong kho tin cậy của Node. Từ `pg` v8.16,
 * `sslmode=require` được diễn giải thành `verify-full`, nên kết nối thất bại
 * với `SELF_SIGNED_CERT_IN_CHAIN`.
 *
 * Hai cách sai và một cách đúng:
 *   - `sslmode=no-verify`: vẫn mã hoá nhưng KHÔNG xác thực danh tính server.
 *     Với một hệ thống giữ credential cloud của người khác (§12 T2), hạ chuẩn ở
 *     đây mâu thuẫn với chính mô hình đe doạ của mình.
 *   - `sslrootcert=<đường dẫn>` trong URL: đường dẫn tuyệt đối trong `.env` vỡ
 *     ngay khi đổi giữa Windows, WSL và CI.
 *   - Ghim CA ở đây, resolve theo vị trí module: chạy ở mọi nền tảng, và file CA
 *     là công khai nên commit được. Vân tay của nó đã được đối chiếu với chuỗi
 *     chứng chỉ mà server thật trình ra.
 *
 * CA này hết hạn 26/04/2031. Khi Supabase xoay CA, thay file trong `certs/`.
 */
const supabaseRootCa = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../certs/supabase-root-2021.crt",
  ),
  "utf8",
);

export interface PgAdapterOptions {
  /**
   * CHÚ Ý: chuỗi này KHÔNG được mang `sslmode`. Tham số đó trong connection
   * string THẮNG đối tượng `ssl` bên dưới, nên để nguyên sẽ vô hiệu hoá việc
   * xác thực CA. Xem chú thích ở `.env`.
   */
  connectionString: string;
  /**
   * Trần kết nối của pool. Mặc định của `pg` là `số CPU × 2 + 1` — 17 trên máy
   * 8 nhân, tức ba service đã vượt hạn mức 60 của Supabase free tier trước cả
   * khi pg-boss và kênh LISTEN tham gia.
   */
  max: number;
  /**
   * Thời gian chờ MỘT khe trong pool trước khi bỏ cuộc. Mặc định
   * `DB_POOL.acquireTimeoutMs`; chỉ test cạn pool mới truyền giá trị khác.
   */
  acquireTimeoutMs?: number;
  /**
   * Chế độ TLS — từ `UDP_DB_TLS_MODE` (env-schema, nguồn sự thật duy nhất),
   * người gọi truyền tường minh, không đọc env ở đây.
   * `verify-full` (mặc định): CA Supabase ghim + `rejectUnauthorized`.
   * `disable`: plaintext, CHỈ cho host nội bộ (postgres kèm cụm không có SSL) —
   * host ngoài thì `resolveTlsOptions` ném fail-fast. Xem hàm đó.
   */
  tlsMode?: TlsMode;
}

/** Dựng adapter với TLS theo chế độ, trần pool và hạn chờ pool tường minh. */
export function createPgAdapter({
  connectionString,
  max,
  acquireTimeoutMs = DB_POOL.acquireTimeoutMs,
  tlsMode = "verify-full",
}: PgAdapterOptions): PrismaPg {
  const sanitized = sanitizeConnectionString(connectionString);
  const tlsOptions = resolveTlsOptions(tlsMode, sanitized);
  return new PrismaPg({
    connectionString: sanitized,
    // Không truyền `ssl: undefined` tường minh — phụ thuộc chi tiết `Object.assign`
    // của `pg`; thiếu key thì chắc chắn là plaintext.
    ...(tlsOptions === undefined ? {} : { ssl: tlsOptions }),
    max,
    /**
     * Không có nó, một truy vấn gặp pool cạn xếp hàng VÔ HẠN. Trước đây chỉ
     * transaction có `maxWait` (và chỉ đường đọc snapshot của S2 dùng
     * transaction); một câu `$queryRaw` hay `findMany` trần không có hạn nào.
     * Đặt ở tầng adapter thì mọi truy vấn của mọi service cùng một luật, và
     * `dbAvailabilityError` dịch lỗi này (pg-pool: "timeout exceeded when
     * trying to connect") thành 503 `PROVIDER_UNAVAILABLE` như với `P2028`.
     *
     * Ngữ nghĩa của pg-pool, đã đo: con số này tính cả thời gian MỞ một kết nối
     * mới (TLS tới Supabase ~0,5s), không chỉ thời gian chờ khe rảnh. Vì thế nó
     * phải rộng hơn handshake xa nhất — 5 giây là dư, 300ms là tự giết mình.
     */
    connectionTimeoutMillis: acquireTimeoutMs,
  });
}

/**
 * Tùy chọn TLS cho chế độ `verify-full` (mặc định) — dùng CHUNG cho mọi kết nối
 * tới database ngoài cụm.
 *
 * Export ra để test bất biến — vốn cần `pg.Client` trần cho SET ROLE và
 * SET CONSTRAINTS — không phải tự dựng lại và không có cớ hạ `rejectUnauthorized`.
 * Hạ chuẩn ở test là hạ chuẩn ở đúng nơi lẽ ra phải canh nó.
 */
export const DB_TLS_OPTIONS = {
  ca: supabaseRootCa,
  rejectUnauthorized: true,
} as const;

/**
 * Chế độ TLS của adapter — từ `UDP_DB_TLS_MODE` (env-schema).
 * `verify-full`: CA ghim + `rejectUnauthorized`, cho mọi database ngoài cụm.
 * `disable`: plaintext, CHỈ cho postgres nội bộ (kèm cụm kind/vm, không có SSL).
 */
export type TlsMode = "verify-full" | "disable";

/**
 * Host được coi là nội bộ — `disable` chỉ hợp lệ với chúng.
 *
 * `postgres` (tên single-label) là host của postgres kèm cụm trong cả kind lẫn
 * vm (cluster DNS); thêm loopback và hậu tố service/cluster cho trường hợp dựng
 * tay. Mọi host khác (Supabase, cloud, IP công cộng) bắt buộc TLS.
 */
function isInternalDbHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    !h.includes(".") ||
    h.endsWith(".svc") ||
    h.endsWith(".cluster.local")
  );
}

/**
 * Tùy chọn TLS cho một lần mở kết nối — hàm thuần, dễ test.
 *
 * Rào fail-closed (T2): `disable` mà host không nội bộ thì NÉM ngay lúc khởi
 * động thay vì để credential đi plaintext câm lặng. Kịch bản nó chặn: ai đó
 * export `UDP_DB_TLS_MODE=disable` để chạy cụm kind rồi cùng shell chạy service
 * trỏ Supabase — env rò sang, password DB đi trần trên internet công cộng.
 */
export function resolveTlsOptions(
  tlsMode: TlsMode,
  connectionString: string,
): typeof DB_TLS_OPTIONS | undefined {
  if (tlsMode === "disable") {
    const host = new URL(connectionString).hostname;
    if (!isInternalDbHost(host)) {
      throw new Error(
        `UDP_DB_TLS_MODE=disable không cho phép với host "${host}" — chỉ host nội bộ ` +
          `(localhost, tên cluster như postgres, *.svc, *.cluster.local) được tắt TLS. ` +
          `Nếu database ngoài cụm thật sự không có TLS, mở rộng allowlist trong isInternalDbHost.`,
      );
    }
    return undefined;
  }
  return DB_TLS_OPTIONS;
}

/**
 * Tham số TLS trong chuỗi kết nối mà `pg` để GHI ĐÈ object `ssl` truyền vào.
 *
 * Đã đo trên `pg-connection-string@2.14.0` — mỗi dòng dưới đây là một đường vứt
 * bỏ CA ghim mà không có một tiếng báo nào:
 *
 *   ?ssl=true          → ssl = true            (không CA, không pin)
 *   ?sslrootcert=<f>   → ssl = { ca: <f> }     (thay CA, mất rejectUnauthorized)
 *   ?sslcert / ?sslkey → ssl = {}              (mất rejectUnauthorized)
 *
 * `pg/lib/connection-parameters.js` làm `Object.assign({}, config, parse(url))`,
 * nên chuỗi kết nối THẮNG. Đây đúng là thứ mô hình đe dọa T2 (§12) dựa vào để
 * chống MITM, nên nó không được phép tắt bằng một tham số URL.
 */
const TLS_OVERRIDE_PARAMS = [
  "ssl",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslnegotiation",
] as const;

/**
 * Chuẩn hoá chuỗi kết nối trước khi đưa cho `node-postgres`.
 *
 * Hai xử lý khác nhau, có chủ đích:
 *
 *   `sslmode`  — GỠ im lặng. `DATABASE_URL_DIRECT` cố ý mang nó vì Prisma CLI
 *                cần (engine Rust xử lý được chuỗi chứng chỉ Supabase), nhưng
 *                seed và script quản trị dùng cùng chuỗi đó qua node-postgres.
 *                Gỡ ở đây thay vì bắt mỗi bên gọi tự nhớ.
 *
 *   Còn lại    — NÉM. Không có lý do hợp lệ nào để cấu hình TLS qua URL trong
 *                dự án này, và gỡ im lặng sẽ để người viết cấu hình tin rằng
 *                thiết lập của họ có hiệu lực. Thà sập lúc khởi động.
 */
export function sanitizeConnectionString(connectionString: string): string {
  const url = new URL(connectionString);

  const offending = TLS_OVERRIDE_PARAMS.filter((p) => url.searchParams.has(p));
  if (offending.length > 0) {
    throw new Error(
      `Chuỗi kết nối chứa tham số TLS ${offending.join(", ")} — chúng ghi đè CA đã ghim ` +
        `và tắt xác thực chứng chỉ. Bỏ chúng khỏi biến môi trường; TLS do chế độ ` +
        `UDP_DB_TLS_MODE quyết định (mặc định verify-full).`,
    );
  }

  url.searchParams.delete("sslmode");
  return url.toString();
}

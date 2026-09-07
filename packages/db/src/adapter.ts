import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";

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
}

/** Dựng adapter với TLS xác thực đầy đủ và trần pool tường minh. */
export function createPgAdapter({
  connectionString,
  max,
}: PgAdapterOptions): PrismaPg {
  return new PrismaPg({
    connectionString: stripSslMode(connectionString),
    ssl: { ca: supabaseRootCa, rejectUnauthorized: true },
    max,
  });
}

/**
 * Gỡ `sslmode` khỏi chuỗi kết nối.
 *
 * `DATABASE_URL` đã cố ý không mang nó, nhưng `DATABASE_URL_DIRECT` thì CÓ, vì
 * Prisma CLI cần (engine Rust của Prisma xử lý được chuỗi chứng chỉ Supabase).
 * Seed và các script quản trị dùng chuỗi DIRECT nhưng chạy qua `node-postgres`,
 * nên phải gỡ ở đây thay vì bắt mỗi bên gọi tự nhớ.
 */
function stripSslMode(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");
  return url.toString();
}

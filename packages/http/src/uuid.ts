import type { Request } from "express";
import { ValidationError } from "./errors.js";

/**
 * UUID ở dạng chuỗi — MỘT định nghĩa cho mọi service [v4.4: dời từ Service 2 lên
 * đây khi Service 1 đã có bốn bản chép của cùng regex].
 *
 * Nhiều bản regex là nhiều chỗ có thể trôi khỏi nhau — một bản nới lỏng ra là
 * đủ để một id sai định dạng lọt xuống Postgres ở đúng endpoint đó.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tham số đường dẫn phải là UUID — kiểm TRƯỚC khi chạm Prisma.
 *
 * Không có bước này, một id không phải UUID đi thẳng xuống Postgres và ném
 * `22P02`; mã đó không nằm trong bảng ánh xạ của `@udp/db` nên rơi xuống nhánh
 * cuối và thành **500**. Một URL gõ sai không phải sự cố máy chủ.
 */
export function uuidParam(req: Request, name: string, message: string): string {
  const raw = req.params[name];
  if (raw === undefined || !UUID_PATTERN.test(raw)) {
    throw new ValidationError(message);
  }
  return raw;
}

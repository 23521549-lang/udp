import type { Request } from "express";
import { ValidationError } from "@udp/http";

/**
 * UUID ở dạng chuỗi — MỘT định nghĩa cho cả service.
 *
 * Trước đây nó được chép ở `internal/flag.controller.ts` và
 * `auth/internal-auth.guard.ts`, và ba controller của đường ghi rule sẽ cần thêm
 * bản nữa. Bốn bản regex là bốn chỗ có thể trôi khỏi nhau — một bản nới lỏng ra
 * là đủ để một id sai định dạng lọt xuống Postgres ở đúng endpoint đó.
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

import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { RATE_LIMIT } from "@udp/config";
import { ipKey, rateLimitProblemHandler } from "@udp/http";

/**
 * Giới hạn tần suất cho `/sdk/*` — theo KHOÁ, không theo IP (§3.2, §2.2).
 *
 * `app.ts` từ chối rate limit theo IP với lý do "SDK gọi `/sdk/*` sẽ cần, nhưng
 * đúng theo SDK key chứ không theo IP; thêm một giới hạn sai trục còn tệ hơn
 * không có". Endpoint SDK đã có, nên món nợ đó phải trả ở đây.
 *
 * Vì sao trục IP sai với SDK: SDK chạy trong backend của khách hàng, thường sau
 * NAT hoặc trong một cluster. Đếm theo IP nghĩa là cả một cụm dùng chung một
 * bucket, còn một khách hàng chạy trên hạ tầng serverless thì mỗi lời gọi một
 * IP mới. Cả hai chiều đều sai. Khoá thì gắn với đúng một `(project,
 * environment)` — đó mới là đơn vị mà hạn mức có nghĩa.
 */

const shared = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitProblemHandler,
} as const;

/**
 * Khoá đếm lấy từ header, KHÔNG tra database.
 *
 * Đây là lý do rate limit phải đứng TRƯỚC guard trong chuỗi middleware: chặn
 * được một cơn dội mà không tốn lượt đi về database nào. Nếu khoá đếm cần danh
 * tính đã giải, mọi request bị chặn vẫn phải trả tiền cho một truy vấn ~52ms —
 * tức là kẻ dội vẫn đạt được điều nó muốn.
 *
 * Băm chứ không dùng thẳng: khoá của rate limiter nằm trong bộ nhớ và có thể lộ
 * ra qua log hay công cụ chẩn đoán, mà đây là bí mật của khách hàng. `base64url`
 * cắt còn 22 ký tự vẫn là 128 bit — dư xa để không đụng độ.
 */
const keyPrint = (req: Request): string =>
  createHash("sha256")
    .update(req.get("Authorization") ?? "")
    .digest("base64url")
    .slice(0, 22);

/**
 * Hai limiter chồng nhau, đúng như §2.2 khai — và một ghi chú phải đọc trước khi
 * đổi số.
 *
 * Chú thích của hằng số nói `perKey` chặn "một khách hàng ngốn hết tài nguyên
 * chung", còn `perKeyIp` chặn "một máy đơn lẻ dùng key hợp lệ để dội". Với ý đó
 * thì hạn mức của `perKey` (cả khách hàng) phải LỚN hơn `perKeyIp` (một máy).
 * Con số hiện tại ngược lại: `perKey.max = 100` còn `perKeyIp.max = 600` trong
 * cùng cửa sổ 60 giây, nên `perKey` luôn chạm trước và `perKeyIp` không bao giờ
 * có tác dụng.
 *
 * Vẫn nối cả hai đúng như thiết kế khai, chứ KHÔNG tự hoán đổi hai con số: giới
 * hạn hiệu dụng là 100/phút/khoá — an toàn, chỉ là chặt hơn ý định. Đây là chỗ
 * cần một quyết định về thiết kế, không phải một lần sửa lặng lẽ trong code.
 */
export const sdkPerKeyLimiter: RequestHandler = rateLimit({
  ...shared,
  windowMs: RATE_LIMIT.sdk.perKey.windowMs,
  limit: RATE_LIMIT.sdk.perKey.max,
  keyGenerator: keyPrint,
});

export const sdkPerKeyIpLimiter: RequestHandler = rateLimit({
  ...shared,
  windowMs: RATE_LIMIT.sdk.perKeyIp.windowMs,
  limit: RATE_LIMIT.sdk.perKeyIp.max,
  keyGenerator: (req) => `${keyPrint(req)}|${ipKey(req.ip ?? "")}`,
});

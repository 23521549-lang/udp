import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { RATE_LIMIT } from "@udp/config";
import { rateLimitProblemHandler } from "@udp/http";

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
 * Hạn mức của SERVER key trên `/sdk/config` — 100/phút/khoá. Việc MỞ
 * `/sdk/stream` có limiter riêng, `sdkStreamOpenLimiter` bên dưới.
 *
 * CHỈ một limiter, và điều đó có chủ đích. §2.2 khai `perKeyIp` (600/phút) cho
 * **CLIENT key trên OFREP**, một bề mặt khác với một loại khoá khác — không phải
 * một trục thứ hai chồng lên endpoint này. Nối nó vào đây thì nó vừa sai chỗ vừa
 * không bao giờ chạm tới, vì 600 luôn lớn hơn 100: một limiter chết mang hình
 * dạng một biện pháp an ninh.
 *
 * Nó sẽ được dựng cùng `ofrep/ofrep.controller.ts`, nơi trục IP là bắt buộc chứ
 * không phải bổ sung — khoá CLIENT nằm trong trình duyệt nên ai cũng đọc được.
 */
export const sdkPerKeyLimiter: RequestHandler = rateLimit({
  ...shared,
  windowMs: RATE_LIMIT.sdk.perKey.windowMs,
  limit: RATE_LIMIT.sdk.perKey.max,
  keyGenerator: keyPrint,
});

/**
 * Hạn mức MỞ `GET /sdk/stream` của SERVER key — bucket RIÊNG, 1 000 lần/phút/khoá.
 *
 * Chung bucket với `/sdk/config` thì một lần replica restart là bão 429 dây
 * chuyền: N tiến trình dùng chung khoá nối lại cùng lúc, phần vượt bị chặn, SDK
 * rơi về polling `/sdk/config` trên CHÍNH bucket đó và cũng bị chặn — cấu hình
 * đứng im nhiều phút, kill-switch không tới. Trần stream ĐỒNG THỜI của mỗi khoá
 * nằm ở hub (`RATE_LIMIT.sdk.maxStreamsPerKey`), vì chỉ hub biết stream nào còn mở.
 */
export const sdkStreamOpenLimiter: RequestHandler = rateLimit({
  ...shared,
  windowMs: RATE_LIMIT.sdk.streamOpensPerKey.windowMs,
  limit: RATE_LIMIT.sdk.streamOpensPerKey.max,
  keyGenerator: keyPrint,
});

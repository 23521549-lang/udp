import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env, INTERNAL_SECRET_HEADER } from "@udp/config";
import { UnauthenticatedError } from "./errors.js";

/**
 * Xác thực lời gọi máy-tới-máy vào `/internal/*` (§9, §12 T12) — MỘT hiện thực cho mọi service
 * có route nội bộ: Service 2 (bên gọi S1, S3) và Service 1 (bên gọi S3, Plan #39). Hai bản chép
 * là hai chỗ để một bản sửa lọt mất một bên.
 *
 * **Đây là BƯỚC MỘT của T12, không phải toàn bộ T12.** §3.2 và §12 quy định lớp chính là *SA
 * token của Kubernetes + TokenReview*, cộng NetworkPolicy; với `PATCH /internal/rules/:id` của S2
 * còn thêm phép kiểm lease (`assertFencing`) — "chỉ có token hợp lệ là chưa đủ". §9 cho phép
 * "mTLS **hoặc** shared secret", nên bí mật dùng chung là hợp lệ, nhưng nó là lớp phòng khi
 * NetworkPolicy bị cấu hình sai chứ không phải lớp duy nhất. Guard đứng đúng chỗ §3.2 chỉ định để
 * ngày thêm TokenReview không phải sửa một call-site nào.
 */

/**
 * So sánh hằng thời gian.
 *
 * `timingSafeEqual` ném khi hai buffer khác độ dài, mà độ dài chính là thứ kẻ tấn công điều
 * khiển được. Băm cả hai trước rồi so 32 byte cố định: vừa tránh được cái ném đó, vừa không rò
 * rỉ độ dài bí mật qua thời gian phản hồi.
 */
function secretMatches(provided: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(env.INTERNAL_SERVICE_SECRET).digest();
  return timingSafeEqual(a, b);
}

export const requireInternalCaller: RequestHandler = (req, _res, next) => {
  const provided = req.get(INTERNAL_SECRET_HEADER);

  if (
    provided === undefined ||
    provided.length === 0 ||
    !secretMatches(provided)
  ) {
    /**
     * Một thông điệp duy nhất cho cả "thiếu header" lẫn "sai bí mật". Phân biệt hai ca là nói
     * cho người dò biết họ đã đi đúng nửa đường.
     */
    next(new UnauthenticatedError("Lời gọi nội bộ không hợp lệ"));
    return;
  }

  next();
};

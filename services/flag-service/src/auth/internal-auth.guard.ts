import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { env } from "@udp/config";
import { UnauthenticatedError, ValidationError } from "@udp/http";
import { UUID_PATTERN } from "../core/uuid.js";

/**
 * Xác thực lời gọi máy-tới-máy vào `/internal/*` (§9, §12 T12).
 *
 * **Đây là BƯỚC MỘT của T12, không phải toàn bộ T12.** §3.2 và §12 quy định lớp
 * chính là *SA token của Kubernetes + TokenReview*, cộng NetworkPolicy, và với
 * `PATCH /internal/rules/:id` còn thêm một điều kiện nữa: S2 phải kiểm `ruleId`
 * có thuộc `RolloutSession` mà bên gọi đang giữ lease hay không — "chỉ có token
 * hợp lệ là chưa đủ" (phép kiểm đó: `assertFencing` ở `modules/rule/`). §9 cho
 * phép "mTLS **hoặc** shared secret", nên bí mật dùng chung là hợp lệ, nhưng nó
 * là lớp phòng khi NetworkPolicy bị cấu hình sai chứ không phải lớp duy nhất.
 *
 * Chưa có cluster nên chưa có TokenReview để gọi. Đặt guard ở đúng chỗ §3.2 chỉ
 * định để ngày thêm TokenReview không phải sửa một call-site nào.
 */

const HEADER = "X-Internal-Secret";

/**
 * Header mang danh tính người dùng đã được Service 1 xác thực.
 *
 * `ConfigChangeLog.actor_user_id` cần biết AI đổi cấu hình, nhưng S2 không có
 * quyền đọc bảng `users` (§1.2) và không thấy cookie phiên. S1 là bên đã xác
 * thực người dùng, nên nó truyền id xuống.
 *
 * Tin được header này chỉ vì lời gọi đã qua bí mật dùng chung ở trên — không có
 * bước đó thì bất kỳ ai cũng tự khai mình là bất kỳ ai. Thứ tự middleware vì thế
 * không phải chuyện phong cách. NULL là hợp lệ và có nghĩa: §2.2 ghi "NULL =
 * Service 3 khi rollout", vì lúc đó không có người dùng nào bấm gì cả.
 */
const ACTOR_HEADER = "X-Udp-Actor-Id";

/**
 * So sánh hằng thời gian.
 *
 * `timingSafeEqual` ném khi hai buffer khác độ dài, mà độ dài chính là thứ kẻ
 * tấn công điều khiển được. Băm cả hai trước rồi so 32 byte cố định: vừa tránh
 * được cái ném đó, vừa không rò rỉ độ dài bí mật qua thời gian phản hồi.
 */
function secretMatches(provided: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(env.INTERNAL_SERVICE_SECRET).digest();
  return timingSafeEqual(a, b);
}

export const requireInternalCaller: RequestHandler = (req, _res, next) => {
  const provided = req.get(HEADER);

  if (
    provided === undefined ||
    provided.length === 0 ||
    !secretMatches(provided)
  ) {
    /**
     * Một thông điệp duy nhất cho cả "thiếu header" lẫn "sai bí mật". Phân biệt
     * hai ca là nói cho người dò biết họ đã đi đúng nửa đường.
     */
    next(new UnauthenticatedError("Lời gọi nội bộ không hợp lệ"));
    return;
  }

  next();
};

/** Id người dùng do Service 1 truyền xuống, hoặc `undefined` nếu Service 3 gọi */
export function actorOf(req: Request): string | undefined {
  const raw = req.get(ACTOR_HEADER);
  if (raw === undefined || raw.length === 0) return undefined;

  if (!UUID_PATTERN.test(raw)) {
    throw new ValidationError(`${ACTOR_HEADER} phải là UUID`);
  }

  return raw;
}

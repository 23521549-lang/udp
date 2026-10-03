import type { Request } from "express";
import { ACTOR_HEADER, CLIENT_IP_HEADER, CLIENT_UA_HEADER } from "@udp/config";
import { UUID_PATTERN, ValidationError, type AuditContext } from "@udp/http";

/**
 * Cổng `/internal/*` (§9, §12 T12) sống ở `@udp/http` — Service 1 cũng mở route nội bộ cho
 * Service 3 (Plan #39), và hai bản chép là hai chỗ để một bản sửa lọt mất một bên.
 */
export { requireInternalCaller } from "@udp/http";

/**
 * Id người dùng do Service 1 truyền xuống (header `ACTOR_HEADER`), hoặc
 * `undefined` nếu Service 3 gọi.
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
export function actorOf(req: Request): string | undefined {
  const raw = req.get(ACTOR_HEADER);
  if (raw === undefined || raw.length === 0) return undefined;

  if (!UUID_PATTERN.test(raw)) {
    throw new ValidationError(`${ACTOR_HEADER} phải là UUID`);
  }

  return raw;
}

/**
 * [v4.5] Ngữ cảnh audit của một lời gọi GHI cấu hình từ Service 1: ai (BẮT BUỘC)
 * và từ đâu (IP, UA của người dùng mà S1 chuyển tiếp). Thiếu actor là lỗi hợp
 * đồng giữa hai service — một hàng audit không có người làm thì vô dụng (§2.2),
 * nên 400 thay vì ghi ẩn danh. IP sai dạng bị `auditEntry` bỏ, không làm hỏng
 * thay đổi.
 */
export function auditContextOf(req: Request): AuditContext & {
  actorUserId: string;
} {
  const actorUserId = actorOf(req);
  if (actorUserId === undefined) {
    throw new ValidationError(
      `Thiếu ${ACTOR_HEADER} — lời gọi ghi cấu hình phải nói ai làm`,
    );
  }
  return {
    actorUserId,
    ip: req.get(CLIENT_IP_HEADER),
    userAgent: req.get(CLIENT_UA_HEADER),
  };
}

import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { RATE_LIMIT } from "@udp/config";
import { buildProblem, sendProblem } from "@udp/http";

/**
 * Dùng `handler` chứ KHÔNG dùng `message`.
 *
 * `message` là một object tĩnh, được đóng băng lúc khởi tạo middleware — trước
 * khi có bất kỳ request nào. Nghĩa là nó không thể mang `instance` (URI của
 * request) hay `traceId`, hai trường mà RFC 9457 và §9 yêu cầu. `handler` nhận
 * được `req` nên dựng được `ProblemDetails` đầy đủ, giống hệt năm chỗ phát sinh
 * lỗi còn lại.
 */
const shared = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response): void => {
    sendProblem(
      res,
      buildProblem({
        req,
        status: 429,
        title: "Too many requests",
        detail: "Quá nhiều yêu cầu, vui lòng thử lại sau",
        typeSlug: "rate-limited",
      }),
    );
  },
} as const;

/**
 * Giới hạn chặt cho endpoint xác thực.
 *
 * Không có nó, `POST /auth/login` là công cụ dò mật khẩu miễn phí: bcrypt tuy
 * chậm nhưng kẻ tấn công có thể chạy song song hàng nghìn kết nối. Đây cũng là
 * lớp phòng vệ trước việc dò xem email nào đã đăng ký.
 */
/**
 * Khoá đếm cho endpoint xác thực: IP **và** danh tính được nhắm tới.
 *
 * Chỉ đếm theo IP là chưa đủ ở cả hai chiều:
 *
 *  - IPv6 cấp cho một người dùng cả một dải /64, nên "mỗi địa chỉ một bucket"
 *    nghĩa là hàng tỷ bucket miễn phí, không cần giả mạo header nào.
 *    `express-rate-limit@7.5.1` KHÔNG export `ipKeyGenerator` (đã kiểm file
 *    khai báo kiểu), nên phải tự gộp — xem `ipKey`.
 *  - Credential stuffing PHÂN TÁN nhắm vào MỘT tài khoản đi qua hàng nghìn IP
 *    khác nhau, nên không ngưỡng theo IP nào chặn được. Thêm email vào khoá làm
 *    số lần thử trên một tài khoản bị đếm bất kể đến từ đâu.
 *
 * Email băm chứ không để nguyên: khoá của rate limiter nằm trong bộ nhớ và có
 * thể lộ ra qua log hay công cụ chẩn đoán, mà email là dữ liệu cá nhân.
 */
export function ipKey(raw: string): string {
  const ip = (raw.split("%")[0] ?? "").trim(); // bỏ zone id kiểu fe80::1%eth0
  if (!ip.includes(":")) return ip; // IPv4
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length); // IPv4 ánh xạ

  // Gộp về /64: phải KHAI TRIỂN dạng rút gọn trước, vì "2001:db8::1" chỉ có 4
  // đoạn khi split nhưng đoạn thứ tư là phần ĐUÔI của địa chỉ, không phải nhóm
  // thứ tư. Cắt thẳng bốn phần tử đầu sẽ cho ra một tiền tố sai.
  let groups: string[];
  if (ip.includes("::")) {
    const [head = "", tail = ""] = ip.split("::");
    const h = head === "" ? [] : head.split(":");
    const t = tail === "" ? [] : tail.split(":");
    groups = [
      ...h,
      ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"),
      ...t,
    ];
  } else {
    groups = ip.split(":");
  }

  return `${groups
    .slice(0, 4)
    .map((g) => (g === "" ? "0" : g))
    .join(":")}::/64`;
}

function authRateKey(req: Request): string {
  const ip = ipKey(req.ip ?? "");
  const body: unknown = req.body;
  const email =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { email?: unknown }).email === "string"
      ? (body as { email: string }).email.trim().toLowerCase()
      : "";
  if (email === "") return ip;
  return `${ip}|${createHash("sha256").update(email).digest("base64url").slice(0, 16)}`;
}

export const authRateLimiter = rateLimit({
  ...shared,
  windowMs: RATE_LIMIT.auth.windowMs,
  limit: RATE_LIMIT.auth.max,
  keyGenerator: authRateKey,
});

export const generalRateLimiter = rateLimit({
  ...shared,
  windowMs: RATE_LIMIT.general.windowMs,
  limit: RATE_LIMIT.general.max,
});

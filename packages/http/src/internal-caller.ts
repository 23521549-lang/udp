import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env, INTERNAL_SECRET_HEADER } from "@udp/config";
import { ServiceUnavailableError, UnauthenticatedError } from "./errors.js";
import { logger } from "./logger.js";

/**
 * Xác thực lời gọi máy-tới-máy vào `/internal/*` (§9, §12 T12) — MỘT hiện thực cho mọi service
 * có route nội bộ: Service 2 (bên gọi S1, S3) và Service 1 (bên gọi S3, Plan #39). Hai bản chép
 * là hai chỗ để một bản sửa lọt mất một bên.
 *
 * Ba lớp của T12, từ ngoài vào: NetworkPolicy theo cổng nội bộ (Plan #66); danh tính bên gọi bằng
 * token chiếu của ServiceAccount hỏi qua `TokenReview` (`requireInternalIdentity`, Plan #67 - mount ở
 * cấp app, chỉ khi chạy trong cụm); và bí mật dùng chung (`requireInternalCaller`, mỗi route). Ngoài
 * cụm (dev, test) bí mật là lớp duy nhất. Với `PATCH /internal/rules/:id` của S2 còn thêm phép kiểm
 * lease (`assertFencing`) — "chỉ có token hợp lệ là chưa đủ".
 */

/** Một thông điệp cho MỌI lần từ chối, ở cả hai lớp: phân biệt các ca là nói cho người dò biết họ đã đi đúng nửa đường */
const REJECTED = "Lời gọi nội bộ không hợp lệ";

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
    next(new UnauthenticatedError(REJECTED));
    return;
  }

  next();
};

/**
 * [Plan #67] Hỏi ai đứng sau một token. Trả username (`system:serviceaccount:<ns>:<tên>`) khi token hợp lệ, `null` khi
 * không; NÉM khi không hỏi được (API server vắng) - để bên dùng đóng cửa bằng 503 chứ không nhầm thành "token sai".
 * Hiện thực `TokenReview`: `@udp/cluster-access/in-cluster`.
 */
export interface CallerVerifier {
  verify(token: string): Promise<string | null>;
}

export interface InternalIdentityLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface InternalIdentityOptions {
  verifier: CallerVerifier;
  /** Username được gọi service này - `INTERNAL_CALLERS` của `@udp/config/constants` */
  callers: readonly string[];
  log?: InternalIdentityLog;
}

const BEARER = /^Bearer ([^\s]+)$/;

/**
 * [Plan #67] Lớp danh tính của T12. Mount bằng `app.use("/internal", …)` ngay sau `internalPortOnly`, TRƯỚC parser:
 * mọi route nội bộ đều qua, request chưa xác thực không được parse body.
 *
 * Tự log lời từ chối (`reason`, và `username` khi biết) vì ở Service 1 nó đứng trước `requestLogger` - KHÔNG BAO GIỜ
 * log token.
 */
export function requireInternalIdentity(
  options: InternalIdentityOptions,
): RequestHandler {
  const callers = new Set(options.callers);
  const log = options.log ?? logger;
  const reject = (
    next: Parameters<RequestHandler>[2],
    reason: string,
    username?: string,
  ): void => {
    log.warn(
      username === undefined ? { reason } : { reason, username },
      "Từ chối lời gọi nội bộ",
    );
    next(new UnauthenticatedError(REJECTED));
  };

  return (req, _res, next) => {
    const token = BEARER.exec(req.get("authorization") ?? "")?.[1];
    if (token === undefined) {
      reject(next, "missing");
      return;
    }
    options.verifier.verify(token).then(
      (username) => {
        if (username === null) {
          reject(next, "invalid");
        } else if (!callers.has(username)) {
          reject(next, "unknown-caller", username);
        } else {
          next();
        }
      },
      (err: unknown) => {
        log.warn(
          {
            reason: "verifier-unavailable",
            cause: err instanceof Error ? err.message : String(err),
          },
          "Không xác minh được bên gọi nội bộ",
        );
        next(new ServiceUnavailableError("Chưa xác minh được bên gọi nội bộ"));
      },
    );
  };
}

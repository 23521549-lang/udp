import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
} from "express";
import { buildProblem, sendProblem } from "./problem.js";

/**
 * [v4.9] Parser JSON toàn cục chừa ra những đường có parser RIÊNG (§9, V15).
 *
 * Service 1 buộc phải giữ parser toàn cục (CSRF và limiter đứng sau nó đọc body),
 * nhưng đường ghi segment cần trần 16 MiB, và body cỡ đó chỉ được parse SAU khi
 * đã qua xác thực và quyền — request vô danh không được tiêu CPU của ai. Parser
 * toàn cục chạy trước thì chặn 413 ở 1 MB và đường riêng không bao giờ tới lượt;
 * nên đường riêng phải được CHỪA RA ở đây, và tự parse sau guard của nó.
 *
 * `skip` là vị từ trên `normalizedPathOf` — một nơi khai đường dẫn, dùng cho cả
 * router lẫn vị từ, để hai bên không trôi khỏi nhau.
 */
export function jsonBodyExcept(
  skip: (req: Request) => boolean,
  limit: string,
): RequestHandler {
  const parse = express.json({ limit });
  return (req, res, next) => {
    if (skip(req)) {
      next();
      return;
    }
    parse(req, res, next);
  };
}

/**
 * Đường dẫn theo đúng cách Express KHỚP route: không phân biệt hoa thường, bỏ `/`
 * cuối. Vị từ so khớp trên chuỗi thô sẽ trượt `/API/V1/…/SEGMENTS/` — Express vẫn
 * đưa request đó tới route segment, còn parser toàn cục thì đã parse body trước
 * guard, đúng thứ mà việc chừa đường ra sinh ra để tránh.
 */
export function normalizedPathOf(req: Request): string {
  const path = req.path.toLowerCase().replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

/**
 * [v4.9] Body vượt trần của parser riêng ⇒ 413 problem+json, không 500.
 *
 * `errorHandler` chung dịch được JSON hỏng (400) nhưng không biết
 * `entity.too.large`, nên thiếu chỗ này thì một body quá trần trả "Lỗi hệ thống" —
 * sai cả status lẫn ý nghĩa, và bảo client cứ thử lại một request không bao giờ
 * đúng. Mọi lỗi khác đi tiếp tới `errorHandler` chung.
 *
 * Đặt ở đây, cạnh `jsonBodyExcept`: mọi đường có parser riêng đều cần đúng cái
 * này, và ba bản chép ở ba bề mặt (stats, segment của S1, segment của S2) là ba
 * chỗ có thể trôi khỏi nhau.
 */
export const jsonTooLargeHandler =
  (detail: string): ErrorRequestHandler =>
  (err, req, res, next) => {
    if ((err as { type?: unknown }).type !== "entity.too.large") {
      next(err);
      return;
    }
    sendProblem(
      res,
      buildProblem({
        req,
        status: 413,
        title: "Payload too large",
        detail,
        typeSlug: "payload-too-large",
      }),
    );
  };

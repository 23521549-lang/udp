import type { AccessTokenPayload } from "../core/security/tokens.js";

/**
 * Gắn thêm `req.user` vào kiểu Request của Express.
 *
 * Nhờ vậy mọi handler truy cập `req.user` đều có kiểu đầy đủ — không phải ép
 * `(req as any).user` ở từng chỗ, vốn làm mất khả năng kiểm tra của TypeScript
 * đúng tại nơi cần nó nhất là logic phân quyền.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

export {};

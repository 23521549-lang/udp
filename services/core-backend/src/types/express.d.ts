import type { ProjectRole } from "@udp/db";
import type { AccessTokenPayload } from "../core/security/tokens.js";

/**
 * Gắn thêm `req.user` vào kiểu Request của Express.
 *
 * Nhờ vậy mọi handler truy cập `req.user` đều có kiểu đầy đủ — không phải ép
 * `(req as any).user` ở từng chỗ, vốn làm mất khả năng kiểm tra của TypeScript
 * đúng tại nơi cần nó nhất là logic phân quyền.
 */
declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
      /**
       * Vai tro cua nguoi goi TRONG project cua route nay.
       *
       * Chi co mat sau khi `requireMinProjectRole` chay xong. Tuyet doi khong
       * gan `undefined` tuong minh o dau: voi `exactOptionalPropertyTypes`, do
       * la loi bien dich chu khong phai cach xoa truong.
       */
      projectRole?: ProjectRole;
    }
  }
}

export {};

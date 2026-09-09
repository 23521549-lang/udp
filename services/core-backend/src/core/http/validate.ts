import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

/**
 * Validate body bằng Zod rồi GHI ĐÈ `req.body` bằng dữ liệu đã parse.
 *
 * Việc ghi đè quan trọng hơn vẻ ngoài của nó. Sau bước này `req.body`:
 *  - đã đúng kiểu,
 *  - đã bị cắt bỏ mọi trường thừa client gửi kèm (chống mass assignment),
 *  - đã được áp giá trị mặc định và chuẩn hoá (trim, lowercase).
 *
 * Nhờ vậy handler phía sau không phải kiểm tra lại lần nào nữa. `ZodError`
 * được `errorHandler` bắt và chuyển thành 400 kèm chi tiết từng trường.
 */
export const validateBody =
  <T>(schema: ZodSchema<T>): RequestHandler =>
  (req, _res, next) => {
    req.body = schema.parse(req.body);
    next();
  };

/**
 * Tương tự cho query string — dùng khi có phân trang, bộ lọc.
 *
 * GÁN ĐÈ chứ không `Object.assign`. Bản trước merge kết quả parse lên object
 * gốc nên trường thừa vẫn nằm nguyên đó, tức là mất đúng tính chất mà khối chú
 * thích đầu file quảng cáo — chống mass assignment. Chưa route nào dùng hàm
 * này, nên đó là một quả mìn đặt sẵn cho người gọi đầu tiên.
 */
export const validateQuery =
  <T>(schema: ZodSchema<T>): RequestHandler =>
  (req, _res, next) => {
    req.query = schema.parse(req.query) as typeof req.query;
    next();
  };

import type { Response } from "express";
import type { ZodType } from "zod";
import { ResponseContractError } from "./errors.js";
import { logger } from "./logger.js";

/**
 * [v4.11] Gửi response QUA một schema — hợp đồng bị cưỡng chế từ phía SERVER.
 *
 * Vì sao cần: Portal (Plan #25) dựng trên những schema `*Wire` dùng chung. Nếu chỉ client
 * `parse` chiều vào thì hợp đồng chỉ được kiểm ở một đầu, và một lần đổi hình response ở
 * controller sẽ lộ ra dưới dạng một màn hình trắng — sau nhiều pha, và ở máy người khác.
 * Cho server serialize qua chính schema đó biến nó thành một test ĐỎ của server.
 *
 * **Ba quyết định, mỗi cái sửa một cách hỏng đã được chỉ ra:**
 *
 * 1. **`safeParse` rồi ném `ResponseContractError` (500), tuyệt đối không để `ZodError`
 *    thoát ra.** `errorHandler` bắt `ZodError` **trước** mọi nhánh khác và trả **400 "Dữ
 *    liệu gửi lên không hợp lệ"** kèm đường dẫn trường — tức một bug của server hiện ra
 *    như lỗi của người dùng, và nhánh đó không log gì cả. Người dùng sẽ ngồi sửa form cho
 *    một lỗi họ không gây ra.
 * 2. **Gửi `data`, KHÔNG gửi kết quả parse.** Zod bỏ khoá lạ, nên gửi bản đã parse sẽ
 *    **im lặng cắt** bất cứ thứ gì controller thêm mà schema chưa biết. Ở đây parse để
 *    KIỂM; lệch hình thì ném, không tự sửa. (Điều kiện đi kèm: mọi schema wire phải
 *    `.strict()`, nếu không một trường thừa vẫn lọt lên dây mà không ai đỏ.)
 * 3. **Parse TRƯỚC khi ghi.** `res.json()` của Express là đồng bộ, nên chỉ cần giữ thứ tự
 *    này là không bao giờ có chuyện "header đã gửi rồi mới phát hiện lệch". Viết
 *    `sendJson(res.status(201), …)` vẫn an toàn: `status` chỉ vào header lúc gửi.
 *
 * **Không dùng cho response LỖI.** Đường lỗi đi qua `sendProblem`, và nó có hợp đồng
 * riêng (`ProblemDetails`); gọi `sendJson` ở đó là chồng hai hợp đồng lên một response.
 */
export function sendJson<T>(
  res: Response,
  schema: ZodType<T>,
  data: T,
  status = 200,
): void {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const where = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(gốc)"}: ${i.message}`)
      .join("; ");
    /**
     * Log ở đây chứ không để `errorHandler` lo: lỗi này là bug của server, và người đọc
     * log cần biết ĐÚNG trường nào lệch. `errorHandler` chỉ thấy một message.
     */
    logger.error(
      { contract: where, path: res.req.originalUrl },
      "Response contract violation",
    );
    throw new ResponseContractError(
      `response không khớp schema đã khai (${where})`,
    );
  }
  res.status(status).json(data);
}

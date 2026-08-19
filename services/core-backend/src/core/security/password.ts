import bcrypt from "bcryptjs";
import { env } from "@udp/config";

/**
 * Bọc bcrypt để số vòng hash lấy từ cấu hình thay vì rải hằng số trong code.
 */
export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, env.BCRYPT_ROUNDS);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

/**
 * Hash giả dùng khi email không tồn tại.
 *
 * Nếu email sai thì hàm trả lỗi ngay, còn email đúng mà mật khẩu sai thì mất
 * ~100ms để bcrypt so sánh. Chênh lệch thời gian đó đủ để kẻ tấn công dò xem
 * email nào đã đăng ký (timing attack). Chạy một phép so sánh giả để hai nhánh
 * tốn thời gian tương đương.
 *
 * Chuỗi dưới đây là hash bcrypt hợp lệ của một mật khẩu ngẫu nhiên không ai
 * biết — giá trị cụ thể không quan trọng, chỉ cần bcrypt phải làm việc thật.
 */
const DUMMY_HASH =
  "$2a$12$C6UzMDM.H6dfI/f/IKcEe.WMSEXFHTDdMlBBRIhBqgAjEXo1t6Ohu";

export const dummyVerify = (plain: string): Promise<boolean> =>
  bcrypt.compare(plain, DUMMY_HASH);

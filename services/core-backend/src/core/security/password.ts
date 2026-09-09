import { randomBytes } from "node:crypto";
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
 * Hash được SINH LÚC KHỞI ĐỘNG theo đúng `env.BCRYPT_ROUNDS`, không ghim cứng.
 *
 * Bản trước ghim `$2a$12$...`. Với `BCRYPT_ROUNDS=14` — hợp lệ, thậm chí là
 * khuyến nghị bảo mật — nhánh "email tồn tại" tốn gấp bốn lần nhánh "không tồn
 * tại", và timing oracle quay lại nguyên vẹn. Thông báo lỗi hợp nhất ở tầng
 * trên khi đó chỉ là trang trí: đo p50 độ trễ là biết email nào đã đăng ký.
 */
const DUMMY_HASH = bcrypt.hashSync(
  randomBytes(32).toString("base64"),
  env.BCRYPT_ROUNDS,
);

export const dummyVerify = (plain: string): Promise<boolean> =>
  bcrypt.compare(plain, DUMMY_HASH);

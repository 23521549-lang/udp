import { createHash } from "node:crypto";

/**
 * SHA-256 hex của một token bí mật do Service 1 tự sinh — refresh token, token lời mời (Plan #55).
 *
 * Chỉ lưu hash, không lưu token. Không cần salt như mật khẩu: token là chuỗi ngẫu nhiên entropy cao do chính ta
 * sinh, không phải thứ người dùng chọn, nên không có từ điển để dò và bảng cầu vồng vô nghĩa. Đổi lại, tra cứu
 * phải nhanh — mỗi lần refresh hay mở lời mời là một lần tra, còn bcrypt thì cố ý chậm.
 */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

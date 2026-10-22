/**
 * Tham số URL của trang đăng nhập và đăng ký. Giá trị lạ bị bỏ, không ghi ra.
 *
 * - `redirectTo`: nơi quay lại sau khi đăng nhập (qua `safeRedirect`).
 * - [Plan #60 QĐ-8] `oauth`: MÃ kết cục của một lần quay về từ GitHub mà máy chủ đặt — Portal viết câu theo ngôn ngữ.
 * - [Plan #60 QĐ-7] `reset=done`: vừa đổi mật khẩu xong, trang đăng nhập nói một câu xác nhận.
 */
export const OAUTH_CODES = [
  "email_taken",
  "no_account",
  "no_email",
  "denied",
  "failed",
] as const;
export type OAuthCode = (typeof OAUTH_CODES)[number];

export interface AuthSearch {
  redirectTo?: string;
  oauth?: OAuthCode;
  reset?: "done";
}

export function authSearch(s: Record<string, unknown>): AuthSearch {
  const out: AuthSearch = {};
  if (typeof s.redirectTo === "string" && s.redirectTo.trim() !== "") {
    out.redirectTo = s.redirectTo;
  }
  const oauth = OAUTH_CODES.find((c) => c === s.oauth);
  if (oauth !== undefined) out.oauth = oauth;
  if (s.reset === "done") out.reset = "done";
  return out;
}

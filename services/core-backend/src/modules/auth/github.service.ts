import { currentConsent, startSession } from "./auth.service.js";
import * as repository from "./auth.repository.js";
import type { GithubProfile } from "./github.client.js";
import type { OAuthState } from "./oauth-state.js";
import type { SessionContext } from "./refresh-session.repository.js";
import type { AuthResult } from "./auth.types.js";

/**
 * [v4.12, Plan #60 QĐ-8] Kết cục của một lần quay về từ GitHub — quyết định ở đây, controller chỉ đổi thành chuyển hướng.
 *
 * - Danh tính GitHub đã liên kết ⇒ đăng nhập người đó.
 * - Chưa liên kết, email chính đã xác minh CHƯA có tài khoản, người dùng đến từ trang đăng ký và đã tích ô đồng ý ⇒
 *   tạo tài khoản (không mật khẩu) kèm liên kết.
 * - Email ĐÃ có tài khoản ⇒ KHÔNG tự liên kết: UDP chưa xác minh email lúc đăng ký bằng mật khẩu, nên ai đó có thể đã
 *   đăng ký trước bằng email của người khác rồi chờ chủ thật đăng nhập GitHub để chiếm tài khoản (pre-account
 *   hijacking). Người dùng đăng nhập bằng mật khẩu (hay đặt lại qua thư — chứng minh sở hữu hộp thư).
 * - Chưa có tài khoản mà đến từ trang đăng nhập (chưa đồng ý điều khoản) ⇒ về trang đăng ký.
 */
export type GithubOutcome =
  | { kind: "signed-in"; result: AuthResult }
  | { kind: "email-taken" }
  | { kind: "no-account" }
  | { kind: "no-email" };

export async function githubSignIn(
  profile: GithubProfile,
  state: Pick<OAuthState, "intent" | "acceptTerms">,
  ctx: SessionContext,
): Promise<GithubOutcome> {
  const linked = await repository.findByIdentity("GITHUB", profile.id);
  if (linked !== null) {
    return { kind: "signed-in", result: await startSession(linked, ctx) };
  }
  if (profile.email === null) return { kind: "no-email" };
  if ((await repository.findPublicByEmail(profile.email)) !== null) {
    return { kind: "email-taken" };
  }
  if (state.intent !== "register" || !state.acceptTerms) {
    return { kind: "no-account" };
  }
  const user = await repository.createWithIdentity(
    {
      email: profile.email,
      name: (profile.name ?? "").trim() || profile.login,
      ...currentConsent(),
    },
    { provider: "GITHUB", providerUserId: profile.id },
  );
  return { kind: "signed-in", result: await startSession(user, ctx) };
}

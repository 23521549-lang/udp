import { z } from "zod";

/**
 * [v4.12, Plan #60 QĐ-8] OAuth App của GitHub, phía máy chủ (client có bí mật): dựng đường dẫn uỷ quyền, đổi `code`
 * lấy access token, đọc hồ sơ và email CHÍNH ĐÃ XÁC MINH. Token của GitHub chỉ sống trong một lời gọi này, UDP không
 * lưu. `fetch` tiêm được: test không bao giờ gọi GitHub thật.
 */

export interface GithubProfile {
  /** Id số, bất biến — khoá liên kết; `login` và email đổi được nên không dùng làm khoá */
  id: string;
  login: string;
  name: string | null;
  /** Email chính đã xác minh; `null` khi tài khoản GitHub không có (UDP cần email để tạo tài khoản) */
  email: string | null;
}

export interface GithubOAuth {
  authorizeUrl(state: string, redirectUri: string): string;
  exchange(code: string, redirectUri: string): Promise<GithubProfile>;
}

/** GitHub trả lỗi, hay trả hình lạ — bên gọi chuyển thành một lần đăng nhập thất bại có lý do */
export class GithubOAuthError extends Error {}

const TIMEOUT_MS = 10_000;

const tokenReply = z.union([
  z.object({ access_token: z.string().min(1) }),
  z.object({ error: z.string(), error_description: z.string().optional() }),
]);
const userReply = z.object({
  id: z.number().int(),
  login: z.string(),
  name: z.string().nullable(),
});
const emailsReply = z.array(
  z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }),
);

export function githubOAuth(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): GithubOAuth {
  const getJson = async (url: string, token: string): Promise<unknown> => {
    const res = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "udp-core-backend",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok)
      throw new GithubOAuthError(`GitHub ${url} → ${String(res.status)}`);
    return res.json();
  };

  return {
    authorizeUrl(state, redirectUri) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      // Hồ sơ công khai + email (kể cả email ẩn) — không xin quyền repo nào
      url.searchParams.set("scope", "read:user user:email");
      url.searchParams.set("state", state);
      url.searchParams.set("allow_signup", "true");
      return url.toString();
    },

    async exchange(code, redirectUri) {
      const res = await fetchImpl(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      const token = tokenReply.safeParse(await res.json());
      if (!token.success) throw new GithubOAuthError("GitHub trả hình lạ");
      if ("error" in token.data) throw new GithubOAuthError(token.data.error);
      const accessToken = token.data.access_token;

      const user = userReply.safeParse(
        await getJson("https://api.github.com/user", accessToken),
      );
      const emails = emailsReply.safeParse(
        await getJson("https://api.github.com/user/emails", accessToken),
      );
      if (!user.success || !emails.success) {
        throw new GithubOAuthError("GitHub trả hồ sơ lạ");
      }
      const primary = emails.data.find((e) => e.primary && e.verified);
      return {
        id: String(user.data.id),
        login: user.data.login,
        name: user.data.name,
        email: primary?.email.toLowerCase() ?? null,
      };
    },
  };
}

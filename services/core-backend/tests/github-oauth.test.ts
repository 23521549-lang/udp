import { describe, expect, it } from "vitest";
import {
  githubOAuth,
  GithubOAuthError,
} from "../src/modules/auth/github.client.js";
import {
  newOAuthState,
  verifyOAuthState,
} from "../src/modules/auth/oauth-state.js";

/**
 * [v4.12, Plan #60 QĐ-8] Hai mảnh thuần của đăng nhập GitHub: cookie `state` đã ký (chống login CSRF, không cho sửa
 * ý định) và client OAuth (đọc email chính ĐÃ XÁC MINH) — không mạng, không database.
 */

describe("state của OAuth trong cookie đã ký", () => {
  const input = {
    intent: "register" as const,
    acceptTerms: true,
    redirectTo: "/app/projects",
  };

  it("đúng cookie và đúng state ⇒ trả ý định; mọi sai lệch ⇒ null", () => {
    const now = 1_800_000_000_000;
    const { state, cookie } = newOAuthState(input, now);
    expect(verifyOAuthState(cookie, state.state, now)).toMatchObject(input);
    // state GitHub trả về khác
    expect(verifyOAuthState(cookie, `${state.state}x`, now)).toBeNull();
    // người dùng sửa thân cookie (bật acceptTerms) ⇒ chữ ký không khớp
    const [body, mac] = cookie.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8")),
        acceptTerms: true,
        redirectTo: "https://evil.example",
      }),
    ).toString("base64url");
    expect(
      verifyOAuthState(`${forged}.${mac ?? ""}`, state.state, now),
    ).toBeNull();
    // hết hạn sau 10 phút
    expect(verifyOAuthState(cookie, state.state, now + 600_001)).toBeNull();
    // thiếu cookie
    expect(verifyOAuthState(undefined, state.state, now)).toBeNull();
  });
});

describe("client OAuth của GitHub", () => {
  const reply = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  const fake =
    (emails: unknown, token: unknown = { access_token: "gho_x" }) =>
    (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.endsWith("/login/oauth/access_token")) return reply(token);
      if (u.endsWith("/user"))
        return reply({ id: 42, login: "Octo", name: null });
      if (u.endsWith("/user/emails")) return reply(emails);
      return reply({}, 404);
    };

  it("đường dẫn uỷ quyền chỉ xin hồ sơ và email, kèm state và redirect_uri", () => {
    const url = new URL(
      githubOAuth("cid", "secret", fake([])).authorizeUrl(
        "st",
        "https://udp.example/api/v1/auth/github/callback",
      ),
    );
    expect(url.origin).toBe("https://github.com");
    expect(url.searchParams.get("scope")).toBe("read:user user:email");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("client_id")).toBe("cid");
  });

  it("email là email CHÍNH ĐÃ XÁC MINH, viết thường; id là chuỗi của id số", async () => {
    const gh = githubOAuth(
      "cid",
      "secret",
      fake([
        { email: "phu@x.vn", primary: false, verified: true },
        { email: "Chinh@X.vn", primary: true, verified: true },
      ]),
    );
    expect(await gh.exchange("code", "https://cb")).toEqual({
      id: "42",
      login: "Octo",
      name: null,
      email: "chinh@x.vn",
    });
  });

  it("email chính chưa xác minh ⇒ không có email (UDP không tạo tài khoản bằng email chưa xác minh)", async () => {
    const gh = githubOAuth(
      "cid",
      "secret",
      fake([{ email: "a@x.vn", primary: true, verified: false }]),
    );
    expect((await gh.exchange("code", "https://cb")).email).toBeNull();
  });

  it("GitHub từ chối mã ⇒ GithubOAuthError", async () => {
    const gh = githubOAuth(
      "cid",
      "secret",
      fake([], { error: "bad_verification_code" }),
    );
    await expect(gh.exchange("code", "https://cb")).rejects.toBeInstanceOf(
      GithubOAuthError,
    );
  });
});

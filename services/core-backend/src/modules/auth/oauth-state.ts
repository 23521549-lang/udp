import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AUTH, env } from "@udp/config";
import { z } from "zod";

/**
 * [v4.12, Plan #60 QĐ-8] `state` của một lần đăng nhập GitHub, giữ trong cookie httpOnly ĐÃ KÝ (không lưu máy chủ).
 *
 * Hai việc: chống login CSRF (GitHub trả `state` về, phải khớp đúng cookie của trình duyệt này), và mang ý định của
 * người dùng qua chuyến đi sang GitHub — đăng nhập hay đăng ký, đã tích ô đồng ý chưa, quay về đâu. Chữ ký HMAC (khoá
 * dẫn xuất riêng, như CSRF) để người dùng không tự sửa `acceptTerms` hay `redirectTo` trong cookie.
 */

const OAUTH_KEY = createHmac("sha256", env.JWT_ACCESS_SECRET)
  .update("udp-oauth-v1")
  .digest();

const payloadSchema = z.object({
  state: z.string().min(20),
  intent: z.enum(["login", "register"]),
  acceptTerms: z.boolean(),
  redirectTo: z.string().nullable(),
  /** Epoch ms */
  exp: z.number(),
});
export type OAuthState = z.infer<typeof payloadSchema>;

const sign = (body: string): string =>
  createHmac("sha256", OAUTH_KEY).update(body).digest("base64url");

export function newOAuthState(
  input: Omit<OAuthState, "state" | "exp">,
  now: number = Date.now(),
): { state: OAuthState; cookie: string } {
  const state: OAuthState = {
    ...input,
    state: randomBytes(32).toString("base64url"),
    exp: now + AUTH.oauthStateTtlSeconds * 1000,
  };
  const body = Buffer.from(JSON.stringify(state)).toString("base64url");
  return { state, cookie: `${body}.${sign(body)}` };
}

/** Cookie hợp lệ, chưa hết hạn, và `state` GitHub trả về khớp đúng nó — không thì `null` */
export function verifyOAuthState(
  cookie: string | undefined,
  returnedState: string | undefined,
  now: number = Date.now(),
): OAuthState | null {
  if (cookie === undefined || returnedState === undefined) return null;
  const [body, mac] = cookie.split(".");
  if (body === undefined || mac === undefined) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success || parsed.data.exp <= now) return null;
  const a = Buffer.from(parsed.data.state);
  const b = Buffer.from(returnedState);
  return a.length === b.length && timingSafeEqual(a, b) ? parsed.data : null;
}

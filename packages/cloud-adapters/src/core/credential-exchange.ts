import {
  SecretBuffer,
  type CloudAuthKind,
  type CloudProvider,
  type CredentialMode,
  type ResolvedCredential,
} from "@udp/adapter-core";
import type { z } from "zod";
import { GatewayError } from "./gateway.js";

/**
 * Phần chung của việc đổi credential đã lưu thành credential ngắn hạn (§4.3), cho cả ba
 * cloud: đọc payload đã giải mã, gói kết quả vào `SecretBuffer`, và gọi endpoint token
 * OAuth 2.0 (Google, Entra ID) với lỗi đã phân loại.
 */

/** Credential tĩnh (khoá dài hạn) chỉ sống 15 phút trong RAM, dù token cloud còn hạn lâu hơn */
export const STATIC_CREDENTIAL_TTL_MS = 15 * 60 * 1000;

/** Payload đã giải mã ⇒ dữ liệu đúng schema; sai hình là lỗi cấu hình, không lộ nội dung */
export function parseStoredPayload<S extends z.ZodTypeAny>(
  schema: S,
  label: string,
  stored: SecretBuffer,
): z.infer<S> {
  return stored.use((buf) => {
    let json: unknown;
    try {
      json = JSON.parse(buf.toString("utf8"));
    } catch {
      throw new GatewayError(
        "configuration",
        `payload ${label} đã lưu không phải JSON`,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new GatewayError(
        "configuration",
        `payload ${label} đã lưu sai hình`,
      );
    }
    return parsed.data as z.infer<S>;
  });
}

export function resolvedCredential(
  provider: CloudProvider,
  mode: CredentialMode,
  authKind: CloudAuthKind,
  session: object,
  expiresAt: Date,
): ResolvedCredential {
  const payload = new SecretBuffer(JSON.stringify(session));
  return {
    provider,
    mode,
    authKind,
    payload,
    expiresAt,
    dispose: () => payload.dispose(),
  };
}

interface OAuthErrorBody {
  error?: string | { status?: string; message?: string };
}

/** Mã lỗi OAuth/Google/Entra nghĩa là "credential sai hoặc bị thu hồi" */
const PERMISSION_CODES =
  /invalid_grant|unauthorized_client|invalid_client|PERMISSION_DENIED|UNAUTHENTICATED/;

/**
 * Một lời gọi endpoint token. Thông báo lỗi chỉ gồm host, mã HTTP và mã lỗi — không bao
 * giờ body gửi đi (nó chứa secret hoặc assertion).
 */
export async function tokenEndpointCall<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<T> {
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch {
    throw new GatewayError("transient", `không tới được ${host}`);
  }
  const body = (await res.json().catch(() => ({}))) as T & OAuthErrorBody;
  if (res.ok) return body;
  const code =
    typeof body.error === "string" ? body.error : (body.error?.status ?? "");
  const permission =
    res.status === 401 || res.status === 403 || PERMISSION_CODES.test(code);
  throw new GatewayError(
    permission ? "permission" : res.status >= 500 ? "transient" : "permanent",
    `${host} ⇒ ${String(res.status)} ${code}`,
  );
}

export function requiredToken(
  token: string | undefined,
  issuer: string,
): string {
  if (token === undefined || token === "") {
    throw new GatewayError("transient", `${issuer} không trả access token`);
  }
  return token;
}

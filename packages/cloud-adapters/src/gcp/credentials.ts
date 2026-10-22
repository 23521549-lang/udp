import { createSign } from "node:crypto";
import type {
  CredentialMode,
  ResolvedCredential,
  SecretBuffer,
} from "@udp/adapter-core";
import { credentialPayloadSchemas } from "@udp/shared-types/cloud-api";
import type { z } from "zod";
import {
  parseStoredPayload,
  requiredToken as tokenOrThrow,
  resolvedCredential,
  STATIC_CREDENTIAL_TTL_MS,
  tokenEndpointCall,
} from "../core/credential-exchange.js";
import type { Fetch } from "./http.js";
import type { GcpSession } from "./session.js";

/**
 * Đổi credential GCP đã lưu thành access token ngắn hạn (Credential Manager §4.3).
 *
 * - `GCP_WIF` (mặc định, federation): token OIDC do UDP ký ⇒ STS của Google ⇒
 *   `generateAccessToken` của service account khách. UDP không giữ khoá nào của khách;
 *   khách thu hồi bằng cách xoá provider khỏi pool.
 * - `GCP_KEY` (dự phòng): khoá JSON của service account ⇒ JWT RS256 ⇒ access token; sống
 *   tối đa 15 phút trong RAM dù token Google còn hạn lâu hơn.
 * - `MANAGED`: service account của chính UDP qua metadata server.
 */

const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const STS_URI = "https://sts.googleapis.com/v1/token";
const METADATA_TOKEN =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
export { STATIC_CREDENTIAL_TTL_MS };
const SESSION_SECONDS = 3600;

/** Hình của payload ĐÃ LƯU theo `authKind` — một nguồn với form và API; MANAGED do UDP cấu hình */
export const gcpStoredPayloadSchemas = {
  GCP_WIF: credentialPayloadSchemas.GCP_WIF,
  GCP_KEY: credentialPayloadSchemas.GCP_KEY,
  MANAGED: credentialPayloadSchemas.GCP_WIF.pick({ gcpProjectId: true }),
} as const;

export interface GcpExchangeInput {
  mode: CredentialMode;
  authKind: "GCP_WIF" | "GCP_KEY";
  /** Payload đã giải mã — bên gọi `dispose()` sau khi hàm này trả về */
  stored: SecretBuffer;
  /** Token OIDC do UDP ký cho `audience` (Service 1 cấp — P5); chỉ GCP_WIF dùng */
  federationToken: (audience: string) => Promise<string>;
  fetch: Fetch;
  now?: () => number;
}

const parseStored = <K extends keyof typeof gcpStoredPayloadSchemas>(
  kind: K,
  stored: SecretBuffer,
): z.infer<(typeof gcpStoredPayloadSchemas)[K]> =>
  parseStoredPayload(gcpStoredPayloadSchemas[kind], kind, stored);

const base64url = (b: Buffer | string): string =>
  Buffer.from(b)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** JWT RS256 cho grant `jwt-bearer` (RFC 7523) — ký bằng khoá của service account */
export function serviceAccountAssertion(
  clientEmail: string,
  privateKeyPem: string,
  nowSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: clientEmail,
      scope: CLOUD_PLATFORM,
      aud: TOKEN_URI,
      iat: nowSeconds,
      exp: nowSeconds + SESSION_SECONDS,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(privateKeyPem))}`;
}

const resolved = (
  mode: CredentialMode,
  authKind: "GCP_WIF" | "GCP_KEY",
  session: GcpSession,
  expiresAt: Date,
): ResolvedCredential =>
  resolvedCredential("gcp", mode, authKind, session, expiresAt);

export async function exchangeGcpCredential(
  input: GcpExchangeInput,
): Promise<ResolvedCredential> {
  const now = input.now ?? Date.now;

  if (input.mode === "MANAGED") {
    const { gcpProjectId: project } = parseStored("MANAGED", input.stored);
    const t = await tokenEndpointCall<{
      access_token?: string;
      expires_in?: number;
    }>(input.fetch, METADATA_TOKEN, {
      headers: { "Metadata-Flavor": "Google" },
    });
    return resolved(
      "MANAGED",
      input.authKind,
      { accessToken: requiredToken(t.access_token), gcpProjectId: project },
      new Date(now() + (t.expires_in ?? SESSION_SECONDS) * 1000),
    );
  }

  if (input.authKind === "GCP_KEY") {
    const key = parseStored("GCP_KEY", input.stored);
    const assertion = serviceAccountAssertion(
      key.client_email,
      key.private_key,
      Math.floor(now() / 1000),
    );
    const t = await tokenEndpointCall<{ access_token?: string }>(
      input.fetch,
      TOKEN_URI,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      },
    );
    return resolved(
      "BYOC",
      "GCP_KEY",
      {
        accessToken: requiredToken(t.access_token),
        gcpProjectId: key.project_id,
      },
      new Date(now() + STATIC_CREDENTIAL_TTL_MS),
    );
  }

  const wif = parseStored("GCP_WIF", input.stored);
  const audience =
    `//iam.googleapis.com/projects/${wif.projectNumber}/locations/global/` +
    `workloadIdentityPools/${wif.poolId}/providers/${wif.providerId}`;
  const federated = await tokenEndpointCall<{ access_token?: string }>(
    input.fetch,
    STS_URI,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience,
        scope: CLOUD_PLATFORM,
        requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
        subjectToken: await input.federationToken(audience),
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      }),
    },
  );
  const impersonated = await tokenEndpointCall<{
    accessToken?: string;
    expireTime?: string;
  }>(
    input.fetch,
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${wif.serviceAccountEmail}:generateAccessToken`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredToken(federated.access_token)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: [CLOUD_PLATFORM],
        lifetime: `${String(SESSION_SECONDS)}s`,
      }),
    },
  );
  return resolved(
    "BYOC",
    "GCP_WIF",
    {
      accessToken: requiredToken(impersonated.accessToken),
      gcpProjectId: wif.gcpProjectId,
    },
    impersonated.expireTime === undefined
      ? new Date(now() + SESSION_SECONDS * 1000)
      : new Date(impersonated.expireTime),
  );
}

function requiredToken(token: string | undefined): string {
  return tokenOrThrow(token, "Google");
}

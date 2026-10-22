import type {
  CredentialMode,
  ResolvedCredential,
  SecretBuffer,
} from "@udp/adapter-core";
import { credentialPayloadSchemas } from "@udp/shared-types/cloud-api";
import type { z } from "zod";
import {
  parseStoredPayload,
  requiredToken,
  resolvedCredential,
  STATIC_CREDENTIAL_TTL_MS,
  tokenEndpointCall,
} from "../core/credential-exchange.js";
import type { Fetch } from "./http.js";
import type { AzureSession } from "./session.js";

/**
 * Đổi credential Azure đã lưu thành hai access token ngắn hạn (Credential Manager §4.3):
 * một cho ARM, một cho API server AKS (Entra ID) — cùng một service principal.
 *
 * - `AZURE_FEDERATED` (mặc định): client assertion là token OIDC do UDP ký (subject
 *   `project:<id>`, audience `api://AzureADTokenExchange`). UDP không giữ bí mật nào của
 *   khách; khách thu hồi bằng cách xoá federated credential khỏi app registration.
 * - `AZURE_SECRET` (dự phòng): client secret; bản trong RAM sống tối đa 15 phút.
 * - `MANAGED`: managed identity của chính UDP qua IMDS.
 */

export const AZURE_FEDERATION_AUDIENCE = "api://AzureADTokenExchange";
/** Ứng dụng máy chủ AKS của Entra ID — id cố định trên mọi tenant */
const AKS_SERVER_APP = "6dae42f8-4368-4678-94ff-3960e28e3630";
const ARM_RESOURCE = "https://management.azure.com";
const IMDS_TOKEN = "http://169.254.169.254/metadata/identity/oauth2/token";

/** Hình của payload ĐÃ LƯU theo `authKind` — một nguồn với form và API; MANAGED do UDP cấu hình */
export const azureStoredPayloadSchemas = {
  AZURE_FEDERATED: credentialPayloadSchemas.AZURE_FEDERATED,
  AZURE_SECRET: credentialPayloadSchemas.AZURE_SECRET,
  MANAGED: credentialPayloadSchemas.AZURE_FEDERATED.pick({
    subscriptionId: true,
    resourceGroup: true,
  }),
} as const;

export interface AzureExchangeInput {
  mode: CredentialMode;
  authKind: "AZURE_FEDERATED" | "AZURE_SECRET";
  /** Payload đã giải mã — bên gọi `dispose()` sau khi hàm này trả về */
  stored: SecretBuffer;
  /** Token OIDC do UDP ký cho `audience` (Service 1 cấp — P5); chỉ AZURE_FEDERATED dùng */
  federationToken: (audience: string) => Promise<string>;
  fetch: Fetch;
  now?: () => number;
}

interface IssuedToken {
  token: string;
  expiresAt: number;
}

const parseStored = <K extends keyof typeof azureStoredPayloadSchemas>(
  kind: K,
  stored: SecretBuffer,
): z.infer<(typeof azureStoredPayloadSchemas)[K]> =>
  parseStoredPayload(azureStoredPayloadSchemas[kind], kind, stored);

const resolved = (
  mode: CredentialMode,
  authKind: "AZURE_FEDERATED" | "AZURE_SECRET",
  session: AzureSession,
  expiresAt: Date,
): ResolvedCredential =>
  resolvedCredential("azure", mode, authKind, session, expiresAt);

/** Entra ID trả `expires_in` là số, IMDS trả chuỗi — đọc cả hai */
const secondsOf = (v: number | string | undefined): number =>
  Number(v ?? 0) || 3600;

async function clientCredentialsToken(
  input: AzureExchangeInput,
  tenantId: string,
  clientId: string,
  proof: Record<string, string>,
  scope: string,
  now: number,
): Promise<IssuedToken> {
  const res = await tokenEndpointCall<{
    access_token?: string;
    expires_in?: number | string;
  }>(
    input.fetch,
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        scope,
        ...proof,
      }).toString(),
    },
  );
  return {
    token: requiredToken(res.access_token, "Entra ID"),
    expiresAt: now + secondsOf(res.expires_in) * 1000,
  };
}

async function imdsToken(
  input: AzureExchangeInput,
  resource: string,
  now: number,
): Promise<IssuedToken> {
  const query = new URLSearchParams({ "api-version": "2018-02-01", resource });
  const res = await tokenEndpointCall<{
    access_token?: string;
    expires_in?: number | string;
  }>(input.fetch, `${IMDS_TOKEN}?${query.toString()}`, {
    headers: { Metadata: "true" },
  });
  return {
    token: requiredToken(res.access_token, "IMDS"),
    expiresAt: now + secondsOf(res.expires_in) * 1000,
  };
}

export async function exchangeAzureCredential(
  input: AzureExchangeInput,
): Promise<ResolvedCredential> {
  const now = (input.now ?? Date.now)();

  if (input.mode === "MANAGED") {
    const t = parseStored("MANAGED", input.stored);
    const arm = await imdsToken(input, `${ARM_RESOURCE}/`, now);
    const aks = await imdsToken(input, AKS_SERVER_APP, now);
    return resolved(
      "MANAGED",
      input.authKind,
      { armToken: arm.token, aksToken: aks.token, ...t },
      new Date(Math.min(arm.expiresAt, aks.expiresAt)),
    );
  }

  const isSecret = input.authKind === "AZURE_SECRET";
  let stored: z.infer<typeof azureStoredPayloadSchemas.AZURE_FEDERATED>;
  let proof: Record<string, string>;
  if (isSecret) {
    const secret = parseStored("AZURE_SECRET", input.stored);
    stored = secret;
    proof = { client_secret: secret.clientSecret };
  } else {
    stored = parseStored("AZURE_FEDERATED", input.stored);
    proof = {
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await input.federationToken(AZURE_FEDERATION_AUDIENCE),
    };
  }
  const token = (scope: string) =>
    clientCredentialsToken(
      input,
      stored.tenantId,
      stored.clientId,
      proof,
      scope,
      now,
    );
  const arm = await token(`${ARM_RESOURCE}/.default`);
  const aks = await token(`${AKS_SERVER_APP}/.default`);
  const tokenExpiry = Math.min(arm.expiresAt, aks.expiresAt);
  return resolved(
    "BYOC",
    input.authKind,
    {
      armToken: arm.token,
      aksToken: aks.token,
      subscriptionId: stored.subscriptionId,
      resourceGroup: stored.resourceGroup,
    },
    new Date(
      isSecret
        ? Math.min(tokenExpiry, now + STATIC_CREDENTIAL_TTL_MS)
        : tokenExpiry,
    ),
  );
}

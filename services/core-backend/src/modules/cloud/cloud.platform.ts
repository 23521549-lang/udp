import { createHmac } from "node:crypto";
import type {
  CloudAdapter,
  CloudAuthKind,
  CloudProvider,
  CredentialMode,
  ResolvedCredential,
  SecretBuffer,
} from "@udp/adapter-core";
import { GatewayError } from "@udp/cloud-adapters";
import {
  createAwsAdapter,
  exchangeAwsCredential,
} from "@udp/cloud-adapters/aws";
import {
  createAzureAdapter,
  exchangeAzureCredential,
} from "@udp/cloud-adapters/azure";
import {
  createGcpAdapter,
  exchangeGcpCredential,
} from "@udp/cloud-adapters/gcp";
import type { OidcIssuer } from "../oidc/oidc.issuer.js";

/**
 * [v4.11] Phần cloud mà Service 1 phụ thuộc RA NGOÀI tiến trình (Plan #26 QĐ-6/7): adapter
 * theo (cloud, region), và bước đổi payload đã giải mã thành credential ngắn hạn. Tiêm qua
 * `createApp(deps)` như `flagService` — test dùng cổng mô phỏng, không gọi cloud thật.
 *
 * `capabilities` là cấu hình của CHÍNH triển khai này (không phải của khách): cơ chế nào
 * dùng được, và dữ liệu mà màn hình setup cần để khách copy.
 */

export interface ExchangeRequest {
  projectId: string;
  provider: CloudProvider;
  region: string;
  mode: CredentialMode;
  authKind: CloudAuthKind;
  /** Payload đã giải mã — bên gọi `dispose()` sau khi hàm này trả về */
  stored: SecretBuffer;
}

export interface PlatformCapabilities {
  /** `AWS_ROLE`: principal mà role của khách tin, và ExternalId theo project */
  awsRole: {
    principalArn: string;
    externalIdFor(projectId: string): string;
  } | null;
  /** Federation GCP/Azure: issuer mà pool/app registration của khách tin */
  oidcIssuer: string | null;
  /** MANAGED: đích trong tài khoản của UDP, theo cloud; `null` = không nhận MANAGED */
  managed: {
    aws: Record<string, never> | null;
    gcp: { gcpProjectId: string } | null;
    azure: { subscriptionId: string; resourceGroup: string } | null;
  };
}

export interface CloudPlatform {
  /** Adapter cho (cloud, region); `null` = cloud đó không bật ở triển khai này */
  adapterFor(provider: CloudProvider, region: string): CloudAdapter | null;
  exchange(request: ExchangeRequest): Promise<ResolvedCredential>;
  capabilities: PlatformCapabilities;
}

/** ExternalId = HMAC-SHA256(secret, projectId) cắt 32 ký tự: tất định, không đoán được (QĐ-5) */
export function externalIdOf(secret: string, projectId: string): string {
  return createHmac("sha256", secret)
    .update(projectId)
    .digest("hex")
    .slice(0, 32);
}

export interface PlatformConfig {
  UDP_AWS_PRINCIPAL_ARN?: string | undefined;
  UDP_EXTERNAL_ID_SECRET?: string | undefined;
  MANAGED_CLOUDS: readonly ("aws" | "gcp" | "azure")[];
  MANAGED_GCP_PROJECT_ID?: string | undefined;
  MANAGED_AZURE_SUBSCRIPTION_ID?: string | undefined;
  MANAGED_AZURE_RESOURCE_GROUP?: string | undefined;
}

export function capabilitiesOf(
  config: PlatformConfig,
  oidcIssuer: OidcIssuer | null,
): PlatformCapabilities {
  const {
    UDP_AWS_PRINCIPAL_ARN: principalArn,
    UDP_EXTERNAL_ID_SECRET: secret,
  } = config;
  const managed = new Set(config.MANAGED_CLOUDS);
  const gcpProjectId = config.MANAGED_GCP_PROJECT_ID;
  const subscriptionId = config.MANAGED_AZURE_SUBSCRIPTION_ID;
  const resourceGroup = config.MANAGED_AZURE_RESOURCE_GROUP;
  return {
    awsRole:
      principalArn === undefined || secret === undefined
        ? null
        : {
            principalArn,
            externalIdFor: (projectId) => externalIdOf(secret, projectId),
          },
    oidcIssuer: oidcIssuer?.issuer ?? null,
    managed: {
      aws: managed.has("aws") ? {} : null,
      gcp:
        managed.has("gcp") && gcpProjectId !== undefined
          ? { gcpProjectId }
          : null,
      azure:
        managed.has("azure") &&
        subscriptionId !== undefined &&
        resourceGroup !== undefined
          ? { subscriptionId, resourceGroup }
          : null,
    },
  };
}

/** Token federation cho project — lỗi cấu hình rõ ràng khi UDP chưa bật issuer */
function federationTokenOf(oidcIssuer: OidcIssuer | null, projectId: string) {
  return (audience: string): Promise<string> =>
    oidcIssuer === null
      ? Promise.reject(
          new GatewayError(
            "configuration",
            "UDP chưa bật OIDC issuer — federation GCP/Azure không dùng được",
          ),
        )
      : Promise.resolve(oidcIssuer.issueFederationToken(projectId, audience));
}

/** `authKind` của hàng phải thuộc đúng cloud — lệch là hàng hỏng, không đoán thay */
function kindOf<K extends CloudAuthKind>(
  kind: CloudAuthKind,
  allowed: readonly K[],
): K {
  const match = allowed.find((k) => k === kind);
  if (match === undefined) {
    throw new GatewayError(
      "configuration",
      `authKind ${kind} không thuộc cloud này (${allowed.join(", ")})`,
    );
  }
  return match;
}

/** Bản thật: ba adapter REST/SDK, đổi token qua STS/Google/Entra ID */
export function createCloudPlatform(
  config: PlatformConfig,
  oidcIssuer: OidcIssuer | null,
): CloudPlatform {
  const capabilities = capabilitiesOf(config, oidcIssuer);
  return {
    capabilities,

    adapterFor: (provider, region) => {
      switch (provider) {
        case "aws":
          return createAwsAdapter({ region });
        case "gcp":
          return createGcpAdapter({ region });
        case "azure":
          return createAzureAdapter({ region });
      }
    },

    exchange: async (request) => {
      const federationToken = federationTokenOf(oidcIssuer, request.projectId);
      switch (request.provider) {
        case "aws": {
          const authKind = kindOf(request.authKind, [
            "AWS_ROLE",
            "AWS_KEY",
          ] as const);
          if (
            request.mode === "BYOC" &&
            authKind === "AWS_ROLE" &&
            capabilities.awsRole === null
          ) {
            throw new GatewayError(
              "configuration",
              "UDP chưa bật AWS federation (AssumeRole)",
            );
          }
          return exchangeAwsCredential({
            mode: request.mode,
            authKind,
            stored: request.stored,
            projectId: request.projectId,
            externalId:
              capabilities.awsRole?.externalIdFor(request.projectId) ?? "",
            region: request.region,
          });
        }
        case "gcp":
          return exchangeGcpCredential({
            mode: request.mode,
            authKind: kindOf(request.authKind, ["GCP_WIF", "GCP_KEY"] as const),
            stored: request.stored,
            federationToken,
            fetch: globalThis.fetch,
          });
        case "azure":
          return exchangeAzureCredential({
            mode: request.mode,
            authKind: kindOf(request.authKind, [
              "AZURE_FEDERATED",
              "AZURE_SECRET",
            ] as const),
            stored: request.stored,
            federationToken,
            fetch: globalThis.fetch,
          });
      }
    },
  };
}

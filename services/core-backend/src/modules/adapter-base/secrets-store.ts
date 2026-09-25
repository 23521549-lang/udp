import type { CapabilityBinding } from "@udp/shared-types";

/**
 * Binding `secrets.store@1` (Plan #34 QĐ-2) — nói kho bí mật là GÌ, để workload và adapter khác
 * (CI/CD ở Plan #36) biết lấy bí mật bằng cơ chế nào: Vault qua injector/CSI, Sealed Secrets qua
 * `SealedSecret`, ba cloud qua `SecretProviderClass` của CSI driver, ESO qua `ExternalSecret`.
 * Thuộc tính chỉ là tên, địa chỉ, định danh công khai — không bao giờ một giá trị bí mật.
 */

export const SECRETS_STORE_PROVIDERS = [
  "vault",
  "sealed-secrets",
  "external-secrets",
  "aws",
  "gcp",
  "azure",
] as const;
export type SecretsStoreProvider = (typeof SECRETS_STORE_PROVIDERS)[number];

export function secretsStoreBinding(
  providedBy: string,
  provider: SecretsStoreProvider,
  attributes: Readonly<Record<string, string>> = {},
  endpoint?: string,
): CapabilityBinding {
  return {
    id: "secrets.store",
    version: "1.0.0",
    providedBy,
    ...(endpoint === undefined ? {} : { endpoint }),
    attributes: { provider, ...attributes },
  };
}

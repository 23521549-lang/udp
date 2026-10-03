import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { secretsStoreBinding } from "../../adapter-base/secrets-store.js";

/**
 * Adapter Azure Key Vault (§5.5 Secrets Management, Plan #34 QĐ-3) — họ Helm, chart
 * `csi-secrets-store-provider-azure` (đã gồm Secrets Store CSI Driver làm phụ thuộc).
 *
 * Định danh là Azure Workload Identity: ServiceAccount của workload liên kết với một managed
 * identity (client id) có quyền đọc Key Vault — không client secret nào trong cluster.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const azureKeyVaultConfigSchema = z.object({
  /** Tên Key Vault (3–24 ký tự, chữ, số, gạch ngang) */
  keyVaultName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/),
  tenantId: z.string().regex(UUID),
  /** Client id của managed identity mà workload dùng */
  clientId: z.string().regex(UUID),
  rotationPollSeconds: z.number().int().min(30).max(3600).default(120),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SECRETS",
  toolId: "azure-key-vault",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "secrets.store", version: "1.0.0" }],
    requires: [],
  },
  configSchema: azureKeyVaultConfigSchema,
  chart: helmChart("csi-secrets-store-provider-azure"),
  releaseName: "udp-csi-provider-azure",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => ({
    "secrets-store-csi-driver": {
      install: true,
      syncSecret: { enabled: true },
      enableSecretRotation: true,
      rotationPollInterval: `${String(azureKeyVaultConfigSchema.parse(config).rotationPollSeconds)}s`,
    },
  }),

  bindings: (_ctx, config) => {
    const { keyVaultName, tenantId, clientId } =
      azureKeyVaultConfigSchema.parse(config);
    return [
      secretsStoreBinding(
        "secrets:azure-key-vault",
        "azure",
        { keyVaultName, tenantId, clientId },
        `https://${keyVaultName}.vault.azure.net`,
      ),
    ];
  },
});

export default adapter;

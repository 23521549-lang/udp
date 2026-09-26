import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { certManagerCompanion } from "../../adapter-base/cert-manager.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Azure Service Operator v2 (§5.5 Infrastructure IaC, Plan #37) — operator trong cluster:
 * app khai PostgreSQL, Redis, Storage của Azure bằng CR (`infra.provision`). Chỉ chạy trên AKS với
 * Workload Identity (`cloud = "AZURE"`, QĐ-5): subscription, tenant và client ID là định danh
 * công khai, không có client secret nào.
 *
 * Webhook của ASO cần cert-manager có sẵn LÚC CÀI: release nền dùng chung, áp trước (QĐ-7).
 * `crdPattern` giới hạn CRD vào các nhóm dịch vụ đã chọn — cài mọi CRD của ASO vượt giới hạn đối
 * tượng của API server nhỏ.
 */

export const cloud = "AZURE";

const GROUPS = {
  resources: "resources.azure.com/*",
  postgresql: "dbforpostgresql.azure.com/*",
  redis: "cache.azure.com/*",
  storage: "storage.azure.com/*",
  keyvault: "keyvault.azure.com/*",
  identity: "managedidentity.azure.com/*",
} as const;

type Group = keyof typeof GROUPS;

export const asoConfigSchema = z.object({
  subscriptionId: z.string().uuid(),
  tenantId: z.string().uuid(),
  /** Client ID của managed identity mà controller đảm nhận */
  clientId: z.string().uuid(),
  groups: z
    .array(z.enum(Object.keys(GROUPS) as [Group, ...Group[]]))
    .min(1)
    .refine((g) => new Set(g).size === g.length, "nhóm lặp")
    .default(["resources", "postgresql", "redis", "storage"]),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "INFRA",
  toolId: "aso",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "infra.provision", version: "1.0.0" }],
    requires: [],
  },
  configSchema: asoConfigSchema,
  chart: {
    name: "azure-service-operator",
    version: "2.11.0",
    repo: "https://raw.githubusercontent.com/Azure/azure-service-operator/main/v2/charts",
  },
  releaseName: "udp-aso",
  quotaDimensions: [],
  ignoredKeyPrefixes: [
    "kubectl.kubernetes.io/",
    "helm.sh/",
    "serviceoperator.azure.com/",
  ],

  values: (config) => {
    const parsed = asoConfigSchema.parse(config);
    return {
      azureSubscriptionID: parsed.subscriptionId,
      azureTenantID: parsed.tenantId,
      azureClientID: parsed.clientId,
      useWorkloadIdentityAuth: true,
      crdPattern: [...parsed.groups]
        .sort()
        .map((g) => GROUPS[g])
        .join(";"),
    };
  },
  companions: [certManagerCompanion],

  bindings: (_ctx, config) => [
    {
      id: "infra.provision",
      version: "1.0.0",
      providedBy: "infra:aso",
      attributes: {
        provider: "aso",
        mode: "operator",
        clouds: "azure",
        services: [...asoConfigSchema.parse(config).groups].sort().join(","),
      },
    },
  ],
});

export default adapter;

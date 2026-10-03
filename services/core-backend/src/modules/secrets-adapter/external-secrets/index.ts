import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { secretsStoreBinding } from "../../adapter-base/secrets-store.js";

/**
 * Adapter External Secrets Operator (§5.5 Secrets Management, Plan #34) — họ Helm, chart
 * `external-secrets`.
 *
 * Operator đồng bộ bí mật từ BẤT KỲ kho nào (AWS SM, GCP SM, Azure KV, Vault…) vào `Secret`
 * Kubernetes qua `ExternalSecret`. `SecretStore` trỏ tới kho là việc của project (namespaced,
 * định danh theo workload) — adapter cài operator và CRD, không đoán kho của khách.
 */

export const externalSecretsConfigSchema = z.object({
  /** Số ExternalSecret đồng bộ song song */
  concurrent: z.number().int().min(1).max(10).default(1),
  /** Webhook kiểm tra `ExternalSecret` lúc tạo */
  webhook: z.boolean().default(true),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SECRETS",
  toolId: "external-secrets",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "secrets.store", version: "1.0.0" }],
    requires: [],
  },
  configSchema: externalSecretsConfigSchema,
  chart: helmChart("external-secrets"),
  releaseName: "udp-external-secrets",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = externalSecretsConfigSchema.parse(config);
    return {
      installCRDs: true,
      concurrent: parsed.concurrent,
      webhook: { create: parsed.webhook },
    };
  },

  bindings: () => [
    secretsStoreBinding("secrets:external-secrets", "external-secrets"),
  ],
});

export default adapter;

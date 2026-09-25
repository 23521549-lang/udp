import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { secretsStoreBinding } from "../../adapter-base/secrets-store.js";

/**
 * Adapter HashiCorp Vault (§5.5 Secrets Management, Plan #34 QĐ-4) — họ Helm, chart `vault`.
 *
 * Một node Raft tích hợp (lưu trữ trên PVC, nâng lên ba node không cần đổi backend), kèm
 * injector (sidecar) và CSI provider — hai đường workload lấy bí mật. **Init và unseal là việc
 * của người vận hành:** adapter không giữ unseal key, vì giữ nó là giữ chìa khoá của mọi bí mật
 * của khách; healthcheck chỉ nói release có mặt, không nói Vault đã unseal.
 */

export const vaultConfigSchema = z.object({
  /** PVC của Raft, GiB */
  storageGb: z.number().int().min(1).max(100).default(10),
  /** Sidecar injector — bí mật vào pod qua annotation */
  injector: z.boolean().default(true),
  /** CSI provider — bí mật vào pod qua `SecretProviderClass` */
  csi: z.boolean().default(true),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SECRETS",
  toolId: "vault",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "secrets.store", version: "1.0.0" }],
    requires: [],
  },
  configSchema: vaultConfigSchema,
  chart: {
    name: "vault",
    version: "0.28.1",
    repo: "https://helm.releases.hashicorp.com",
  },
  releaseName: "udp-vault",
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = vaultConfigSchema.parse(config);
    return {
      server: {
        standalone: { enabled: false },
        ha: { enabled: true, replicas: 1, raft: { enabled: true } },
        dataStorage: { size: `${String(parsed.storageGb)}Gi` },
      },
      injector: { enabled: parsed.injector },
      csi: { enabled: parsed.csi },
    };
  },

  bindings: (ctx) => [
    secretsStoreBinding(
      "secrets:vault",
      "vault",
      {},
      `http://udp-vault.${ctx.systemNamespace}:8200`,
    ),
  ],
});

export default adapter;

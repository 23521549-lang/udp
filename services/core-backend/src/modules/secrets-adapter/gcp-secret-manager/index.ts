import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { secretsStoreBinding } from "../../adapter-base/secrets-store.js";

/**
 * Adapter GCP Secret Manager (§5.5 Secrets Management, Plan #34 QĐ-3) — họ Helm, hai release:
 * Secrets Store CSI Driver rồi provider của GCP.
 *
 * Định danh là GKE Workload Identity: ServiceAccount của workload giả danh một GCP service account
 * có quyền `secretmanager.secretAccessor` — không khoá JSON nào trong cluster.
 */

export const gcpSecretManagerConfigSchema = z.object({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  /** GCP service account mà workload giả danh */
  gcpServiceAccount: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/,
    ),
  rotationPollSeconds: z.number().int().min(30).max(3600).default(120),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SECRETS",
  toolId: "gcp-secret-manager",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "secrets.store", version: "1.0.0" }],
    requires: [],
  },
  configSchema: gcpSecretManagerConfigSchema,
  chart: {
    name: "secrets-store-csi-driver",
    version: "1.4.5",
    repo: "https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts",
  },
  releaseName: "udp-csi-secrets-store",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => ({
    syncSecret: { enabled: true },
    enableSecretRotation: true,
    rotationPollInterval: `${String(gcpSecretManagerConfigSchema.parse(config).rotationPollSeconds)}s`,
  }),
  companions: [
    {
      releaseName: "udp-csi-provider-gcp",
      chart: {
        name: "secrets-store-csi-driver-provider-gcp",
        version: "1.6.0",
        repo: "https://googlecloudplatform.github.io/secrets-store-csi-driver-provider-gcp",
      },
      values: () => ({}),
    },
  ],

  bindings: (_ctx, config) => {
    const { projectId, gcpServiceAccount } =
      gcpSecretManagerConfigSchema.parse(config);
    return [
      secretsStoreBinding("secrets:gcp-secret-manager", "gcp", {
        projectId,
        gcpServiceAccount,
      }),
    ];
  },
});

export default adapter;

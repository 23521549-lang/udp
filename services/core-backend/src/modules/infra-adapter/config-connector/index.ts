import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter GCP Config Connector (§5.5 Infrastructure IaC, Plan #37) — operator trong cluster: app
 * khai Cloud SQL, bucket, Pub/Sub bằng CR (`infra.provision`). Chỉ chạy trên GKE với Workload
 * Identity (`cloud = "GCP"`, QĐ-5).
 *
 * Google KHÔNG phát hành Helm chart — chỉ bundle operator (`gs://configconnector-operator`) và
 * add-on GKE (QĐ-6). Bản ghi release khai `installer: "manifest-bundle"` để bộ cài áp bundle bằng
 * `kubectl apply` thay vì giả làm Helm. ConfigConnector chạy chế độ `cluster` với service account
 * GCP của cấu hình — định danh công khai, không có khoá JSON nào.
 */

export const cloud = "GCP";

export const configConnectorConfigSchema = z.object({
  /** Service account GCP mà controller đảm nhận qua Workload Identity */
  googleServiceAccount: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/,
    ),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "INFRA",
  toolId: "config-connector",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "infra.provision", version: "1.0.0" }],
    requires: [],
  },
  configSchema: configConnectorConfigSchema,
  chart: {
    name: "configconnector-operator",
    version: "1.125.0",
    repo: "gs://configconnector-operator",
    installer: "manifest-bundle",
  },
  releaseName: "udp-config-connector",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "cnrm.cloud.google.com/"],

  values: (config) => ({
    configConnector: {
      mode: "cluster",
      googleServiceAccount:
        configConnectorConfigSchema.parse(config).googleServiceAccount,
    },
  }),

  bindings: () => [
    {
      id: "infra.provision",
      version: "1.0.0",
      providedBy: "infra:config-connector",
      attributes: {
        provider: "config-connector",
        mode: "operator",
        clouds: "gcp",
      },
    },
  ],
});

export default adapter;

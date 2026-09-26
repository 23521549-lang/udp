import { z } from "zod";
import { envLabelFor } from "@udp/config";
import type { AdapterEnvironment, DomainAdapter } from "@udp/adapter-core";
import {
  credentialSeedField,
  instanceBindings,
  instanceDemand,
  instanceFields,
  passwordsByEnvironment,
  RAW_CHART,
  replicasOf,
  volumeClaim,
} from "../../adapter-base/database.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter MinIO Operator (§5.5 Database Operators, Plan #38) — kho đối tượng S3-compatible: operator
 * cài một lần, mỗi environment một `Tenant`. MinIO KHÔNG phải database — nó cung cấp
 * `object.store` (QĐ-6) và không tính vào `maxDatabases`, chỉ vào dung lượng.
 *
 * Tài khoản gốc của tenant là Secret `config.env` mà operator đọc: chart `raw` dựng nó từ mật khẩu
 * suy theo environment (QĐ-2). Production chạy bốn máy chủ (erasure coding); env khác một máy.
 */

const TENANT = "udp-minio";

/**
 * Operator đọc tài khoản gốc từ khoá `config.env` (các dòng `export`) — mật khẩu lấy từ
 * `secretValues` lúc cài, không bao giờ qua ConfigMap.
 */
const rootEnvTemplate = (environment: AdapterEnvironment): string =>
  [
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${TENANT}-env`,
    "type: Opaque",
    "stringData:",
    "  config.env: |",
    '    export MINIO_ROOT_USER="udp-root"',
    `    export MINIO_ROOT_PASSWORD={{ index .Values.credentials "${envLabelFor(environment.name)}" "password" | quote }}`,
  ].join("\n");

export const minioConfigSchema = z.object({
  credentialSeed: credentialSeedField,
  storageGb: instanceFields.storageGb,
  productionReplicas: z.number().int().min(4).max(16).default(4),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "DATABASE",
  toolId: "minio",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "object.store", version: "1.0.0" }],
    requires: [],
  },
  configSchema: minioConfigSchema,
  chart: {
    name: "operator",
    version: "6.0.4",
    repo: "https://operator.min.io",
  },
  releaseName: "udp-minio-operator",
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],
  values: () => ({}),
  secretValues: (config, ctx) =>
    passwordsByEnvironment(minioConfigSchema.parse(config).credentialSeed, ctx),
  demand: (config, ctx) =>
    instanceDemand(minioConfigSchema.parse(config), ctx, false),

  perEnvironment: {
    releasePrefix: "udp-minio",
    chart: RAW_CHART,
    readsSecretValues: true,
    values: (config, _ctx, environment) => {
      const parsed = minioConfigSchema.parse(config);
      return {
        templates: [rootEnvTemplate(environment)],
        resources: [
          {
            apiVersion: "minio.min.io/v2",
            kind: "Tenant",
            metadata: { name: TENANT },
            spec: {
              configuration: { name: `${TENANT}-env` },
              pools: [
                {
                  name: "pool-0",
                  servers: replicasOf(parsed, environment),
                  volumesPerServer: 1,
                  volumeClaimTemplate: { spec: volumeClaim(parsed.storageGb) },
                },
              ],
            },
          },
        ],
      };
    },
  },

  bindings: (ctx) =>
    instanceBindings(ctx, {
      capability: "object.store",
      providedBy: "database:minio",
      service: "minio",
      port: 443,
      engine: "minio",
      secretName: `${TENANT}-env`,
    }),
});

export default adapter;

import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import {
  credentialSeedField,
  instanceBindings,
  instanceDemand,
  instanceFields,
  passwordSecretTemplate,
  passwordsByEnvironment,
  RAW_CHART,
  replicasOf,
  volumeClaim,
} from "../../adapter-base/database.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter MySQL Operator của Oracle (§5.5 Database Operators, Plan #38) — operator cài một lần,
 * mỗi environment một `InnoDBCluster` (Group Replication + MySQL Router) trong namespace của nó.
 *
 * InnoDBCluster đọc tài khoản root từ Secret có sẵn: chart `raw` dựng `udp-mysql-root` từ mật khẩu
 * suy theo environment (QĐ-2). Ứng dụng nối qua MySQL Router — service cùng tên cluster.
 */

const CLUSTER = "udp-mysql";

export const mysqlConfigSchema = z.object({
  mysqlVersion: z.enum(["8.0.40", "8.4.3"]).default("8.4.3"),
  credentialSeed: credentialSeedField,
  ...instanceFields,
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "DATABASE",
  toolId: "mysql",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "db.instance", version: "1.0.0" }],
    requires: [],
  },
  configSchema: mysqlConfigSchema,
  chart: {
    name: "mysql-operator",
    version: "2.2.2",
    repo: "https://mysql.github.io/mysql-operator/",
  },
  releaseName: "udp-mysql-operator",
  quotaDimensions: ["maxDatabases", "maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],
  values: () => ({}),
  secretValues: (config, ctx) =>
    passwordsByEnvironment(mysqlConfigSchema.parse(config).credentialSeed, ctx),
  demand: (config, ctx) =>
    instanceDemand(mysqlConfigSchema.parse(config), ctx, true),

  perEnvironment: {
    releasePrefix: "udp-mysql",
    chart: RAW_CHART,
    readsSecretValues: true,
    values: (config, _ctx, environment) => {
      const parsed = mysqlConfigSchema.parse(config);
      return {
        templates: [
          passwordSecretTemplate(`${CLUSTER}-root`, environment, {
            rootUser: "root",
            rootHost: "%",
            rootPassword: "password",
          }),
        ],
        resources: [
          {
            apiVersion: "mysql.oracle.com/v2",
            kind: "InnoDBCluster",
            metadata: { name: CLUSTER },
            spec: {
              secretName: `${CLUSTER}-root`,
              instances: replicasOf(parsed, environment),
              version: parsed.mysqlVersion,
              router: { instances: 1 },
              tlsUseSelfSigned: true,
              datadirVolumeClaimTemplate: volumeClaim(parsed.storageGb),
            },
          },
        ],
      };
    },
  },

  bindings: (ctx) =>
    instanceBindings(ctx, {
      capability: "db.instance",
      providedBy: "database:mysql",
      service: CLUSTER,
      port: 3306,
      engine: "mysql",
      secretName: `${CLUSTER}-root`,
    }),
});

export default adapter;

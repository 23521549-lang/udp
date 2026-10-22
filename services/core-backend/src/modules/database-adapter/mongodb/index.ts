import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import {
  credentialSeedField,
  instanceBindings,
  instanceDemand,
  instanceFields,
  passwordSecretTemplate,
  passwordsByEnvironment,
  replicasOf,
  volumeClaim,
} from "../../adapter-base/database.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter MongoDB Community Operator (§5.5 Database Operators, Plan #38) — operator chính thức của
 * MongoDB cài một lần, mỗi environment một replica set `MongoDBCommunity` (xác thực SCRAM).
 *
 * Operator KHÔNG tự sinh mật khẩu người dùng: Secret `udp-mongodb-password` do chart `raw` dựng từ
 * mật khẩu suy theo environment (QĐ-2). Operator ghi chuỗi kết nối vào Secret
 * `<resource>-<db>-<user>` — binding trỏ tới đó.
 */

const RESOURCE = "udp-mongodb";

export const mongodbConfigSchema = z.object({
  mongodbVersion: z.enum(["6.0.18", "7.0.14"]).default("7.0.14"),
  credentialSeed: credentialSeedField,
  ...instanceFields,
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "DATABASE",
  toolId: "mongodb",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "db.instance", version: "1.0.0" }],
    requires: [],
  },
  configSchema: mongodbConfigSchema,
  chart: helmChart("community-operator"),
  releaseName: "udp-mongodb-operator",
  quotaDimensions: ["maxDatabases", "maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],
  values: () => ({ operator: { watchNamespace: "*" } }),
  secretValues: (config, ctx) =>
    passwordsByEnvironment(
      mongodbConfigSchema.parse(config).credentialSeed,
      ctx,
    ),
  demand: (config, ctx) =>
    instanceDemand(mongodbConfigSchema.parse(config), ctx, true),

  perEnvironment: {
    releasePrefix: "udp-mongodb",
    chart: helmChart("raw"),
    readsSecretValues: true,
    values: (config, _ctx, environment) => {
      const parsed = mongodbConfigSchema.parse(config);
      return {
        templates: [
          passwordSecretTemplate(`${RESOURCE}-password`, environment, {
            password: "password",
          }),
        ],
        resources: [
          {
            apiVersion: "mongodbcommunity.mongodb.com/v1",
            kind: "MongoDBCommunity",
            metadata: { name: RESOURCE },
            spec: {
              type: "ReplicaSet",
              members: replicasOf(parsed, environment),
              version: parsed.mongodbVersion,
              security: { authentication: { modes: ["SCRAM"] } },
              users: [
                {
                  name: "app",
                  db: "admin",
                  passwordSecretRef: { name: `${RESOURCE}-password` },
                  roles: [{ name: "readWriteAnyDatabase", db: "admin" }],
                  scramCredentialsSecretName: `${RESOURCE}-scram`,
                },
              ],
              statefulSet: {
                spec: {
                  volumeClaimTemplates: [
                    {
                      metadata: { name: "data-volume" },
                      spec: volumeClaim(parsed.storageGb),
                    },
                  ],
                },
              },
            },
          },
        ],
      };
    },
  },

  bindings: (ctx) =>
    instanceBindings(ctx, {
      capability: "db.instance",
      providedBy: "database:mongodb",
      service: `${RESOURCE}-svc`,
      port: 27017,
      engine: "mongodb",
      secretName: `${RESOURCE}-admin-app`,
    }),
});

export default adapter;

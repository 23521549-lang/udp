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
 * Adapter Redis Operator của OT-Container-Kit (§5.5 Database Operators, Plan #38) — operator cài
 * một lần, mỗi environment một `RedisReplication` (một primary + bản sao; production có bản sao).
 *
 * Redis KHÔNG chạy không mật khẩu: operator đọc `redisSecret` có sẵn, chart `raw` dựng
 * `udp-redis-auth` từ mật khẩu suy theo environment (QĐ-2).
 */

const RESOURCE = "udp-redis";

export const redisConfigSchema = z.object({
  redisVersion: z.enum(["v7.0.15", "v7.2.6"]).default("v7.2.6"),
  credentialSeed: credentialSeedField,
  ...instanceFields,
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "DATABASE",
  toolId: "redis",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "db.instance", version: "1.0.0" }],
    requires: [],
  },
  configSchema: redisConfigSchema,
  chart: {
    name: "redis-operator",
    version: "0.18.3",
    repo: "https://ot-container-kit.github.io/helm-charts/",
  },
  releaseName: "udp-redis-operator",
  quotaDimensions: ["maxDatabases", "maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],
  values: () => ({}),
  secretValues: (config, ctx) =>
    passwordsByEnvironment(redisConfigSchema.parse(config).credentialSeed, ctx),
  demand: (config, ctx) =>
    instanceDemand(redisConfigSchema.parse(config), ctx, true),

  perEnvironment: {
    releasePrefix: "udp-redis",
    chart: RAW_CHART,
    readsSecretValues: true,
    values: (config, _ctx, environment) => {
      const parsed = redisConfigSchema.parse(config);
      return {
        templates: [
          passwordSecretTemplate(`${RESOURCE}-auth`, environment, {
            password: "password",
          }),
        ],
        resources: [
          {
            apiVersion: "redis.redis.opstreelabs.in/v1beta2",
            kind: "RedisReplication",
            metadata: { name: RESOURCE },
            spec: {
              clusterSize: replicasOf(parsed, environment),
              kubernetesConfig: {
                image: `quay.io/opstree/redis:${parsed.redisVersion}`,
                redisSecret: { name: `${RESOURCE}-auth`, key: "password" },
              },
              storage: {
                volumeClaimTemplate: { spec: volumeClaim(parsed.storageGb) },
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
      providedBy: "database:redis",
      service: RESOURCE,
      port: 6379,
      engine: "redis",
      secretName: `${RESOURCE}-auth`,
    }),
});

export default adapter;

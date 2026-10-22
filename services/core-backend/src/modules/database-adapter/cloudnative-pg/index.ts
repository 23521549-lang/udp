import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import {
  instanceBindings,
  instanceDemand,
  instanceFields,
  replicasOf,
} from "../../adapter-base/database.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter CloudNativePG (§5.5 Database Operators, Plan #38) — operator cài một lần ở `udp-system`,
 * mỗi environment một `Cluster` PostgreSQL trong namespace của nó (production có HA).
 *
 * CloudNativePG tự sinh Secret đăng nhập `<cluster>-app` (user, password, URI) — cấu hình không
 * mang bí mật nào; binding `db.instance` trỏ tới Secret đó bằng TÊN.
 */

const CLUSTER = "udp-postgres";

export const cloudnativePgConfigSchema = z.object({
  postgresVersion: z.enum(["15", "16", "17"]).default("16"),
  ...instanceFields,
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "DATABASE",
  toolId: "cloudnative-pg",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "db.instance", version: "1.0.0" }],
    requires: [],
  },
  configSchema: cloudnativePgConfigSchema,
  chart: helmChart("cloudnative-pg"),
  releaseName: "udp-cnpg",
  quotaDimensions: ["maxDatabases", "maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/", "cnpg.io/"],
  values: () => ({ config: { clusterWide: true } }),
  demand: (config, ctx) =>
    instanceDemand(cloudnativePgConfigSchema.parse(config), ctx, true),

  perEnvironment: {
    releasePrefix: "udp-cnpg-db",
    chart: helmChart("raw"),
    values: (config, _ctx, environment) => {
      const parsed = cloudnativePgConfigSchema.parse(config);
      return {
        resources: [
          {
            apiVersion: "postgresql.cnpg.io/v1",
            kind: "Cluster",
            metadata: { name: CLUSTER },
            spec: {
              instances: replicasOf(parsed, environment),
              imageName: `ghcr.io/cloudnative-pg/postgresql:${parsed.postgresVersion}`,
              storage: { size: `${String(parsed.storageGb)}Gi` },
            },
          },
        ],
      };
    },
  },

  bindings: (ctx) =>
    instanceBindings(ctx, {
      capability: "db.instance",
      providedBy: "database:cloudnative-pg",
      service: `${CLUSTER}-rw`,
      port: 5432,
      engine: "postgresql",
      secretName: `${CLUSTER}-app`,
    }),
});

export default adapter;

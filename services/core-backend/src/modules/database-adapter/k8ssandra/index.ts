import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { certManagerCompanion } from "../../adapter-base/cert-manager.js";
import {
  instanceBindings,
  instanceDemand,
  instanceFields,
  RAW_CHART,
  replicasOf,
  volumeClaim,
} from "../../adapter-base/database.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter K8ssandra (§5.5 Database Operators — Cassandra, Plan #38) — `k8ssandra-operator` cài một
 * lần (webhook cần cert-manager: release NỀN dùng chung với Azure Service Operator), mỗi
 * environment một `K8ssandraCluster` một datacenter; production có nhiều node.
 *
 * K8ssandra tự sinh Secret siêu người dùng `<cluster>-superuser` — cấu hình không mang bí mật.
 */

const CLUSTER = "udp-cassandra";

export const k8ssandraConfigSchema = z.object({
  cassandraVersion: z.enum(["4.0.14", "4.1.6"]).default("4.1.6"),
  ...instanceFields,
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "DATABASE",
  toolId: "k8ssandra",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "db.instance", version: "1.0.0" }],
    requires: [],
  },
  configSchema: k8ssandraConfigSchema,
  chart: {
    name: "k8ssandra-operator",
    version: "1.20.2",
    repo: "https://helm.k8ssandra.io/stable",
  },
  releaseName: "udp-k8ssandra",
  quotaDimensions: ["maxDatabases", "maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],
  values: () => ({ global: { clusterScoped: true } }),
  companions: [certManagerCompanion],
  demand: (config, ctx) =>
    instanceDemand(k8ssandraConfigSchema.parse(config), ctx, true),

  perEnvironment: {
    releasePrefix: "udp-cassandra",
    chart: RAW_CHART,
    values: (config, _ctx, environment) => {
      const parsed = k8ssandraConfigSchema.parse(config);
      return {
        resources: [
          {
            apiVersion: "k8ssandra.io/v1alpha1",
            kind: "K8ssandraCluster",
            metadata: { name: CLUSTER },
            spec: {
              cassandra: {
                serverVersion: parsed.cassandraVersion,
                datacenters: [
                  {
                    metadata: { name: "dc1" },
                    size: replicasOf(parsed, environment),
                    storageConfig: {
                      cassandraDataVolumeClaimSpec: volumeClaim(
                        parsed.storageGb,
                      ),
                    },
                  },
                ],
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
      providedBy: "database:k8ssandra",
      service: `${CLUSTER}-dc1-service`,
      port: 9042,
      engine: "cassandra",
      secretName: `${CLUSTER}-superuser`,
    }),
});

export default adapter;

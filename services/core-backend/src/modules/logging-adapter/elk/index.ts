import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { logsSinkBinding } from "../../adapter-base/logs-sink.js";

/**
 * Adapter ELK Stack (§5.5 Logging, Plan #32) — họ Helm, hai release, qua ECK (QĐ-5).
 *
 * `eck-operator` là release chính; `eck-stack` khai Elasticsearch, Kibana và Filebeat (thu log
 * container) dưới dạng CR mà operator dựng. Chart `elastic/elasticsearch` cũ đã ngừng, nên đi
 * ECK. Mật khẩu người dùng `elastic` do ECK SINH trong `Secret` `udp-elk-es-elastic-user` —
 * UDP không giữ bí mật nào cho ELK, binding chỉ trỏ TÊN Secret đó.
 */

export const elkConfigSchema = z.object({
  /** Số node Elasticsearch — 1 cho dev, 3 cho quorum */
  nodeCount: z.number().int().min(1).max(3).default(1),
  /** PVC của MỖI node, GiB */
  storageGb: z.number().int().min(1).max(1000).default(30),
  /** Cài Kibana */
  kibana: z.boolean().default(true),
});

const ELASTIC_REPO = "https://helm.elastic.co";
/** Tên cụm Elasticsearch — quyết định tên service và Secret mà ECK sinh */
const CLUSTER = "udp-elk";

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "LOGGING",
  toolId: "elk",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "logs.sink", version: "1.0.0" }],
    requires: [],
  },
  configSchema: elkConfigSchema,
  chart: { name: "eck-operator", version: "2.14.0", repo: ELASTIC_REPO },
  releaseName: "udp-eck-operator",
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: () => ({ installCRDs: true, managedNamespaces: [] }),
  companions: [
    {
      releaseName: "udp-elk",
      chart: { name: "eck-stack", version: "0.12.1", repo: ELASTIC_REPO },
      values: (config) => {
        const parsed = elkConfigSchema.parse(config);
        return {
          "eck-elasticsearch": {
            fullnameOverride: CLUSTER,
            nodeSets: [
              {
                name: "default",
                count: parsed.nodeCount,
                volumeClaimTemplates: [
                  {
                    metadata: { name: "elasticsearch-data" },
                    spec: {
                      accessModes: ["ReadWriteOnce"],
                      resources: {
                        requests: { storage: `${String(parsed.storageGb)}Gi` },
                      },
                    },
                  },
                ],
              },
            ],
          },
          "eck-kibana": {
            enabled: parsed.kibana,
            elasticsearchRef: { name: CLUSTER },
          },
          "eck-beats": {
            enabled: true,
            spec: {
              type: "filebeat",
              elasticsearchRef: { name: CLUSTER },
              daemonSet: {},
            },
          },
        };
      },
    },
  ],

  bindings: (ctx) => [
    logsSinkBinding("logging:elk", {
      protocol: "elasticsearch",
      endpoint: `https://${CLUSTER}-es-http.${ctx.systemNamespace}:9200`,
      credential: {
        secretName: `${CLUSTER}-es-elastic-user`,
        secretKey: "elastic",
        username: "elastic",
      },
    }),
  ],
});

export default adapter;

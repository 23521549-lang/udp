import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { trafficSplitBinding } from "../../adapter-base/traffic-router.js";

/**
 * Adapter Consul Connect (§5.5 Service Mesh, Plan #33) — họ Helm, một chart `consul` với
 * `connectInject` bật (sidecar Envoy + service discovery của Consul).
 *
 * `mesh.traffic-split` với `provider: consul` — chia traffic bằng `ServiceSplitter`. Flagger KHÔNG
 * có router cho Consul, nên nó khai `conflicts` với tool này (QĐ-2); Argo Rollouts đi qua plugin
 * Gateway API. Server Consul giữ trạng thái Raft trên PVC ⇒ tiêu thụ `maxStorageGb`.
 */

export const consulConfigSchema = z.object({
  /** Số server Consul — 1 cho dev, 3 cho quorum Raft */
  servers: z.union([z.literal(1), z.literal(3)]).default(1),
  /** PVC của MỖI server, GiB */
  storageGb: z.number().int().min(1).max(100).default(10),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SERVICE_MESH",
  toolId: "consul-connect",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "mesh.traffic-split", version: "1.0.0" }],
    requires: [],
  },
  configSchema: consulConfigSchema,
  chart: helmChart("consul"),
  releaseName: "udp-consul",
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = consulConfigSchema.parse(config);
    return {
      global: { name: "consul" },
      server: {
        replicas: parsed.servers,
        storage: `${String(parsed.storageGb)}Gi`,
      },
      connectInject: { enabled: true, default: false },
      ui: { enabled: true },
    };
  },

  bindings: () => [
    trafficSplitBinding(
      "mesh.traffic-split",
      "service_mesh:consul-connect",
      "consul",
    ),
  ],
});

export default adapter;

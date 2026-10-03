import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { trafficSplitBinding } from "../../adapter-base/traffic-router.js";

/**
 * Adapter Kuma (§5.5 Service Mesh, Plan #33) — họ Helm, chart `kuma` một control plane chế độ
 * standalone (multi-zone là cấu hình của khách sau này, không phải của một project).
 *
 * `mesh.traffic-split` với `provider: kuma` — chia traffic bằng `MeshHTTPRoute`; Flagger có router
 * Kuma, Argo Rollouts đi qua plugin Gateway API.
 */

export const kumaConfigSchema = z.object({
  /** Bản sao control plane */
  replicas: z.number().int().min(1).max(3).default(1),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SERVICE_MESH",
  toolId: "kuma",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "mesh.traffic-split", version: "1.0.0" }],
    requires: [],
    recommends: ["metrics.query"],
  },
  configSchema: kumaConfigSchema,
  chart: helmChart("kuma"),
  releaseName: "udp-kuma",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = kumaConfigSchema.parse(config);
    return {
      controlPlane: {
        mode: "zone",
        replicas: parsed.replicas,
        defaults: { skipMeshCreation: false },
      },
    };
  },

  bindings: () => [
    trafficSplitBinding("mesh.traffic-split", "service_mesh:kuma", "kuma"),
  ],
});

export default adapter;

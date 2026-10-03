import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { trafficSplitBinding } from "../../adapter-base/traffic-router.js";

/**
 * Adapter Traefik (§5.5 Ingress, Plan #33) — họ Helm, chart `traefik`.
 *
 * `ingress.traffic-split` với `provider: traefik` — chia trọng số qua `TraefikService`. Mở Service
 * LoadBalancer ⇒ tiêu thụ `maxLoadBalancers` (QĐ-5).
 */

export const traefikConfigSchema = z.object({
  replicas: z.number().int().min(1).max(5).default(2),
  /** Bật dashboard của Traefik (chỉ trong cluster, không có IngressRoute công khai) */
  dashboard: z.boolean().default(false),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "INGRESS",
  toolId: "traefik",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "ingress.traffic-split", version: "1.0.0" }],
    requires: [],
    recommends: ["metrics.query"],
  },
  configSchema: traefikConfigSchema,
  chart: helmChart("traefik"),
  releaseName: "udp-traefik",
  quotaDimensions: ["maxLoadBalancers"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = traefikConfigSchema.parse(config);
    return {
      deployment: { replicas: parsed.replicas },
      service: { type: "LoadBalancer" },
      ingressRoute: { dashboard: { enabled: parsed.dashboard } },
      providers: {
        kubernetesCRD: { enabled: true },
        kubernetesIngress: { enabled: true },
      },
      metrics: { prometheus: { entryPoint: "metrics" } },
    };
  },

  bindings: () => [
    trafficSplitBinding("ingress.traffic-split", "ingress:traefik", "traefik"),
  ],
});

export default adapter;

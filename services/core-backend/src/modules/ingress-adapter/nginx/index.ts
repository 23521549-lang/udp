import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { trafficSplitBinding } from "../../adapter-base/traffic-router.js";

/**
 * Adapter NGINX Ingress (§5.5 Ingress, Plan #33) — họ Helm, chart `ingress-nginx`.
 *
 * `ingress.traffic-split` với `provider: nginx` — canary bằng annotation
 * `nginx.ingress.kubernetes.io/canary-weight`, thô hơn mesh nhưng đủ cho canary ở mép cluster
 * (§5.5). Controller mở một Service LoadBalancer ⇒ tiêu thụ `maxLoadBalancers` (QĐ-5).
 */

export const nginxIngressConfigSchema = z.object({
  replicas: z.number().int().min(1).max(5).default(2),
  /** Tên IngressClass — workload của khách trỏ vào nó */
  ingressClass: z
    .string()
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    .default("nginx"),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "INGRESS",
  toolId: "nginx",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "ingress.traffic-split", version: "1.0.0" }],
    requires: [],
    recommends: ["metrics.query"],
  },
  configSchema: nginxIngressConfigSchema,
  chart: helmChart("ingress-nginx"),
  releaseName: "udp-ingress-nginx",
  quotaDimensions: ["maxLoadBalancers"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = nginxIngressConfigSchema.parse(config);
    return {
      controller: {
        replicaCount: parsed.replicas,
        ingressClassResource: {
          name: parsed.ingressClass,
          controllerValue: `k8s.io/${parsed.ingressClass}`,
        },
        service: { type: "LoadBalancer" },
        metrics: { enabled: true },
      },
    };
  },

  bindings: () => [
    trafficSplitBinding("ingress.traffic-split", "ingress:nginx", "nginx"),
  ],
});

export default adapter;

import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import {
  trafficRouterOf,
  type TrafficRouter,
} from "../../adapter-base/traffic-router.js";

/**
 * Adapter Argo Rollouts (§5.5 Progressive Delivery, Plan #33) — đúng khai báo mẫu của §5.3.
 *
 * `metrics.query >=1`: AnalysisTemplate của Argo nói được cả Prometheus lẫn Datadog, New Relic —
 * khác Flagger. Router: Istio, SMI (Linkerd), NGINX, Traefik có sẵn; Consul và Kuma qua plugin
 * Gateway API chính thức của argoproj-labs (QĐ-2) — nên không `conflicts` tool nào.
 */

export const argoRolloutsConfigSchema = z.object({
  /** Cài dashboard của Argo Rollouts (chỉ trong cluster) */
  dashboard: z.boolean().default(true),
});

const GATEWAY_API_PLUGIN = {
  name: "argoproj-labs/gatewayAPI",
  location:
    "https://github.com/argoproj-labs/rollouts-plugin-trafficrouter-gatewayapi/releases/download/v0.4.0/gatewayapi-plugin-linux-amd64",
};

/** Router có sẵn trong Argo Rollouts; hai router còn lại đi plugin Gateway API */
const NATIVE: ReadonlySet<TrafficRouter> = new Set([
  "istio",
  "linkerd",
  "nginx",
  "traefik",
]);

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "PROGRESSIVE_DELIVERY",
  toolId: "argo-rollouts",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "traffic.control", version: "1.0.0", exclusive: true }],
    requires: [
      { id: "metrics.query", constraint: ">=1" },
      {
        anyOf: [{ id: "mesh.traffic-split" }, { id: "ingress.traffic-split" }],
      },
    ],
    hint: {
      "mesh.traffic-split":
        "Argo Rollouts cần một service mesh hoặc ingress để chia traffic. Bật domain Service Mesh hoặc Ingress.",
    },
  },
  configSchema: argoRolloutsConfigSchema,
  chart: {
    name: "argo-rollouts",
    version: "2.37.7",
    repo: "https://argoproj.github.io/argo-helm",
  },
  releaseName: "udp-argo-rollouts",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = argoRolloutsConfigSchema.parse(config);
    const router = trafficRouterOf(ctx.resolved);
    if (ctx.resolved["metrics.query"] === undefined) {
      throw new Error("thiếu binding metrics.query trong ctx.resolved");
    }
    return {
      dashboard: { enabled: parsed.dashboard },
      controller: {
        trafficRouterPlugins: NATIVE.has(router) ? [] : [GATEWAY_API_PLUGIN],
      },
      // Router đang dùng ghi lại cho người vận hành và cho drift khi router đổi
      podAnnotations: { "udp.dev/traffic-router": router },
    };
  },

  bindings: () => [
    {
      id: "traffic.control",
      version: "1.0.0",
      providedBy: "progressive_delivery:argo-rollouts",
    },
  ],
});

export default adapter;

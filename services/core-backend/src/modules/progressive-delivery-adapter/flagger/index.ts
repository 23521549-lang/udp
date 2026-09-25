import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { trafficRouterOf } from "../../adapter-base/traffic-router.js";

/**
 * Adapter Flagger (§5.5 Progressive Delivery, Plan #33) — đúng khai báo mẫu của §5.3.
 *
 * - `provides: traffic.control` EXCLUSIVE — tự xung đột với Argo Rollouts và Spinnaker.
 * - `requires: anyOf(mesh, ingress)` — router lấy từ `attributes.provider` của binding (QĐ-1);
 *   có cả hai thì mesh (QĐ-3).
 * - `requires: metrics.query ^2` — Flagger chỉ nói PromQL: Datadog/New Relic/Dynatrace ⇒
 *   `VERSION_MISMATCH`, Prometheus/VictoriaMetrics/Grafana Cloud ⇒ hợp lệ.
 * - `conflicts: consul-connect` — Flagger không có router cho Consul (QĐ-2).
 */

export const flaggerConfigSchema = z.object({
  /** Gửi thông báo phân tích canary tới Slack — webhook là bí mật của tool */
  slackWebhook: z
    .string()
    .regex(/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+$/)
    .describe("secret")
    .optional(),
});

/** Router của Flagger theo provider của binding — tên `meshProvider` của chính Flagger */
const MESH_PROVIDER = {
  istio: "istio",
  linkerd: "linkerd",
  kuma: "kuma",
  nginx: "nginx",
  traefik: "traefik",
} as const;

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "PROGRESSIVE_DELIVERY",
  toolId: "flagger",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "traffic.control", version: "1.0.0", exclusive: true }],
    requires: [
      {
        anyOf: [{ id: "mesh.traffic-split" }, { id: "ingress.traffic-split" }],
      },
      { id: "metrics.query", constraint: "^2" },
    ],
    recommends: ["traces.sink"],
    conflicts: ["service_mesh:consul-connect"],
    hint: {
      "mesh.traffic-split":
        "Flagger cần Istio/Linkerd/Kuma (mesh) hoặc NGINX/Traefik (ingress). Bật domain Service Mesh hoặc Ingress.",
      "metrics.query":
        "Flagger cần nguồn PromQL: bật Prometheus, VictoriaMetrics hay Grafana Cloud ở Monitoring.",
    },
  },
  configSchema: flaggerConfigSchema,
  chart: {
    name: "flagger",
    version: "1.38.0",
    repo: "https://flagger.app",
  },
  releaseName: "udp-flagger",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (_config, ctx) => {
    const router = trafficRouterOf(ctx.resolved);
    if (router === "consul") {
      // Validator đã chặn bằng `conflicts`; tới đây là cấu hình đi vòng qua validator
      throw new Error("Flagger không có router cho Consul Connect");
    }
    const metrics = ctx.resolved["metrics.query"];
    if (metrics?.endpoint === undefined) {
      throw new Error("thiếu binding metrics.query trong ctx.resolved");
    }
    return {
      meshProvider: MESH_PROVIDER[router],
      metricsServer: metrics.endpoint,
    };
  },
  secretValues: (config) => {
    const { slackWebhook } = flaggerConfigSchema.parse(config);
    return slackWebhook === undefined ? {} : { slack: { url: slackWebhook } };
  },

  bindings: () => [
    {
      id: "traffic.control",
      version: "1.0.0",
      providedBy: "progressive_delivery:flagger",
    },
  ],
});

export default adapter;

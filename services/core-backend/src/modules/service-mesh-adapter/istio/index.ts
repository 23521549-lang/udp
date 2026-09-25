import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { trafficSplitBinding } from "../../adapter-base/traffic-router.js";

/**
 * Adapter Istio (§5.5 Service Mesh, Plan #33) — họ Helm, ba release theo đúng thứ tự Istio
 * yêu cầu: `base` (CRD) → `istiod` (control plane) → `gateway` (ingress của mesh).
 *
 * `mesh.traffic-split` với `provider: istio` — Flagger và Argo Rollouts điều khiển canary bằng
 * VirtualService. Gateway tạo một Service LoadBalancer ⇒ tiêu thụ `maxLoadBalancers` (QĐ-5).
 */

export const istioConfigSchema = z.object({
  /** Ghi access log của Envoy ra stdout — tiện gỡ lỗi, tốn log */
  accessLog: z.boolean().default(false),
  /** Tỉ lệ trace được lấy mẫu, phần trăm */
  tracingSamplingPercent: z.number().min(0).max(100).default(1),
});

const REPO = "https://istio-release.storage.googleapis.com/charts";
const VERSION = "1.23.2";

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SERVICE_MESH",
  toolId: "istio",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "mesh.traffic-split", version: "1.0.0" }],
    requires: [],
    recommends: ["metrics.query", "traces.sink"],
  },
  configSchema: istioConfigSchema,
  chart: { name: "base", version: VERSION, repo: REPO },
  releaseName: "udp-istio-base",
  quotaDimensions: ["maxLoadBalancers"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: () => ({ defaultRevision: "default" }),
  companions: [
    {
      releaseName: "udp-istiod",
      chart: { name: "istiod", version: VERSION, repo: REPO },
      values: (config) => {
        const parsed = istioConfigSchema.parse(config);
        return {
          meshConfig: {
            accessLogFile: parsed.accessLog ? "/dev/stdout" : "",
            defaultConfig: {
              tracing: { sampling: parsed.tracingSamplingPercent },
            },
          },
        };
      },
    },
    {
      releaseName: "udp-istio-ingress",
      chart: { name: "gateway", version: VERSION, repo: REPO },
      values: () => ({ service: { type: "LoadBalancer" } }),
    },
  ],

  bindings: () => [
    trafficSplitBinding("mesh.traffic-split", "service_mesh:istio", "istio"),
  ],
});

export default adapter;

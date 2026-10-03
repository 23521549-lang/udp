import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { agentClusterName } from "../../adapter-base/agent-cluster.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Kubecost (§5.5 Cost Management, Plan #38) — họ Helm (`cost-analyzer`), dựng trên
 * OpenCost. Chart mặc định kèm Prometheus riêng: TẮT nó và đọc `metrics.query` PromQL của
 * Monitoring (QĐ-7) — hai Prometheus cùng scrape một cluster là tốn gấp đôi và lệch nhau.
 *
 * Token của gói trả phí là bí mật; bản miễn phí không cần. `cost.query` exclusive.
 */

export const kubecostConfigSchema = z.object({
  /** Token Kubecost Enterprise — vắng: bản miễn phí */
  kubecostToken: z.string().min(8).max(256).describe("secret").optional(),
});

const KUBECOST_SERVICE = {
  service: "udp-kubecost-cost-analyzer",
  port: 9090,
};

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "COST",
  toolId: "kubecost",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "cost.query", version: "1.0.0", exclusive: true }],
    requires: [{ id: "metrics.query", constraint: "^2" }],
    hint: {
      "metrics.query":
        "Kubecost tính chi phí từ PromQL: bật Prometheus, VictoriaMetrics hay Grafana Cloud ở Monitoring.",
    },
  },
  configSchema: kubecostConfigSchema,
  chart: helmChart("cost-analyzer"),
  releaseName: "udp-kubecost",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (_config, ctx) => {
    const metrics = ctx.resolved["metrics.query"];
    if (metrics?.endpoint === undefined) {
      throw new Error("thiếu binding metrics.query trong ctx.resolved");
    }
    return {
      global: {
        prometheus: { enabled: false, fqdn: metrics.endpoint },
        grafana: { enabled: false, proxy: false },
      },
      kubecostProductConfigs: { clusterName: agentClusterName(ctx) },
    };
  },
  secretValues: (config) => {
    const { kubecostToken } = kubecostConfigSchema.parse(config);
    return kubecostToken === undefined ? {} : { kubecostToken };
  },

  bindings: (ctx) => [
    {
      id: "cost.query",
      version: "1.0.0",
      providedBy: "cost:kubecost",
      endpoint: `http://${KUBECOST_SERVICE.service}.${ctx.systemNamespace}:${String(KUBECOST_SERVICE.port)}`,
      attributes: {
        provider: "kubecost",
        namespace: ctx.systemNamespace,
        service: KUBECOST_SERVICE.service,
        port: String(KUBECOST_SERVICE.port),
        allocationPath: "/model/allocation",
      },
    },
  ],
});

export default adapter;

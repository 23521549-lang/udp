import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter OpenCost (§5.5 Cost Management, Plan #38) — họ Helm, Light: không có Prometheus riêng,
 * đọc `metrics.query` PromQL của Monitoring (§5.5 v4 "đọc từ metrics.query"; QĐ-7). Nguồn không
 * nói PromQL (Datadog, New Relic, Dynatrace) ⇒ validator chặn lúc lưu bằng ràng buộc `^2`.
 *
 * `cost.query` exclusive: một cluster một bộ tính chi phí. S1 hỏi API `/allocation` của nó qua
 * proxy của API server (QĐ-8) — không mở ra Internet.
 */

export const opencostConfigSchema = z.object({
  /** Giá cloud công khai theo region của cluster; `custom` dùng bảng giá tự khai */
  pricing: z.enum(["cloud", "custom"]).default("cloud"),
  /** Chỉ dùng khi `pricing = custom` — USD mỗi vCPU-giờ và mỗi GiB-giờ */
  cpuHourlyUsd: z.number().positive().max(10).default(0.031611),
  ramGiBHourlyUsd: z.number().positive().max(10).default(0.004237),
});

const OPENCOST_SERVICE = { service: "udp-opencost", port: 9003 };

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "COST",
  toolId: "opencost",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "cost.query", version: "1.0.0", exclusive: true }],
    requires: [{ id: "metrics.query", constraint: "^2" }],
    hint: {
      "metrics.query":
        "OpenCost tính chi phí từ PromQL: bật Prometheus, VictoriaMetrics hay Grafana Cloud ở Monitoring.",
    },
  },
  configSchema: opencostConfigSchema,
  chart: {
    name: "opencost",
    version: "1.42.3",
    repo: "https://opencost.github.io/opencost-helm-chart",
  },
  releaseName: "udp-opencost",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const metrics = ctx.resolved["metrics.query"];
    if (metrics?.endpoint === undefined) {
      throw new Error("thiếu binding metrics.query trong ctx.resolved");
    }
    const parsed = opencostConfigSchema.parse(config);
    return {
      fullnameOverride: OPENCOST_SERVICE.service,
      opencost: {
        prometheus: {
          internal: { enabled: false },
          external: { enabled: true, url: metrics.endpoint },
        },
        customPricing: {
          enabled: parsed.pricing === "custom",
          costModel: {
            CPU: String(parsed.cpuHourlyUsd),
            RAM: String(parsed.ramGiBHourlyUsd),
          },
        },
        ui: { enabled: false },
      },
    };
  },

  bindings: (ctx) => [
    {
      id: "cost.query",
      version: "1.0.0",
      providedBy: "cost:opencost",
      endpoint: `http://${OPENCOST_SERVICE.service}.${ctx.systemNamespace}:${String(OPENCOST_SERVICE.port)}`,
      attributes: {
        provider: "opencost",
        namespace: ctx.systemNamespace,
        service: OPENCOST_SERVICE.service,
        port: String(OPENCOST_SERVICE.port),
        allocationPath: "/allocation/compute",
      },
    },
  ],
});

export default adapter;

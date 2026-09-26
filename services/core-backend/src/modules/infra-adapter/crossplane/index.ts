import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Crossplane (§5.5 Infrastructure IaC, Plan #37) — họ Helm, operator trong cluster: app
 * tự khai tài nguyên cloud bằng CR (`infra.provision`, mode `operator`).
 *
 * Provider của Crossplane cài qua giá trị `provider.packages` của CHÍNH chart (không phải release
 * thứ hai): bộ provider "family" của Upbound cho cloud mà người dùng chọn — phiên bản ghim, drift
 * so được. Crossplane chạy trên mọi cloud nên không khai `cloud`.
 */

const PROVIDERS = {
  aws: "xpkg.upbound.io/upbound/provider-family-aws:v1.14.0",
  gcp: "xpkg.upbound.io/upbound/provider-family-gcp:v1.8.3",
  azure: "xpkg.upbound.io/upbound/provider-family-azure:v1.7.0",
} as const;

export const crossplaneConfigSchema = z.object({
  providers: z
    .array(z.enum(["aws", "gcp", "azure"]))
    .min(1)
    .refine((p) => new Set(p).size === p.length, "provider lặp"),
  replicas: z.number().int().min(1).max(3).default(1),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "INFRA",
  toolId: "crossplane",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "infra.provision", version: "1.0.0" }],
    requires: [],
  },
  configSchema: crossplaneConfigSchema,
  chart: {
    name: "crossplane",
    version: "1.17.1",
    repo: "https://charts.crossplane.io/stable",
  },
  releaseName: "udp-crossplane",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = crossplaneConfigSchema.parse(config);
    return {
      replicas: parsed.replicas,
      provider: {
        packages: [...parsed.providers].sort().map((p) => PROVIDERS[p]),
      },
    };
  },

  bindings: (_ctx, config) => [
    {
      id: "infra.provision",
      version: "1.0.0",
      providedBy: "infra:crossplane",
      attributes: {
        provider: "crossplane",
        mode: "operator",
        // Thuộc tính binding là chuỗi (§5.3): danh sách nối bằng dấu phẩy, thứ tự tất định
        clouds: [...crossplaneConfigSchema.parse(config).providers]
          .sort()
          .join(","),
      },
    },
  ],
});

export default adapter;

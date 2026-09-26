import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { agentClusterName } from "../../adapter-base/agent-cluster.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Snyk (§5.5 Security Scanning, Plan #37) — họ Helm (`snyk-monitor`): controller trong
 * cluster gửi danh sách workload và image về Snyk để quét lỗ hổng phụ thuộc và image
 * (`security.scan`, mode `operator`). Kết quả xem ở Snyk của khách.
 *
 * Integration ID của tổ chức Snyk là bí mật (nó cho phép đẩy dữ liệu vào tổ chức đó): đi vào
 * `Secret` của lớp nền với đúng tên khoá mà chart đọc (`integrationId`, `dockercfg.json`); chart
 * trỏ tới Secret đó bằng `monitorSecrets`. Vùng dữ liệu (US/EU/AU) chọn máy chủ nhận.
 */

const UPSTREAM = {
  us: "https://api.snyk.io/v1/kubernetes-upstream",
  eu: "https://api.eu.snyk.io/v1/kubernetes-upstream",
  au: "https://api.au.snyk.io/v1/kubernetes-upstream",
} as const;

export const snykConfigSchema = z.object({
  integrationId: z.string().uuid().describe("secret"),
  region: z.enum(["us", "eu", "au"]).default("us"),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SECURITY",
  toolId: "snyk",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "security.scan", version: "1.0.0" }],
    requires: [],
  },
  configSchema: snykConfigSchema,
  chart: {
    name: "snyk-monitor",
    version: "2.13.1",
    repo: "https://snyk.github.io/kubernetes-monitor/",
  },
  releaseName: "udp-snyk",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => ({
    clusterName: agentClusterName(ctx),
    integrationApi: UPSTREAM[snykConfigSchema.parse(config).region],
    monitorSecrets: "udp-snyk-secrets",
  }),
  secretKeys: (config) => ({
    integrationId: snykConfigSchema.parse(config).integrationId,
    // Registry riêng đã có `udp-registry-pull` ở namespace env; snyk-monitor chỉ cần tệp hợp lệ
    "dockercfg.json": "{}",
  }),

  bindings: (_ctx, config) => [
    {
      id: "security.scan",
      version: "1.0.0",
      providedBy: "security:snyk",
      attributes: {
        provider: "snyk",
        mode: "operator",
        kinds: "dependencies,image",
        region: snykConfigSchema.parse(config).region,
      },
    },
  ],
});

export default adapter;

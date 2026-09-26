import { z } from "zod";
import type { DomainAdapter, ReadOnlyAdapterContext } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Trivy (§5.5 Security Scanning, Plan #37) — họ Helm (`trivy-operator`): quét liên tục
 * image đang chạy, cấu hình workload, RBAC và bí mật lộ trong cluster, ghi kết quả thành CR
 * (`VulnerabilityReport`, `ConfigAuditReport`) — `security.scan`, mode `operator`.
 *
 * Không quét `udp-system` và `kube-system`: báo cáo về chính nền tảng và thành phần hệ thống
 * không phải việc khách sửa được, và job quét trong đó tranh tài nguyên với controller của UDP.
 */

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;

export const trivyConfigSchema = z.object({
  severities: z
    .array(z.enum(SEVERITIES))
    .min(1)
    .refine((s) => new Set(s).size === s.length, "mức lặp")
    .default(["CRITICAL", "HIGH"]),
  ignoreUnfixed: z.boolean().default(true),
  /** Số job quét chạy cùng lúc — mỗi job là một pod tải DB lỗ hổng */
  concurrentScans: z.number().int().min(1).max(10).default(3),
});

const excluded = (ctx: ReadOnlyAdapterContext): string =>
  [ctx.systemNamespace, "kube-system"].join(",");

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SECURITY",
  toolId: "trivy",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "security.scan", version: "1.0.0" }],
    requires: [],
  },
  configSchema: trivyConfigSchema,
  chart: {
    name: "trivy-operator",
    version: "0.24.1",
    repo: "https://aquasecurity.github.io/helm-charts/",
  },
  releaseName: "udp-trivy",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = trivyConfigSchema.parse(config);
    return {
      excludeNamespaces: excluded(ctx),
      operator: { scanJobsConcurrentLimit: parsed.concurrentScans },
      trivy: {
        // Thứ tự của cấu hình chuẩn hoá — cùng tập mức thì cùng giá trị, drift không báo giả
        severity: SEVERITIES.filter((s) => parsed.severities.includes(s)).join(
          ",",
        ),
        ignoreUnfixed: parsed.ignoreUnfixed,
      },
    };
  },

  bindings: () => [
    {
      id: "security.scan",
      version: "1.0.0",
      providedBy: "security:trivy",
      attributes: {
        provider: "trivy",
        mode: "operator",
        kinds: "config,image,secret",
      },
    },
  ],
});

export default adapter;

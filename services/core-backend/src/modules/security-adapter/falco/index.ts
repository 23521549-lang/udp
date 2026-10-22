import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Falco (§5.5 Security Scanning, Plan #37) — họ Helm: phát hiện mối đe doạ LÚC CHẠY từ
 * syscall (shell trong container, đọc `/etc/shadow`, kết nối lạ) — `security.scan`, kind
 * `runtime`. Cảnh báo ra stdout dạng JSON, nên forwarder log đang bật (Fluent Bit, Fluentd) đưa
 * chúng tới đích log của project mà không cần cấu hình riêng.
 *
 * Driver mặc định `modern_ebpf`: không cần module kernel hay header — chạy được trên node được
 * quản lý của cả ba cloud.
 */

const PRIORITIES = [
  "emergency",
  "alert",
  "critical",
  "error",
  "warning",
  "notice",
  "informational",
  "debug",
] as const;

export const falcoConfigSchema = z.object({
  driver: z.enum(["modern_ebpf", "ebpf", "kmod"]).default("modern_ebpf"),
  /** Mức thấp nhất được báo */
  minimumPriority: z.enum(PRIORITIES).default("warning"),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SECURITY",
  toolId: "falco",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "security.scan", version: "1.0.0" }],
    requires: [],
  },
  configSchema: falcoConfigSchema,
  chart: helmChart("falco"),
  releaseName: "udp-falco",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = falcoConfigSchema.parse(config);
    return {
      driver: { kind: parsed.driver },
      falco: {
        json_output: true,
        priority: parsed.minimumPriority,
        stdout_output: { enabled: true },
      },
    };
  },

  bindings: () => [
    {
      id: "security.scan",
      version: "1.0.0",
      providedBy: "security:falco",
      attributes: { provider: "falco", mode: "operator", kinds: "runtime" },
    },
  ],
});

export default adapter;

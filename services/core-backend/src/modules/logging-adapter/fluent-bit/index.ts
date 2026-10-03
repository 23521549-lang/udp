import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { fluentBitOutput } from "../../adapter-base/forwarder-output.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { logsSinkOf } from "../../adapter-base/logs-sink.js";

/**
 * Adapter Fluent Bit (§5.5 Logging "Fluentd / Fluentbit", Plan #32 QĐ-1, QĐ-2) — forwarder.
 *
 * DaemonSet thu log container và gửi tới `logs.sink` đã resolve — sink của domain KHÁC (Datadog,
 * New Relic, Dynatrace ở Monitoring), vì mỗi domain chỉ một tool và các backend của Logging đã
 * mang bộ thu log riêng. Không `provides` gì: nó là người DÙNG sink, nên `requires` nó.
 *
 * Output đi theo `attributes.protocol` của binding; khoá qua `secretKeyRef` tới `Secret` provider
 * đã khai — cùng namespace `udp-system`, nên §12.2 không phải nới gì. Sink đổi ⇒
 * `onDependencyChanged` render lại output (lớp nền áp lại giá trị).
 */

export const fluentBitConfigSchema = z.object({
  /** Bỏ log của namespace hệ thống (`kube-system`, `udp-system`) — thường chỉ là nhiễu */
  excludeSystemNamespaces: z.boolean().default(true),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "LOGGING",
  toolId: "fluent-bit",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [],
    requires: [{ id: "logs.sink", constraint: "^1" }],
    hint: {
      "logs.sink":
        "Fluent Bit cần nơi nhận log: bật Datadog, New Relic hay Dynatrace ở domain Monitoring",
    },
  },
  configSchema: fluentBitConfigSchema,
  chart: helmChart("fluent-bit"),
  releaseName: "udp-fluent-bit",
  /** DaemonSet không giữ dữ liệu — không chiều quota nào */
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = fluentBitConfigSchema.parse(config);
    // NÉM khi thiếu sink hay giao thức lạ — đoán là gửi log vào một endpoint không hiểu chúng
    const output = fluentBitOutput(logsSinkOf(ctx.resolved["logs.sink"]));
    return {
      env: output.env,
      config: {
        inputs: [
          "[INPUT]",
          "    Name              tail",
          "    Path              /var/log/containers/*.log",
          "    multiline.parser  docker, cri",
          "    Tag               kube.*",
          ...(parsed.excludeSystemNamespaces
            ? [
                `    Exclude_Path      /var/log/containers/*_kube-system_*.log,/var/log/containers/*_${ctx.systemNamespace}_*.log`,
              ]
            : []),
        ].join("\n"),
        outputs: output.config,
      },
    };
  },

  bindings: () => [],
});

export default adapter;

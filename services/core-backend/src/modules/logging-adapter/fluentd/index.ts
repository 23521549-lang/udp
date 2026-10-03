import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { fluentdOutput } from "../../adapter-base/forwarder-output.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { logsSinkOf } from "../../adapter-base/logs-sink.js";

/**
 * Adapter Fluentd (§5.5 Logging "Fluentd / Fluentbit", Plan #32 QĐ-1, QĐ-2) — forwarder.
 *
 * Cùng vai với Fluent Bit (gửi log container tới `logs.sink` của domain khác) nhưng là
 * aggregator có BUFFER trên đĩa: log không mất khi sink chậm hay tạm chết. Cái giá là PVC cho
 * buffer — nên nó tiêu thụ `maxStorageGb`, còn Fluent Bit thì không.
 */

export const fluentdConfigSchema = z.object({
  /** Buffer trên đĩa khi sink chậm, GiB */
  bufferGb: z.number().int().min(1).max(100).default(5),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "LOGGING",
  toolId: "fluentd",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [],
    requires: [{ id: "logs.sink", constraint: "^1" }],
    hint: {
      "logs.sink":
        "Fluentd cần nơi nhận log: bật Datadog, New Relic hay Dynatrace ở domain Monitoring",
    },
  },
  configSchema: fluentdConfigSchema,
  chart: helmChart("fluentd"),
  releaseName: "udp-fluentd",
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = fluentdConfigSchema.parse(config);
    const output = fluentdOutput(logsSinkOf(ctx.resolved["logs.sink"]));
    return {
      kind: "DaemonSet",
      env: output.env,
      persistence: {
        enabled: true,
        size: `${String(parsed.bufferGb)}Gi`,
      },
      fileConfigs: { "04_outputs.conf": output.config },
    };
  },

  bindings: () => [],
});

export default adapter;

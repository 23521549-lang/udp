import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { DATADOG_SITES } from "@udp/metrics-provider";
import { agentClusterName } from "../../adapter-base/agent-cluster.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { logsSinkBinding } from "../../adapter-base/logs-sink.js";

/**
 * Adapter Datadog Logs (§5.5 Logging, Plan #32) — họ Helm CÓ agent.
 *
 * Khác adapter `datadog` của Monitoring (họ SaaS, chỉ cấu hình phía Datadog): đây là Datadog
 * Agent trong cluster, chỉ bật thu log container (`containerCollectAll`), gửi về đúng site của
 * tài khoản. API key vào `Secret` của release (Plan #31) — cả dạng giá trị Helm lẫn khoá phẳng
 * `api-key` cho forwarder khác (Plan #32 QĐ-3). Không cần application key: agent chỉ GỬI.
 */

export const datadogLogsConfigSchema = z.object({
  site: z.enum(DATADOG_SITES),
  apiKey: z
    .string()
    .regex(/^[0-9a-f]{32}$/i)
    .describe("secret"),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "LOGGING",
  toolId: "datadog-logs",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "logs.sink", version: "1.0.0" }],
    requires: [],
  },
  configSchema: datadogLogsConfigSchema,
  chart: {
    name: "datadog",
    version: "3.69.3",
    repo: "https://helm.datadoghq.com",
  },
  releaseName: "udp-datadog-logs",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = datadogLogsConfigSchema.parse(config);
    return {
      datadog: {
        site: parsed.site,
        clusterName: agentClusterName(ctx),
        logs: { enabled: true, containerCollectAll: true },
        apm: { portEnabled: false },
        processAgent: { enabled: false },
      },
      clusterAgent: { enabled: true },
    };
  },
  secretValues: (config) => ({
    datadog: { apiKey: datadogLogsConfigSchema.parse(config).apiKey },
  }),
  secretKeys: (config) => ({
    "api-key": datadogLogsConfigSchema.parse(config).apiKey,
  }),

  bindings: (_ctx, config) => [
    logsSinkBinding("logging:datadog-logs", {
      protocol: "datadog",
      endpoint: `https://http-intake.logs.${datadogLogsConfigSchema.parse(config).site}/api/v2/logs`,
      credential: {
        secretName: "udp-datadog-logs-secrets",
        secretKey: "api-key",
      },
    }),
  ],
});

export default adapter;

import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { agentClusterName } from "../../adapter-base/agent-cluster.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { logsSinkBinding } from "../../adapter-base/logs-sink.js";

/**
 * Adapter Splunk (§5.5 Logging, Plan #32) — họ Helm CÓ agent.
 *
 * `splunk-otel-collector` thu log container và gửi tới HTTP Event Collector (HEC) của Splunk
 * Enterprise hay Splunk Cloud của khách. HEC token là bí mật của tool (Plan #31): vào `Secret`
 * của release, cả dạng giá trị Helm (`splunkPlatform.token`) lẫn khoá phẳng `hec-token` cho
 * forwarder khác dùng qua binding (Plan #32 QĐ-3).
 *
 * Endpoint HEC chỉ nhận `https` và đường `/services/collector` — Splunk Cloud lẫn Enterprise đều
 * mở đúng đường này; một URL tự do là chỗ gửi token của khách tới máy bất kỳ.
 */

export const splunkConfigSchema = z.object({
  /** `https://<host>:8088/services/collector` hay `https://http-inputs-<stack>.splunkcloud.com/services/collector` */
  hecEndpoint: z
    .string()
    .regex(/^https:\/\/[a-z0-9.-]+(:\d{2,5})?\/services\/collector$/),
  /** HEC token — định dạng GUID mà Splunk sinh */
  hecToken: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .describe("secret"),
  /** Index nhận log */
  index: z
    .string()
    .regex(/^[a-z0-9_][a-z0-9_-]{0,79}$/)
    .default("main"),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "LOGGING",
  toolId: "splunk",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "logs.sink", version: "1.0.0" }],
    requires: [],
  },
  configSchema: splunkConfigSchema,
  chart: helmChart("splunk-otel-collector"),
  releaseName: "udp-splunk",
  /** Log nằm ở Splunk của khách — không PVC nào trong cluster */
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = splunkConfigSchema.parse(config);
    return {
      clusterName: agentClusterName(ctx),
      splunkPlatform: {
        endpoint: parsed.hecEndpoint,
        index: parsed.index,
        logsEnabled: true,
        metricsEnabled: false,
        tracesEnabled: false,
      },
    };
  },
  secretValues: (config) => ({
    splunkPlatform: { token: splunkConfigSchema.parse(config).hecToken },
  }),
  secretKeys: (config) => ({
    "hec-token": splunkConfigSchema.parse(config).hecToken,
  }),

  bindings: (_ctx, config) => [
    logsSinkBinding("logging:splunk", {
      protocol: "splunk-hec",
      endpoint: splunkConfigSchema.parse(config).hecEndpoint,
      credential: { secretName: "udp-splunk-secrets", secretKey: "hec-token" },
    }),
  ],
});

export default adapter;

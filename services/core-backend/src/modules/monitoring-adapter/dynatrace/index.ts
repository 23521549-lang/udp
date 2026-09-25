import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import type { MetricsSourceDeclaration } from "@udp/metrics-provider";
import { agentClusterName } from "../../adapter-base/agent-cluster.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Dynatrace (§5.5 Monitoring, Plan #31) — họ Helm CÓ agent (QĐ-3).
 *
 * `dynatrace-operator` cài operator + CSI driver; DynaKube khai OneAgent và ActiveGate (trong
 * mô hình mô phỏng của §13.2 nó đi cùng giá trị release — `helm-real` là nơi tách nó thành CR
 * riêng). ActiveGate scrape `/metrics` của Golden Path, nên nhãn `ff` tới được Dynatrace.
 *
 * **Chỉ Dynatrace SaaS** (`<id>.live|apps.dynatrace.com`): Managed chạy trên miền của khách,
 * và một URL tự do ở đây là một đường SSRF mà egress guard chỉ chặn được nửa (IP nội bộ,
 * không chặn được một máy công khai bất kỳ nhận khoá của khách).
 *
 * `metrics.query` 1.0.0 — metric selector không phải PromQL (§5.3).
 */

const DT_TOKEN = /^dt0c01\.[A-Z0-9]{24}\.[A-Z0-9]{64}$/;

export const dynatraceConfigSchema = z.object({
  environmentUrl: z
    .string()
    .regex(/^https:\/\/[a-z0-9]{8}\.(live|apps)\.dynatrace\.com$/),
  /** Token của operator — kèm scope `metrics.read` để UDP truy vấn cho canary analysis */
  apiToken: z.string().regex(DT_TOKEN).describe("secret"),
  /** Token ingest của ActiveGate — metric, log, trace đi vào bằng khoá này */
  dataIngestToken: z.string().regex(DT_TOKEN).describe("secret"),
  /** Cách OneAgent vào pod: cloud-native (CSI) là mặc định của operator */
  mode: z
    .enum(["cloudNativeFullStack", "classicFullStack", "applicationMonitoring"])
    .default("cloudNativeFullStack"),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "MONITORING",
  toolId: "dynatrace",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [
      { id: "metrics.query", version: "1.0.0" },
      { id: "logs.sink", version: "1.0.0" },
      { id: "traces.sink", version: "1.0.0" },
    ],
    requires: [],
  },
  configSchema: dynatraceConfigSchema,
  chart: {
    name: "dynatrace-operator",
    version: "1.3.2",
    repo: "https://raw.githubusercontent.com/Dynatrace/dynatrace-operator/main/config/helm/repos/stable",
  },
  releaseName: "udp-dynatrace",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = dynatraceConfigSchema.parse(config);
    return {
      installCRD: true,
      platform: "kubernetes",
      csidriver: { enabled: parsed.mode === "cloudNativeFullStack" },
      dynakube: {
        name: agentClusterName(ctx),
        apiUrl: `${parsed.environmentUrl}/api`,
        oneAgent: { [parsed.mode]: {} },
        activeGate: {
          capabilities: ["kubernetes-monitoring", "routing", "metrics-ingest"],
        },
        metadataEnrichment: { enabled: true },
      },
    };
  },
  secretValues: (config) => {
    const { apiToken, dataIngestToken } = dynatraceConfigSchema.parse(config);
    return { dynakube: { tokens: { apiToken, dataIngestToken } } };
  },

  bindings: (_ctx, config) => {
    const { environmentUrl } = dynatraceConfigSchema.parse(config);
    const at = (
      id: "metrics.query" | "logs.sink" | "traces.sink",
      path: string,
    ) => ({
      id,
      version: "1.0.0",
      providedBy: "monitoring:dynatrace",
      endpoint: `${environmentUrl}${path}`,
    });
    return [
      at("metrics.query", "/api/v2/metrics/query"),
      at("logs.sink", "/api/v2/logs/ingest"),
      at("traces.sink", "/api/v2/otlp/v1/traces"),
    ];
  },
});

export default adapter;

/** §5.4: Metrics API v2 bằng token của operator — cùng environment đã cấu hình */
export const metricsSource: MetricsSourceDeclaration = {
  kind: "dynatrace",
  of: (config) => {
    const { environmentUrl, apiToken } = dynatraceConfigSchema.parse(config);
    return { kind: "dynatrace", environmentUrl, apiToken };
  },
};

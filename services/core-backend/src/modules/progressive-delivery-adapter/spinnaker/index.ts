import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import type { CapabilityBinding } from "@udp/shared-types";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Spinnaker (§5.5 Progressive Delivery, Plan #33 QĐ-6) — họ Helm, chart `spinnaker`.
 *
 * CD đa cloud: triển khai red/black qua Service của chính nó, nên KHÔNG đòi mesh hay ingress;
 * canary analysis là Kayenta, nói được Prometheus lẫn Datadog/New Relic ⇒ `metrics.query >=1`.
 * `traffic.control` EXCLUSIVE như Flagger và Argo. Redis và MinIO (lưu pipeline, artifact) trên
 * PVC ⇒ tiêu thụ `maxStorageGb`. Kayenta không có metric store cho Dynatrace ⇒ `conflicts`.
 */

export const spinnakerConfigSchema = z.object({
  /** PVC của MinIO (artifact, trạng thái pipeline), GiB */
  storageGb: z.number().int().min(5).max(500).default(20),
  /** Bật Kayenta — canary analysis tự động trên `metrics.query` */
  kayenta: z.boolean().default(true),
});

/**
 * Metric store của Kayenta theo binding: họ PromQL (major 2) là `prometheus`; ngôn ngữ riêng thì
 * theo nhà cung cấp. Nhà cung cấp Kayenta không hỗ trợ ⇒ NÉM (validator đã chặn bằng `conflicts`).
 */
const KAYENTA_STORES: Readonly<Record<string, string>> = {
  "monitoring:datadog": "datadog",
  "monitoring:newrelic": "newrelic",
};

function kayentaStoreOf(binding: CapabilityBinding): string {
  if (binding.version.startsWith("2.")) return "prometheus";
  const store = KAYENTA_STORES[binding.providedBy];
  if (store === undefined) {
    throw new Error(`Kayenta không có metric store cho ${binding.providedBy}`);
  }
  return store;
}

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "PROGRESSIVE_DELIVERY",
  toolId: "spinnaker",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "traffic.control", version: "1.0.0", exclusive: true }],
    requires: [{ id: "metrics.query", constraint: ">=1" }],
    conflicts: ["monitoring:dynatrace"],
    hint: {
      "metrics.query":
        "Spinnaker (Kayenta) cần nguồn metrics: bật một tool ở domain Monitoring.",
    },
  },
  configSchema: spinnakerConfigSchema,
  chart: helmChart("spinnaker"),
  releaseName: "udp-spinnaker",
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = spinnakerConfigSchema.parse(config);
    const metrics = ctx.resolved["metrics.query"];
    if (metrics?.endpoint === undefined) {
      throw new Error("thiếu binding metrics.query trong ctx.resolved");
    }
    return {
      minio: {
        enabled: true,
        persistence: { size: `${String(parsed.storageGb)}Gi` },
      },
      redis: { enabled: true },
      kayenta: {
        enabled: parsed.kayenta,
        metricsStore: { type: kayentaStoreOf(metrics), url: metrics.endpoint },
      },
    };
  },

  bindings: () => [
    {
      id: "traffic.control",
      version: "1.0.0",
      providedBy: "progressive_delivery:spinnaker",
    },
  ],
});

export default adapter;

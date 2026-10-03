import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { BUILD_NAMESPACE } from "../../adapter-base/packaging/build-script.js";

/**
 * Adapter OPA Gatekeeper (§5.5 Policy & Governance, Plan #34) — họ Helm, chart `gatekeeper`.
 *
 * Admission webhook với ngôn ngữ Rego. Webhook MIỄN TRỪ `udp-system` và `kube-system` (QĐ-1):
 * một ràng buộc "không chạy root" áp lên controller mà UDP cài là tự khoá đường cài đặt của chính
 * nền tảng — và lỗi đó chỉ lộ ra ở lượt nâng cấp kế tiếp.
 */

export const gatekeeperConfigSchema = z.object({
  replicas: z.number().int().min(1).max(3).default(1),
  /** Chu kỳ audit các tài nguyên đang có, giây */
  auditIntervalSeconds: z.number().int().min(30).max(3600).default(60),
  /** Webhook hỏng thì từ chối (`Fail`) hay cho qua (`Ignore`) */
  failurePolicy: z.enum(["Ignore", "Fail"]).default("Ignore"),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "POLICY",
  toolId: "gatekeeper",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "policy.admission", version: "1.0.0" }],
    requires: [],
  },
  configSchema: gatekeeperConfigSchema,
  chart: helmChart("gatekeeper"),
  releaseName: "udp-gatekeeper",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = gatekeeperConfigSchema.parse(config);
    return {
      replicas: parsed.replicas,
      auditInterval: parsed.auditIntervalSeconds,
      validatingWebhookFailurePolicy: parsed.failurePolicy,
      controllerManager: {
        // [Plan #61 QĐ-12] `udp-build`: pod build của CI trong cluster (BuildKit cần seccomp `Unconfined`)
        exemptNamespaces: [ctx.systemNamespace, "kube-system", BUILD_NAMESPACE],
      },
    };
  },

  bindings: () => [
    {
      id: "policy.admission",
      version: "1.0.0",
      providedBy: "policy:gatekeeper",
      attributes: { engine: "gatekeeper", language: "rego" },
    },
  ],
});

export default adapter;

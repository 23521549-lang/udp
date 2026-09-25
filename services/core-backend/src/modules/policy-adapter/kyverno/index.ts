import { z } from "zod";
import type { DomainAdapter, ReadOnlyAdapterContext } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Kyverno (§5.5 Policy & Governance, Plan #34) — họ Helm, hai release: `kyverno` (engine)
 * rồi `kyverno-policies` (bộ Pod Security Standards chính thức).
 *
 * Mức PSS (`baseline`/`restricted`) và chế độ (`Audit`/`Enforce`) là cấu hình; mặc định Audit —
 * bật Enforce trên một project đang chạy mà chưa audit là chặn deploy của khách không báo trước.
 * Webhook miễn trừ `udp-system` và `kube-system` (QĐ-1).
 */

export const kyvernoConfigSchema = z.object({
  podSecurityStandard: z.enum(["baseline", "restricted"]).default("baseline"),
  validationFailureAction: z.enum(["Audit", "Enforce"]).default("Audit"),
  replicas: z.number().int().min(1).max(3).default(1),
});

const REPO = "https://kyverno.github.io/kyverno/";

/** Namespace mà KHÔNG policy nào được chạm — nền tảng và hệ thống của Kubernetes */
const exempt = (ctx: ReadOnlyAdapterContext): string[] => [
  ctx.systemNamespace,
  "kube-system",
];

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "POLICY",
  toolId: "kyverno",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "policy.admission", version: "1.0.0" }],
    requires: [],
  },
  configSchema: kyvernoConfigSchema,
  chart: { name: "kyverno", version: "3.2.7", repo: REPO },
  releaseName: "udp-kyverno",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = kyvernoConfigSchema.parse(config);
    return {
      admissionController: { replicas: parsed.replicas },
      config: {
        webhooks: [
          {
            namespaceSelector: {
              matchExpressions: [
                {
                  key: "kubernetes.io/metadata.name",
                  operator: "NotIn",
                  values: exempt(ctx),
                },
              ],
            },
          },
        ],
      },
    };
  },
  companions: [
    {
      releaseName: "udp-kyverno-policies",
      chart: { name: "kyverno-policies", version: "3.2.6", repo: REPO },
      values: (config, ctx) => {
        const parsed = kyvernoConfigSchema.parse(config);
        return {
          podSecurityStandard: parsed.podSecurityStandard,
          validationFailureAction: parsed.validationFailureAction,
          policyExclude: {
            any: [{ resources: { namespaces: exempt(ctx) } }],
          },
        };
      },
    },
  ],

  bindings: () => [
    {
      id: "policy.admission",
      version: "1.0.0",
      providedBy: "policy:kyverno",
      attributes: { engine: "kyverno", language: "yaml" },
    },
  ],
});

export default adapter;

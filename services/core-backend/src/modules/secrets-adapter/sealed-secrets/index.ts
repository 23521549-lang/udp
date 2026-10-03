import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { secretsStoreBinding } from "../../adapter-base/secrets-store.js";

/**
 * Adapter Kubernetes Secrets + Sealed Secrets (§5.5 Secrets Management, Plan #34) — họ Helm,
 * chart `sealed-secrets`. Controller thường (KHÔNG phải CSI driver — v3 ghi sai, §5.5).
 *
 * Người dùng mã hoá bí mật bằng khoá công khai của controller (`kubeseal`) rồi commit
 * `SealedSecret` vào Git — cặp tự nhiên với GitOps. Khoá riêng sinh và xoay VÒNG trong cluster;
 * UDP không bao giờ thấy nó.
 */

export const sealedSecretsConfigSchema = z.object({
  /** Xoay khoá niêm phong sau bấy nhiêu ngày; 0 = không xoay */
  keyRenewDays: z.number().int().min(0).max(365).default(30),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SECRETS",
  toolId: "sealed-secrets",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "secrets.store", version: "1.0.0" }],
    requires: [],
    recommends: ["gitops.sync"],
  },
  configSchema: sealedSecretsConfigSchema,
  chart: helmChart("sealed-secrets"),
  releaseName: "udp-sealed-secrets",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => ({
    fullnameOverride: "sealed-secrets-controller",
    keyrenewperiod: `${String(sealedSecretsConfigSchema.parse(config).keyRenewDays * 24)}h`,
  }),

  bindings: (ctx) => [
    secretsStoreBinding("secrets:sealed-secrets", "sealed-secrets", {
      controllerName: "sealed-secrets-controller",
      controllerNamespace: ctx.systemNamespace,
    }),
  ],
});

export default adapter;

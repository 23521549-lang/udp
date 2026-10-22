import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { gitRepoShape } from "../../adapter-base/git-repo.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Argo CD (§5.5 GitOps, Plan #34) — họ Helm, chart `argo-cd`.
 *
 * Cài Argo CD vào `udp-system`, khai repo của project và MỘT `Application` gốc (`udp-root`) trỏ
 * vào đường dẫn đã chọn — mẫu "app of apps": mọi thứ khác nằm trong repo của khách. Token đọc repo
 * là bí mật của tool: vào `Secret` của release (Plan #31), không vào ConfigMap.
 *
 * `gitops.sync` EXCLUSIVE — một cluster một GitOps controller (§5.3).
 */

export const argoCdConfigSchema = z.object({
  ...gitRepoShape,
  /** `automated` = tự đồng bộ, prune và self-heal; `manual` = chỉ báo lệch, người bấm đồng bộ */
  syncPolicy: z.enum(["automated", "manual"]).default("automated"),
  /** Hai bản sao controller và server, Redis HA */
  highAvailability: z.boolean().default(false),
});

const REPO_NAME = "udp-repo";

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "GITOPS",
  toolId: "argo-cd",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "gitops.sync", version: "1.0.0", exclusive: true }],
    requires: [],
  },
  configSchema: argoCdConfigSchema,
  chart: helmChart("argo-cd"),
  releaseName: "udp-argocd",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = argoCdConfigSchema.parse(config);
    const replicas = parsed.highAvailability ? 2 : 1;
    return {
      configs: {
        repositories: {
          [REPO_NAME]: { url: parsed.repoUrl, type: "git", name: REPO_NAME },
        },
      },
      controller: { replicas },
      server: { replicas },
      "redis-ha": { enabled: parsed.highAvailability },
      extraObjects: [
        {
          apiVersion: "argoproj.io/v1alpha1",
          kind: "Application",
          metadata: { name: "udp-root", namespace: ctx.systemNamespace },
          spec: {
            project: "default",
            source: {
              repoURL: parsed.repoUrl,
              targetRevision: parsed.revision,
              path: parsed.path,
            },
            destination: { server: "https://kubernetes.default.svc" },
            syncPolicy:
              parsed.syncPolicy === "automated"
                ? { automated: { prune: true, selfHeal: true } }
                : {},
          },
        },
      ],
    };
  },
  /** Repo công khai thì không có gì để giấu — Secret mang giá trị rỗng */
  secretValues: (config) => {
    const { token } = argoCdConfigSchema.parse(config);
    return token === undefined
      ? {}
      : {
          configs: {
            repositories: { [REPO_NAME]: { username: "git", password: token } },
          },
        };
  },

  bindings: (ctx, config) => [
    {
      id: "gitops.sync",
      version: "1.0.0",
      providedBy: "gitops:argo-cd",
      endpoint: `https://udp-argocd-server.${ctx.systemNamespace}`,
      attributes: {
        controller: "argocd",
        repoUrl: argoCdConfigSchema.parse(config).repoUrl,
      },
    },
  ],
});

export default adapter;

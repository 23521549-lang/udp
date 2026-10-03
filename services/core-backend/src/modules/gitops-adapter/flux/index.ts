import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { gitRepoShape } from "../../adapter-base/git-repo.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Flux CD (§5.5 GitOps, Plan #34 QĐ-5) — họ Helm, hai release: `flux2` (bộ controller)
 * rồi `flux2-sync` (`GitRepository` + `Kustomization` cho repo của project).
 *
 * Token đọc repo là bí mật của tool; `flux2-sync` nhận nó qua `readsSecretValues` (Plan #32) để
 * chart tự dựng Secret xác thực của `GitRepository`. Cơ chế cài của UDP là `helm upgrade
 * --install` (§5.2), độc lập với Flux — `HelmRelease` trong mô hình mô phỏng chỉ là bản ghi.
 *
 * `gitops.sync` EXCLUSIVE — một cluster một GitOps controller (§5.3).
 */

export const fluxConfigSchema = z.object({
  ...gitRepoShape,
  /** Chu kỳ Flux hỏi lại repo, phút */
  intervalMinutes: z.number().int().min(1).max(60).default(1),
});

const REPO = "https://fluxcd-community.github.io/helm-charts";
const SYNC_RELEASE = "udp-flux-sync";

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "GITOPS",
  toolId: "flux",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "gitops.sync", version: "1.0.0", exclusive: true }],
    requires: [],
  },
  configSchema: fluxConfigSchema,
  chart: helmChart("flux2"),
  releaseName: "udp-flux",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: () => ({
    sourceController: { create: true },
    kustomizeController: { create: true },
    helmController: { create: true },
    notificationController: { create: true },
    imageAutomationController: { create: false },
    imageReflectionController: { create: false },
  }),
  secretValues: (config) => {
    const { token } = fluxConfigSchema.parse(config);
    return token === undefined
      ? {}
      : {
          secret: { create: true, data: { username: "git", password: token } },
        };
  },
  companions: [
    {
      releaseName: SYNC_RELEASE,
      chart: helmChart("flux2-sync"),
      readsSecretValues: true,
      values: (config) => {
        const parsed = fluxConfigSchema.parse(config);
        return {
          gitRepository: {
            spec: {
              url: parsed.repoUrl,
              ref: { branch: parsed.revision },
              interval: `${String(parsed.intervalMinutes)}m`,
              ...(parsed.token === undefined
                ? {}
                : { secretRef: { name: SYNC_RELEASE } }),
            },
          },
          kustomization: {
            spec: { path: parsed.path, prune: true, interval: "5m" },
          },
        };
      },
    },
  ],

  bindings: (_ctx, config) => [
    {
      id: "gitops.sync",
      version: "1.0.0",
      providedBy: "gitops:flux",
      attributes: {
        controller: "flux",
        repoUrl: fluxConfigSchema.parse(config).repoUrl,
      },
    },
  ],
});

export default adapter;

import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import type { PullCredentialDeclaration } from "../../adapter-base/registry-pull.js";

/**
 * Adapter JFrog Artifactory (§5.5 Artifact & Package Registry, Plan #35) — họ Helm, chart
 * `artifactory-oss`.
 *
 * Kho đa định dạng: package ngôn ngữ và image OCI ⇒ `packages.store` + `registry.oci` (QĐ-4).
 * Mật khẩu admin và khoá kéo (người dùng chỉ đọc) là bí mật của tool. Kho trên PVC ⇒
 * `maxStorageGb`; mở ra ngoài qua LoadBalancer của chart ⇒ `maxLoadBalancers`.
 */

export const artifactoryConfigSchema = z.object({
  externalUrl: z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d{2,5})?$/),
  adminPassword: z.string().min(12).describe("secret"),
  storageGb: z.number().int().min(10).max(2000).default(100),
  pullUser: z
    .string()
    .regex(/^[a-z0-9._-]{3,64}$/)
    .optional(),
  pullToken: z.string().min(16).describe("secret").optional(),
});

const FORMATS = "npm,maven,pypi,helm,docker,generic";
const hostOf = (url: string): string => new URL(url).host;

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "ARTIFACT_REGISTRY",
  toolId: "artifactory",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [
      { id: "packages.store", version: "1.0.0" },
      { id: "registry.oci", version: "1.0.0" },
    ],
    requires: [],
  },
  configSchema: artifactoryConfigSchema,
  chart: {
    name: "artifactory-oss",
    version: "107.90.10",
    repo: "https://charts.jfrog.io",
  },
  releaseName: "udp-artifactory",
  quotaDimensions: ["maxStorageGb", "maxLoadBalancers"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = artifactoryConfigSchema.parse(config);
    return {
      artifactory: {
        artifactory: {
          persistence: { size: `${String(parsed.storageGb)}Gi` },
        },
        nginx: { service: { type: "LoadBalancer" } },
      },
      postgresql: { enabled: true },
    };
  },
  secretValues: (config) => ({
    artifactory: {
      artifactory: {
        admin: {
          password: artifactoryConfigSchema.parse(config).adminPassword,
        },
      },
    },
  }),

  bindings: (_ctx, config) => {
    const url = artifactoryConfigSchema.parse(config).externalUrl;
    return [
      {
        id: "packages.store",
        version: "1.0.0",
        providedBy: "artifact_registry:artifactory",
        endpoint: `${url}/artifactory`,
        attributes: { formats: FORMATS },
      },
      {
        id: "registry.oci",
        version: "1.0.0",
        providedBy: "artifact_registry:artifactory",
        endpoint: hostOf(url),
      },
    ];
  },
});

export default adapter;

export const pullCredential: PullCredentialDeclaration = (config) => {
  const parsed = artifactoryConfigSchema.parse(config);
  return parsed.pullUser === undefined || parsed.pullToken === undefined
    ? null
    : {
        server: hostOf(parsed.externalUrl),
        username: parsed.pullUser,
        password: parsed.pullToken,
      };
};

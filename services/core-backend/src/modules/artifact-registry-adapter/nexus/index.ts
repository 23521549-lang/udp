import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import type { PullCredentialDeclaration } from "../../adapter-base/registry-pull.js";

/**
 * Adapter Nexus Repository (§5.5 Artifact & Package Registry, Plan #35) — họ Helm, chart
 * `nexus-repository-manager`.
 *
 * Kho đa định dạng tự lưu trữ ⇒ `packages.store` + `registry.oci` (QĐ-4); connector Docker mở
 * trên cổng riêng. Mật khẩu admin ban đầu và khoá kéo là bí mật của tool; kho trên PVC ⇒
 * `maxStorageGb`.
 */

export const nexusConfigSchema = z.object({
  externalUrl: z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d{2,5})?$/),
  adminPassword: z.string().min(12).describe("secret"),
  storageGb: z.number().int().min(10).max(2000).default(100),
  /** Cổng connector Docker của repository hosted */
  dockerPort: z.number().int().min(1024).max(65535).default(8082),
  pullUser: z
    .string()
    .regex(/^[a-z0-9._-]{3,64}$/)
    .optional(),
  pullPassword: z.string().min(12).describe("secret").optional(),
});

const FORMATS = "maven,npm,pypi,nuget,docker,raw";
const hostOf = (url: string): string => new URL(url).hostname;

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "ARTIFACT_REGISTRY",
  toolId: "nexus",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [
      { id: "packages.store", version: "1.0.0" },
      { id: "registry.oci", version: "1.0.0" },
    ],
    requires: [],
  },
  configSchema: nexusConfigSchema,
  chart: helmChart("nexus-repository-manager"),
  releaseName: "udp-nexus",
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = nexusConfigSchema.parse(config);
    return {
      persistence: { storageSize: `${String(parsed.storageGb)}Gi` },
      nexus: {
        docker: {
          enabled: true,
          registries: [
            { host: hostOf(parsed.externalUrl), port: parsed.dockerPort },
          ],
        },
      },
    };
  },
  secretValues: (config) => ({
    nexus: {
      env: [
        {
          name: "NEXUS_SECURITY_INITIAL_PASSWORD",
          value: nexusConfigSchema.parse(config).adminPassword,
        },
      ],
    },
  }),

  bindings: (_ctx, config) => {
    const parsed = nexusConfigSchema.parse(config);
    return [
      {
        id: "packages.store",
        version: "1.0.0",
        providedBy: "artifact_registry:nexus",
        endpoint: `${parsed.externalUrl}/repository`,
        attributes: { formats: FORMATS },
      },
      {
        id: "registry.oci",
        version: "1.0.0",
        providedBy: "artifact_registry:nexus",
        endpoint: `${hostOf(parsed.externalUrl)}:${String(parsed.dockerPort)}`,
        attributes: { pushAuth: "basic" },
      },
    ];
  },
});

export default adapter;

export const pullCredential: PullCredentialDeclaration = (config) => {
  const parsed = nexusConfigSchema.parse(config);
  return parsed.pullUser === undefined || parsed.pullPassword === undefined
    ? null
    : {
        server: `${hostOf(parsed.externalUrl)}:${String(parsed.dockerPort)}`,
        username: parsed.pullUser,
        password: parsed.pullPassword,
      };
};

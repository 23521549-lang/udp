import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import type { PullCredentialDeclaration } from "../../adapter-base/registry-pull.js";

/**
 * Adapter Harbor (§5.5 Container Registry, Plan #35) — họ Helm, chart `harbor`.
 *
 * Registry tự lưu trữ trong cluster, có quét lỗ hổng (Trivy tích hợp). Mật khẩu admin là bí mật
 * của tool, vào `Secret` của release (Plan #31). Kéo image riêng tư bằng robot account chỉ
 * `pull` — cấu hình tuỳ chọn, nền tảng phân phối vào `udp-registry-pull` (Plan #35 QĐ-3). Mở ra
 * ngoài bằng một Service LoadBalancer ⇒ tiêu thụ `maxLoadBalancers`; kho image trên PVC ⇒
 * `maxStorageGb`.
 */

export const harborConfigSchema = z.object({
  /** URL công khai mà `docker push/pull` dùng — phải là https */
  externalUrl: z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d{2,5})?$/),
  adminPassword: z
    .string()
    .min(8)
    .regex(/[A-Z]/)
    .regex(/[a-z]/)
    .regex(/\d/)
    .describe("secret"),
  /** PVC của registry, GiB */
  storageGb: z.number().int().min(5).max(2000).default(50),
  /** Robot account chỉ `pull` — tên đầy đủ `robot$project+name` */
  pullRobotName: z
    .string()
    .regex(/^robot\$[a-z0-9._-]+(\+[a-z0-9._-]+)?$/)
    .optional(),
  pullRobotSecret: z.string().min(16).describe("secret").optional(),
});

const hostOf = (url: string): string => new URL(url).host;

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "CONTAINER_REGISTRY",
  toolId: "harbor",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "registry.oci", version: "1.0.0" }],
    requires: [],
    recommends: ["policy.admission"],
  },
  configSchema: harborConfigSchema,
  chart: {
    name: "harbor",
    version: "1.15.1",
    repo: "https://helm.goharbor.io",
  },
  releaseName: "udp-harbor",
  quotaDimensions: ["maxStorageGb", "maxLoadBalancers"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = harborConfigSchema.parse(config);
    return {
      expose: { type: "loadBalancer", tls: { enabled: true } },
      externalURL: parsed.externalUrl,
      persistence: {
        persistentVolumeClaim: {
          registry: { size: `${String(parsed.storageGb)}Gi` },
        },
      },
      trivy: { enabled: true },
    };
  },
  secretValues: (config) => ({
    harborAdminPassword: harborConfigSchema.parse(config).adminPassword,
  }),

  bindings: (_ctx, config) => [
    {
      id: "registry.oci",
      version: "1.0.0",
      providedBy: "container_registry:harbor",
      endpoint: hostOf(harborConfigSchema.parse(config).externalUrl),
    },
  ],
});

export default adapter;

export const pullCredential: PullCredentialDeclaration = (config) => {
  const parsed = harborConfigSchema.parse(config);
  return parsed.pullRobotName === undefined ||
    parsed.pullRobotSecret === undefined
    ? null
    : {
        server: hostOf(parsed.externalUrl),
        username: parsed.pullRobotName,
        password: parsed.pullRobotSecret,
      };
};

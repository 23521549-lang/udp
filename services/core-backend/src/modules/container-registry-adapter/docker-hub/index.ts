import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createRegistryAdapter } from "../../adapter-base/registry.js";
import type { PullCredentialDeclaration } from "../../adapter-base/registry-pull.js";

/**
 * Adapter Docker Hub (§5.5 Container Registry, Plan #35) — lớp nền `RegistryAdapter`.
 *
 * Image công khai kéo không cần khoá. Repository riêng tư (hay tránh giới hạn tần suất kéo ẩn
 * danh) cần tên người dùng + access token chỉ đọc: bí mật của tool, nền tảng phân phối vào
 * `udp-registry-pull` (QĐ-3).
 */

export const dockerHubConfigSchema = z.object({
  /** Tổ chức hay người dùng sở hữu repository */
  namespace: z.string().regex(/^[a-z0-9]{2,255}$/),
  username: z
    .string()
    .regex(/^[a-z0-9]{4,30}$/)
    .optional(),
  /** Personal access token chỉ `read` */
  accessToken: z
    .string()
    .regex(/^dckr_pat_[A-Za-z0-9_-]{20,}$/)
    .describe("secret")
    .optional(),
});

const adapter: DomainAdapter = createRegistryAdapter({
  domainType: "CONTAINER_REGISTRY",
  toolId: "docker-hub",
  version: "1.0.0",
  capabilities: {
    provides: [{ id: "registry.oci", version: "1.0.0" }],
    requires: [],
  },
  configSchema: dockerHubConfigSchema,
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/"],
  describe: (config) => {
    const parsed = dockerHubConfigSchema.parse(config);
    return {
      server: "docker.io",
      namespace: parsed.namespace,
      pullAuth: parsed.username === undefined ? "anonymous" : "pull-secret",
    };
  },
  bindings: (_ctx, config) => [
    {
      id: "registry.oci",
      version: "1.0.0",
      providedBy: "container_registry:docker-hub",
      endpoint: `docker.io/${dockerHubConfigSchema.parse(config).namespace}`,
      // [Plan #61 QĐ-6] Access token có quyền đẩy là secret của CI
      attributes: { pushAuth: "basic" },
    },
  ],
});

export default adapter;

export const pullCredential: PullCredentialDeclaration = (config) => {
  const { username, accessToken } = dockerHubConfigSchema.parse(config);
  return username === undefined || accessToken === undefined
    ? null
    : {
        server: "https://index.docker.io/v1/",
        username,
        password: accessToken,
      };
};

import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { githubOwner, githubPackagesToken } from "../../adapter-base/github.js";
import { createRegistryAdapter } from "../../adapter-base/registry.js";
import type { PullCredentialDeclaration } from "../../adapter-base/registry-pull.js";

/**
 * Adapter GitHub Container Registry (§5.5 Container Registry, Plan #35) — lớp nền
 * `RegistryAdapter`.
 *
 * GitHub Actions đẩy bằng `GITHUB_TOKEN` của chính workflow (Plan #36); cluster kéo package riêng
 * tư bằng token có quyền `read:packages` — bí mật của tool, nền tảng phân phối vào
 * `udp-registry-pull` (QĐ-3). Package công khai kéo không cần khoá.
 */

export const ghcrConfigSchema = z.object({
  /** Người dùng hay tổ chức sở hữu package */
  owner: githubOwner,
  username: githubOwner.optional(),
  /** Token `read:packages` (classic `ghp_…` hay fine-grained `github_pat_…`) */
  token: githubPackagesToken.optional(),
});

const adapter: DomainAdapter = createRegistryAdapter({
  domainType: "CONTAINER_REGISTRY",
  toolId: "ghcr",
  version: "1.0.0",
  capabilities: {
    provides: [{ id: "registry.oci", version: "1.0.0" }],
    requires: [],
  },
  configSchema: ghcrConfigSchema,
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/"],
  describe: (config) => {
    const parsed = ghcrConfigSchema.parse(config);
    return {
      server: "ghcr.io",
      owner: parsed.owner.toLowerCase(),
      pullAuth: parsed.token === undefined ? "anonymous" : "pull-secret",
    };
  },
  bindings: (_ctx, config) => [
    {
      id: "registry.oci",
      version: "1.0.0",
      providedBy: "container_registry:ghcr",
      // Tên image trên GHCR luôn viết thường, kể cả khi tên tổ chức có chữ hoa
      endpoint: `ghcr.io/${ghcrConfigSchema.parse(config).owner.toLowerCase()}`,
    },
  ],
});

export default adapter;

export const pullCredential: PullCredentialDeclaration = (config) => {
  const { owner, username, token } = ghcrConfigSchema.parse(config);
  return token === undefined
    ? null
    : { server: "ghcr.io", username: username ?? owner, password: token };
};

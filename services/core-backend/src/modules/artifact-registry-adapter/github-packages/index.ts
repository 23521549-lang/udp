import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { githubOwner, githubPackagesToken } from "../../adapter-base/github.js";
import { createRegistryAdapter } from "../../adapter-base/registry.js";
import type { PullCredentialDeclaration } from "../../adapter-base/registry-pull.js";

/**
 * Adapter GitHub Packages (§5.5 Artifact & Package Registry, Plan #35) — lớp nền
 * `RegistryAdapter`.
 *
 * Một tài khoản GitHub phục vụ cả package ngôn ngữ (npm, Maven, NuGet, RubyGems) lẫn image
 * (`ghcr.io`), nên adapter cung cấp HAI capability: `packages.store` (QĐ-4, `formats` nói định
 * dạng) và `registry.oci`. Token `read:packages` là bí mật của tool.
 */

export const githubPackagesConfigSchema = z.object({
  owner: githubOwner,
  username: githubOwner.optional(),
  token: githubPackagesToken.optional(),
});

const FORMATS = "npm,maven,nuget,rubygems,container";

const adapter: DomainAdapter = createRegistryAdapter({
  domainType: "ARTIFACT_REGISTRY",
  toolId: "github-packages",
  version: "1.0.0",
  capabilities: {
    provides: [
      { id: "packages.store", version: "1.0.0" },
      { id: "registry.oci", version: "1.0.0" },
    ],
    requires: [],
  },
  configSchema: githubPackagesConfigSchema,
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/"],
  describe: (config) => ({
    owner: githubPackagesConfigSchema.parse(config).owner.toLowerCase(),
    formats: FORMATS,
  }),
  bindings: (_ctx, config) => {
    const owner = githubPackagesConfigSchema.parse(config).owner.toLowerCase();
    return [
      {
        id: "packages.store",
        version: "1.0.0",
        providedBy: "artifact_registry:github-packages",
        endpoint: `https://npm.pkg.github.com/${owner}`,
        attributes: { formats: FORMATS },
      },
      {
        id: "registry.oci",
        version: "1.0.0",
        providedBy: "artifact_registry:github-packages",
        endpoint: `ghcr.io/${owner}`,
      },
    ];
  },
});

export default adapter;

export const pullCredential: PullCredentialDeclaration = (config) => {
  const { owner, username, token } = githubPackagesConfigSchema.parse(config);
  return token === undefined
    ? null
    : { server: "ghcr.io", username: username ?? owner, password: token };
};

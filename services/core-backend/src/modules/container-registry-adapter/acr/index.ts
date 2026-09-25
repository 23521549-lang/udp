import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createRegistryAdapter } from "../../adapter-base/registry.js";
import type { PullCredentialDeclaration } from "../../adapter-base/registry-pull.js";

/**
 * Adapter Azure Container Registry (§5.5 Container Registry, Plan #35) — lớp nền
 * `RegistryAdapter`.
 *
 * AKS gắn ACR (`az aks update --attach-acr`) thì node kéo bằng kubelet identity — không cần khoá
 * (QĐ-1). Cluster ở cloud khác thì cần một token repository-scoped của ACR (chỉ `pull`): cấu hình
 * tuỳ chọn, là bí mật của tool, và nền tảng phân phối nó vào `udp-registry-pull` (QĐ-3).
 */

export const acrConfigSchema = z.object({
  /** Tên registry: 5–50 ký tự chữ thường và số */
  registryName: z.string().regex(/^[a-z0-9]{5,50}$/),
  /** Token ACR chỉ `pull` — bỏ trống khi AKS đã gắn registry */
  tokenName: z
    .string()
    .regex(/^[A-Za-z0-9-]{5,50}$/)
    .optional(),
  tokenPassword: z.string().min(16).describe("secret").optional(),
});

const serverOf = (config: z.infer<typeof acrConfigSchema>): string =>
  `${config.registryName}.azurecr.io`;

const adapter: DomainAdapter = createRegistryAdapter({
  domainType: "CONTAINER_REGISTRY",
  toolId: "acr",
  version: "1.0.0",
  capabilities: {
    provides: [{ id: "registry.oci", version: "1.0.0" }],
    requires: [],
  },
  configSchema: acrConfigSchema,
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/"],
  describe: (config) => {
    const parsed = acrConfigSchema.parse(config);
    return {
      server: serverOf(parsed),
      pullAuth:
        parsed.tokenName === undefined ? "node-identity" : "pull-secret",
    };
  },
  bindings: (_ctx, config) => {
    const parsed = acrConfigSchema.parse(config);
    return [
      {
        id: "registry.oci",
        version: "1.0.0",
        providedBy: "container_registry:acr",
        endpoint: serverOf(parsed),
        attributes: {
          pullAuth:
            parsed.tokenName === undefined ? "node-identity" : "pull-secret",
        },
      },
    ];
  },
});

export default adapter;

/** Khoá kéo khi có token — cặp tên và mật khẩu phải đi cùng nhau */
export const pullCredential: PullCredentialDeclaration = (config) => {
  const parsed = acrConfigSchema.parse(config);
  return parsed.tokenName === undefined || parsed.tokenPassword === undefined
    ? null
    : {
        server: serverOf(parsed),
        username: parsed.tokenName,
        password: parsed.tokenPassword,
      };
};

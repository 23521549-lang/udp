import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createRegistryAdapter } from "../../adapter-base/registry.js";

/**
 * Adapter AWS ECR (§5.5 Container Registry, Plan #35) — lớp nền `RegistryAdapter`.
 *
 * Cluster kéo bằng định danh của node (QĐ-1): token ECR hết hạn sau 12 giờ nên một pull secret
 * tĩnh là sai về bản chất — adapter KHÔNG xuất `pullCredential`. CI đẩy image bằng định danh
 * của chính nó (OIDC của nhà cung cấp CI, Plan #36).
 */

export const ecrConfigSchema = z.object({
  accountId: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/),
  /** Tiền tố repository của project trong registry, ví dụ `acme/web` */
  repositoryPrefix: z
    .string()
    .regex(/^[a-z0-9]+([._/-][a-z0-9]+)*$/)
    .default("udp"),
});

const serverOf = (config: z.infer<typeof ecrConfigSchema>): string =>
  `${config.accountId}.dkr.ecr.${config.region}.amazonaws.com`;

const adapter: DomainAdapter = createRegistryAdapter({
  domainType: "CONTAINER_REGISTRY",
  toolId: "ecr",
  version: "1.0.0",
  capabilities: {
    provides: [{ id: "registry.oci", version: "1.0.0" }],
    requires: [],
  },
  configSchema: ecrConfigSchema,
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/"],
  describe: (config) => {
    const parsed = ecrConfigSchema.parse(config);
    return {
      server: serverOf(parsed),
      repositoryPrefix: parsed.repositoryPrefix,
      pullAuth: "node-identity",
    };
  },
  bindings: (_ctx, config) => {
    const parsed = ecrConfigSchema.parse(config);
    return [
      {
        id: "registry.oci",
        version: "1.0.0",
        providedBy: "container_registry:ecr",
        endpoint: `${serverOf(parsed)}/${parsed.repositoryPrefix}`,
        // [Plan #61 QĐ-6] CI đẩy bằng danh tính build (OIDC) — mật khẩu ECR sống 12 giờ
        attributes: {
          pullAuth: "node-identity",
          pushAuth: "aws-ecr",
          region: parsed.region,
        },
      },
    ];
  },
});

export default adapter;

import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createRegistryAdapter } from "../../adapter-base/registry.js";

/**
 * Adapter GCP Artifact Registry (§5.5 Container Registry, Plan #35) — lớp nền `RegistryAdapter`.
 *
 * Node GKE kéo bằng service account của node (QĐ-1) — không pull secret; khoá JSON dài hạn là
 * đúng thứ GCP khuyên không dùng.
 */

export const gcpArtifactRegistryConfigSchema = z.object({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  /** Vùng (`asia-southeast1`) hay đa vùng (`us`, `europe`, `asia`) */
  location: z.string().regex(/^([a-z]+-[a-z]+\d|us|europe|asia)$/),
  /** Repository kiểu Docker trong Artifact Registry */
  repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
});

const endpointOf = (
  config: z.infer<typeof gcpArtifactRegistryConfigSchema>,
): string =>
  `${config.location}-docker.pkg.dev/${config.projectId}/${config.repository}`;

const adapter: DomainAdapter = createRegistryAdapter({
  domainType: "CONTAINER_REGISTRY",
  toolId: "gcp-artifact-registry",
  version: "1.0.0",
  capabilities: {
    provides: [{ id: "registry.oci", version: "1.0.0" }],
    requires: [],
  },
  configSchema: gcpArtifactRegistryConfigSchema,
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/"],
  describe: (config) => ({
    server: endpointOf(gcpArtifactRegistryConfigSchema.parse(config)),
    pullAuth: "node-identity",
  }),
  bindings: (_ctx, config) => [
    {
      id: "registry.oci",
      version: "1.0.0",
      providedBy: "container_registry:gcp-artifact-registry",
      endpoint: endpointOf(gcpArtifactRegistryConfigSchema.parse(config)),
      // [Plan #61 QĐ-6] CI đẩy bằng Workload Identity Federation, không khoá JSON
      attributes: { pullAuth: "node-identity", pushAuth: "gcp" },
    },
  ],
});

export default adapter;

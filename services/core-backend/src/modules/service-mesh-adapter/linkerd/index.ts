import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { trafficSplitBinding } from "../../adapter-base/traffic-router.js";

/**
 * Adapter Linkerd (§5.5 Service Mesh, Plan #33) — họ Helm, hai release: `linkerd-crds` rồi
 * `linkerd-control-plane`.
 *
 * Control plane đòi chứng chỉ mTLS: trust anchor và issuer. Adapter KHÔNG sinh chúng (QĐ-4): sinh
 * ngẫu nhiên thì mỗi lượt áp một chứng chỉ khác — drift giả vĩnh viễn, và mTLS giữa hai lượt vỡ.
 * Trust anchor và issuer certificate là PEM công khai; issuer key là bí mật của tool (Plan #31),
 * vào `Secret` của release và control plane nhận nó qua `readsSecretValues` (Plan #32).
 * Tạo bằng `step certificate create root.linkerd.cluster.local …` như tài liệu của Linkerd.
 */

const PEM_CERT =
  /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n?$/;
const PEM_KEY =
  /^-----BEGIN (EC )?PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END (EC )?PRIVATE KEY-----\n?$/;

export const linkerdConfigSchema = z.object({
  trustAnchorPem: z.string().regex(PEM_CERT),
  issuerCertPem: z.string().regex(PEM_CERT),
  issuerKeyPem: z.string().regex(PEM_KEY).describe("secret"),
  /** Ba bản sao control plane — cho production */
  highAvailability: z.boolean().default(false),
});

const REPO = "https://helm.linkerd.io/stable";

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SERVICE_MESH",
  toolId: "linkerd",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "mesh.traffic-split", version: "1.0.0" }],
    requires: [],
    recommends: ["metrics.query"],
  },
  configSchema: linkerdConfigSchema,
  chart: { name: "linkerd-crds", version: "1.8.0", repo: REPO },
  releaseName: "udp-linkerd-crds",
  /** Không gateway mặc định — không LoadBalancer nào */
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: () => ({}),
  secretValues: (config) => ({
    identity: {
      issuer: {
        tls: { keyPEM: linkerdConfigSchema.parse(config).issuerKeyPem },
      },
    },
  }),
  companions: [
    {
      releaseName: "udp-linkerd-control-plane",
      chart: { name: "linkerd-control-plane", version: "1.16.11", repo: REPO },
      readsSecretValues: true,
      values: (config) => {
        const parsed = linkerdConfigSchema.parse(config);
        return {
          identityTrustAnchorsPEM: parsed.trustAnchorPem,
          identity: { issuer: { tls: { crtPEM: parsed.issuerCertPem } } },
          controllerReplicas: parsed.highAvailability ? 3 : 1,
        };
      },
    },
  ],

  bindings: () => [
    trafficSplitBinding(
      "mesh.traffic-split",
      "service_mesh:linkerd",
      "linkerd",
    ),
  ],
});

export default adapter;

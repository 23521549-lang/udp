import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { agentClusterName } from "../../adapter-base/agent-cluster.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";

/**
 * Adapter Aqua Security (§5.5 Security Scanning, Plan #37) — họ Helm (`kube-enforcer` của Aqua):
 * admission và kiểm tra runtime nối về Aqua Server/Gateway của khách (SaaS hay tự lưu trữ) —
 * `security.scan`, mode `operator`.
 *
 * Token của KubeEnforcer là bí mật (nó đăng ký cluster vào Aqua): đi vào `Secret` của lớp nền qua
 * `secretValues`, ConfigMap chỉ mang băm. Gateway chỉ nhận `host:port` — không URL tự do.
 */

export const aquaConfigSchema = z.object({
  /** `aqua-gateway.acme.dev:8443` hay gateway SaaS của Aqua */
  gateway: z.string().regex(/^[a-z0-9.-]+:\d{2,5}$/),
  enforcerToken: z.string().min(16).max(256).describe("secret"),
});

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "SECURITY",
  toolId: "aqua",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "security.scan", version: "1.0.0" }],
    requires: [],
  },
  configSchema: aquaConfigSchema,
  chart: {
    name: "kube-enforcer",
    version: "2022.4.46",
    repo: "https://helm.aquasec.com",
  },
  releaseName: "udp-aqua",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const [address, port] = aquaConfigSchema.parse(config).gateway.split(":");
    return {
      clusterName: agentClusterName(ctx),
      global: { gateway: { address, port: Number(port) } },
    };
  },
  secretValues: (config) => ({
    global: { enforcer_token: aquaConfigSchema.parse(config).enforcerToken },
  }),

  bindings: () => [
    {
      id: "security.scan",
      version: "1.0.0",
      providedBy: "security:aqua",
      attributes: {
        provider: "aqua",
        mode: "operator",
        kinds: "admission,image,runtime",
      },
    },
  ],
});

export default adapter;

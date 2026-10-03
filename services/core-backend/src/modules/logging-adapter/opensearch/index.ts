import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { logsSinkBinding } from "../../adapter-base/logs-sink.js";

/**
 * Adapter OpenSearch (§5.5 Logging, Plan #32) — họ Helm, ba release.
 *
 * `opensearch` là release chính; `opensearch-dashboards` và `fluent-bit` (thu log container đẩy
 * vào OpenSearch) đi kèm. Từ OpenSearch 2.12 mật khẩu admin ban đầu là BẮT BUỘC: nó là bí mật
 * của tool (Plan #31) — niêm phong ở UDP, vào `Secret` `udp-opensearch-secrets` khoá phẳng
 * `admin-password` (Plan #32 `secretKeys`), và cả ba release đọc nó qua `secretKeyRef`, không
 * release nào mang giá trị trong ConfigMap.
 */

export const openSearchConfigSchema = z.object({
  /** Mật khẩu admin — luật độ mạnh của chính OpenSearch (≥ 8, hoa, thường, số, ký tự đặc biệt) */
  adminPassword: z
    .string()
    .min(8)
    .max(128)
    .regex(/[A-Z]/)
    .regex(/[a-z]/)
    .regex(/\d/)
    .regex(/[^A-Za-z0-9]/)
    .describe("secret"),
  replicas: z.number().int().min(1).max(3).default(1),
  /** PVC của MỖI node, GiB */
  storageGb: z.number().int().min(1).max(1000).default(30),
});

const REPO = "https://opensearch-project.github.io/helm-charts";
const SECRET = "udp-opensearch-secrets";
const PASSWORD_KEY = "admin-password";
const passwordFromSecret = {
  valueFrom: { secretKeyRef: { name: SECRET, key: PASSWORD_KEY } },
};
const hostOf = (namespace: string): string =>
  `opensearch-cluster-master.${namespace}`;

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "LOGGING",
  toolId: "opensearch",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "logs.sink", version: "1.0.0" }],
    requires: [],
  },
  configSchema: openSearchConfigSchema,
  chart: helmChart("opensearch"),
  releaseName: "udp-opensearch",
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = openSearchConfigSchema.parse(config);
    return {
      replicas: parsed.replicas,
      persistence: { size: `${String(parsed.storageGb)}Gi` },
      extraEnvs: [
        { name: "OPENSEARCH_INITIAL_ADMIN_PASSWORD", ...passwordFromSecret },
      ],
    };
  },
  secretKeys: (config) => ({
    [PASSWORD_KEY]: openSearchConfigSchema.parse(config).adminPassword,
  }),
  companions: [
    {
      releaseName: "udp-opensearch-dashboards",
      chart: helmChart("opensearch-dashboards"),
      values: (_config, ctx) => ({
        opensearchHosts: `https://${hostOf(ctx.systemNamespace)}:9200`,
        extraEnvs: [
          { name: "OPENSEARCH_USERNAME", value: "admin" },
          { name: "OPENSEARCH_PASSWORD", ...passwordFromSecret },
        ],
      }),
    },
    {
      releaseName: "udp-opensearch-fluent-bit",
      chart: helmChart("fluent-bit"),
      values: (_config, ctx) => ({
        env: [{ name: "OPENSEARCH_PASSWORD", ...passwordFromSecret }],
        config: {
          outputs: [
            "[OUTPUT]",
            "    Name               opensearch",
            "    Match              kube.*",
            `    Host               ${hostOf(ctx.systemNamespace)}`,
            "    Port               9200",
            "    tls                On",
            "    HTTP_User          admin",
            "    HTTP_Passwd        ${OPENSEARCH_PASSWORD}",
            "    Suppress_Type_Name On",
            "    Logstash_Format    On",
          ].join("\n"),
        },
      }),
    },
  ],

  bindings: (ctx) => [
    logsSinkBinding("logging:opensearch", {
      protocol: "opensearch",
      endpoint: `https://${hostOf(ctx.systemNamespace)}:9200`,
      credential: {
        secretName: SECRET,
        secretKey: PASSWORD_KEY,
        username: "admin",
      },
    }),
  ],
});

export default adapter;

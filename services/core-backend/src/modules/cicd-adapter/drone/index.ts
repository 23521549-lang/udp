import { z } from "zod";
import type {
  CicdDomainAdapter,
  PipelineStep,
  PipelineTemplateParams,
} from "@udp/adapter-core";
import {
  createCicdAdapter,
  registryRefOf,
  verifyHmacHeader,
} from "../../adapter-base/cicd.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import {
  publicEnvOf,
  stepId,
  stepsOf,
} from "../../adapter-base/pipeline-steps.js";
import {
  environmentOfBranch,
  fillTemplate,
  notifyScript,
  templateValues,
} from "../../adapter-base/pipeline-template.js";

/**
 * Adapter Drone CI (§5.5 CI/CD, Plan #36) — họ Helm, hai release: `drone` (server) rồi
 * `drone-runner-kube` (chạy pipeline thành pod trong cluster).
 *
 * Server đăng nhập qua OAuth của nhà cung cấp Git; client secret và RPC secret (server ⇄ runner) là
 * bí mật của tool, vào `Secret` của release dạng khoá phẳng — cả hai release nạp nó bằng `envFrom`.
 * Registry vào mọi pipeline qua `DRONE_RUNNER_ENVIRON` của runner. Bước báo UDP ký bằng
 * `X-UDP-Signature: sha256=…` (QĐ-6). SQLite của server trên PVC ⇒ `maxStorageGb`.
 */

export const droneConfigSchema = z.object({
  /** Tên miền công khai của server Drone (không scheme) — callback OAuth trỏ về đây */
  serverHost: z.string().regex(/^[a-z0-9.-]+(:\d{2,5})?$/),
  gitProvider: z.enum(["github", "gitlab", "gitea"]),
  clientId: z.string().min(8).max(128),
  clientSecret: z.string().min(16).describe("secret"),
  /** Bí mật dùng chung server ⇄ runner */
  rpcSecret: z.string().min(32).describe("secret"),
  storageGb: z.number().int().min(1).max(100).default(8),
});

const REPO = "https://charts.drone.io";
const SECRET = "udp-drone-secrets";

const base = createHelmBasedAdapter({
  domainType: "CICD",
  toolId: "drone",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "pipeline.trigger", version: "1.0.0" }],
    requires: [{ id: "registry.oci" }],
    hint: {
      "registry.oci":
        "CI cần nơi đẩy image: bật một tool ở domain Container Registry",
    },
  },
  configSchema: droneConfigSchema,
  chart: { name: "drone", version: "0.6.5", repo: REPO },
  releaseName: "udp-drone",
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config) => {
    const parsed = droneConfigSchema.parse(config);
    const provider = parsed.gitProvider.toUpperCase();
    return {
      env: {
        DRONE_SERVER_HOST: parsed.serverHost,
        DRONE_SERVER_PROTO: "https",
        [`DRONE_${provider}_CLIENT_ID`]: parsed.clientId,
      },
      extraSecretNamesForEnvFrom: [SECRET],
      persistentVolume: { size: `${String(parsed.storageGb)}Gi` },
    };
  },
  secretKeys: (config) => {
    const parsed = droneConfigSchema.parse(config);
    return {
      [`DRONE_${parsed.gitProvider.toUpperCase()}_CLIENT_SECRET`]:
        parsed.clientSecret,
      DRONE_RPC_SECRET: parsed.rpcSecret,
    };
  },
  companions: [
    {
      releaseName: "udp-drone-runner",
      chart: { name: "drone-runner-kube", version: "0.1.10", repo: REPO },
      values: (_config, ctx) => ({
        env: {
          DRONE_RPC_HOST: `udp-drone.${ctx.systemNamespace}`,
          DRONE_RPC_PROTO: "http",
          DRONE_RUNNER_ENVIRON: `UDP_REGISTRY:${registryRefOf(ctx.resolved)}`,
        },
        extraSecretNamesForEnvFrom: [SECRET],
      }),
    },
  ],

  bindings: () => [
    {
      id: "pipeline.trigger",
      version: "1.0.0",
      providedBy: "cicd:drone",
      attributes: { provider: "drone" },
    },
  ],
});

const notifyStep = (status: "success" | "failure"): string[] => [
  `  - name: notify-udp-${status}`,
  "    image: alpine:3.20",
  "    environment:",
  "      UDP_WEBHOOK_URL: { from_secret: udp_webhook_url }",
  "      UDP_WEBHOOK_SECRET: { from_secret: udp_webhook_secret }",
  "    commands:",
  "      - apk add --no-cache jq curl openssl",
  `      - export UDP_STATUS=${status}`,
  "      - export COMMIT_SHA=$DRONE_COMMIT_SHA COMMIT_TS= PIPELINE_ID=$DRONE_BUILD_NUMBER",
  "      - export REPO=$DRONE_REPO REF=$DRONE_BRANCH ACTOR=$DRONE_COMMIT_AUTHOR",
  status === "success"
    ? '      - export IMAGE_REF="%IMAGE%:$DRONE_COMMIT_SHA"'
    : '      - export IMAGE_REF=""',
  "      - |",
  `        ${environmentOfBranch("$DRONE_BRANCH")}`,
  ...notifyScript('-H "X-UDP-Signature: sha256=$SIG"').map(
    (line) => `        ${line}`,
  ),
  "    when:",
  `      status: [${status}]`,
];

/**
 * Bước của domain khác là một step trong image của nó (Drone thay entrypoint bằng `commands`).
 * Bí mật lấy từ secret của repo cùng tên viết thường; environment và ảnh tính ngay trong step.
 */
const stepSteps = (steps: readonly PipelineStep[]): string[] =>
  steps.flatMap((step) => [
    `  - name: ${stepId(step)}`,
    `    image: ${step.image}`,
    ...(step.secretEnv.length + Object.keys(step.env).length === 0
      ? []
      : [
          "    environment:",
          ...publicEnvOf(step).map(([k, v]) => `      ${k}: "${v}"`),
          ...step.secretEnv.map(
            (name) => `      ${name}: { from_secret: ${name.toLowerCase()} }`,
          ),
        ]),
    "    commands:",
    "      - |",
    `        export ${environmentOfBranch("$DRONE_BRANCH")}`,
    '        export IMAGE_REF="%IMAGE%:$DRONE_COMMIT_SHA"',
    ...step.commands.map((c) => `        ${c}`),
  ]);

const pipeline = (params: PipelineTemplateParams): string[] => [
  "# .drone.yml — sinh bởi UDP (Golden Path, §11)",
  "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
  "kind: pipeline",
  "type: kubernetes",
  "name: udp",
  "trigger:",
  "  branch: [%BRANCHES%]",
  "environment:",
  '  UDP_TRACKED_FLAGS: "%FLAGS%"',
  "steps:",
  "  - name: test",
  "    image: node:20-alpine",
  "    commands: [npm ci, npm test]",
  ...stepSteps(stepsOf(params, "before-build")),
  "  - name: build-and-push",
  "    image: plugins/kaniko",
  "    settings:",
  "      repo: %IMAGE%",
  "      tags: [${DRONE_COMMIT_SHA}]",
  ...stepSteps(stepsOf(params, "after-build")),
  ...notifyStep("success"),
  ...notifyStep("failure"),
];

const adapter: CicdDomainAdapter = createCicdAdapter({
  base,
  verifySignature: (headers, rawBody, secret) =>
    verifyHmacHeader(headers, rawBody, secret, "X-UDP-Signature", "sha256="),
  renderPipelineTemplate: (params) =>
    fillTemplate(pipeline(params), templateValues(params)),
});

export default adapter;

import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import {
  rebaseScheduleOf,
  type CicdDomainAdapter,
  type PipelineStep,
  type PipelineTemplateParams,
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
  rebaseNotifyVars,
  templateValues,
} from "../../adapter-base/pipeline-template.js";
import {
  AUTH_DIR,
  BUILDER_SERVICE_ACCOUNT,
  BUILD_NAMESPACE,
  inClusterBuildContainers,
  notifyTokenLines,
  WORK_DIR,
  type BuildContainer,
} from "../../adapter-base/packaging/build-script.js";
import { buildNamespaceCompanion } from "../../adapter-base/packaging/build-namespace.js";
import { inClusterRebaseContainers } from "../../adapter-base/packaging/rebase-script.js";
import {
  inClusterSignContainers,
  SIGNATURE_FILE,
} from "../../adapter-base/packaging/sign-script.js";
import { BUILD_TOOLCHAIN } from "@udp/config";

/** Hai volume tạm của pod: thư mục làm việc của build và thông tin đăng nhập registry */
const VOLUME_MOUNTS = [
  "    volumes:",
  `      - { name: udp, path: ${WORK_DIR} }`,
  `      - { name: udp-auth, path: ${AUTH_DIR} }`,
];

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
  chart: helmChart("drone"),
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
    buildNamespaceCompanion,
    {
      releaseName: "udp-drone-runner",
      chart: helmChart("drone-runner-kube"),
      values: (_config, ctx) => ({
        env: {
          DRONE_RPC_HOST: `udp-drone.${ctx.systemNamespace}`,
          DRONE_RPC_PROTO: "http",
          DRONE_RUNNER_ENVIRON: `UDP_REGISTRY:${registryRefOf(ctx.resolved)}`,
          // [Plan #61 QĐ-12] Pod pipeline ở `udp-build` (bản trước: `default`)
          DRONE_NAMESPACE_DEFAULT: BUILD_NAMESPACE,
        },
        rbac: { buildNamespaces: [BUILD_NAMESPACE] },
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

const notifyStep = (
  status: "success" | "failure",
  signed: boolean,
  webhookUrl: string,
): string[] => [
  `  - name: notify-udp-${status}`,
  `    image: ${BUILD_TOOLCHAIN.images.alpine}`,
  ...VOLUME_MOUNTS,
  "    environment:",
  "      UDP_WEBHOOK_URL: { from_secret: udp_webhook_url }",
  "      UDP_WEBHOOK_SECRET: { from_secret: udp_webhook_secret }",
  "    commands:",
  "      - apk add --no-cache jq curl openssl",
  `      - export UDP_STATUS=${status}`,
  "      - export COMMIT_SHA=$DRONE_COMMIT_SHA COMMIT_TS= PIPELINE_ID=$DRONE_BUILD_NUMBER",
  "      - export REPO=$DRONE_REPO REF=$DRONE_BRANCH ACTOR=$DRONE_COMMIT_AUTHOR",
  status === "success"
    ? `      - export IMAGE_REF="$(cat ${WORK_DIR}/out/image-ref)"`
    : '      - export IMAGE_REF=""',
  // [Plan #61 QĐ-16] Chữ ký do bước ký để lại trên volume chung: cổng deploy của UDP kiểm
  ...(status === "success" && signed
    ? [`      - export UDP_SIGNATURE_B64="$(cat ${SIGNATURE_FILE})"`]
    : []),
  "      - |",
  `        ${environmentOfBranch("$DRONE_BRANCH")}`,
  ...notifyScript(
    '-H "X-UDP-Signature: sha256=$SIG"',
    notifyTokenLines(webhookUrl),
  ).map((line) => `        ${line}`),
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
    ...VOLUME_MOUNTS,
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
    // [Plan #61 QĐ-7] Ảnh CÓ digest do bước build ghi; trước build thì chưa có
    `        export IMAGE_REF="$(cat ${WORK_DIR}/out/image-ref 2>/dev/null || echo %IMAGE%:$DRONE_COMMIT_SHA)"`,
    ...step.commands.map((c) => `        ${c}`),
  ]);

/**
 * [Plan #61 QĐ-12] Bước build — từ `BuildContainer` chung. Drone không đặt seccomp cho từng bước, nên BuildKit (không
 * root) chạy `privileged`: repo phải được đánh dấu Trusted trong Drone (§16). Builder Buildpacks không cần quyền gì.
 */
const buildSteps = (containers: readonly BuildContainer[]): string[] =>
  containers.flatMap((c) => [
    `  - name: ${c.name}`,
    `    image: ${c.image}`,
    ...(c.unconfined ? ["    privileged: true"] : []),
    ...VOLUME_MOUNTS,
    ...(Object.keys(c.env).length + c.secretEnv.length === 0
      ? []
      : [
          "    environment:",
          ...Object.entries(c.env)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `      ${k}: '${v}'`),
          ...c.secretEnv.map(
            (name) => `      ${name}: { from_secret: ${name.toLowerCase()} }`,
          ),
        ]),
    "    commands:",
    "      - |",
    ...c.script.map((line) => `        ${line}`),
  ]);

/**
 * Runner của Drone thay MỌI `${…}` trong tệp bằng biến của lượt chạy TRƯỚC khi đọc YAML — biến lạ thành chuỗi rỗng
 * (`envsubst` của runner-go). Script của UDP dùng `${…}` của shell (`${UDP_KIND:-}`…) ⇒ thoát thành `$${…}` như tài liệu
 * của Drone; `$VAR` không ngoặc không bị đụng.
 */
const escapeSubstitution = (text: string): string =>
  // Hàm thay thế: trong chuỗi thay thế của `replaceAll`, `$$` lại có nghĩa là một `$`
  text.replaceAll("${", () => "$${");

/** Tên cron Drone kích lượt rebase — người dùng tạo bằng `drone cron add … udp-rebase` (Portal chỉ lệnh) */
const REBASE_CRON = "udp-rebase";

/**
 * [Plan #61 QĐ-13] Pipeline thứ hai của tệp: chỉ chạy ở sự kiện `cron` tên `udp-rebase` (nhánh `main`). Rebase image
 * Buildpacks của commit đầu `main`; bước báo chỉ gửi khi đã ra image mới (`/udp/out/image-ref`).
 */
const rebasePipeline = (params: PipelineTemplateParams): string[] => [
  "---",
  "kind: pipeline",
  "type: kubernetes",
  `name: ${REBASE_CRON}`,
  `service_account_name: ${BUILDER_SERVICE_ACCOUNT}`,
  "trigger:",
  "  event: [cron]",
  `  cron: [${REBASE_CRON}]`,
  "  branch: [main]",
  "volumes:",
  "  - name: udp",
  "    temp: {}",
  "  - name: udp-auth",
  "    temp: {}",
  "steps:",
  ...buildSteps([
    ...inClusterRebaseContainers(params.build, "drone", {
      image: "%IMAGE%",
      commit: "$DRONE_COMMIT_SHA",
    }),
    // Digest mới cũng phải được ký — image chưa ký không qua cổng deploy
    ...inClusterSignContainers(params.build, signVars),
  ]),
  "  - name: notify-udp-rebase",
  `    image: ${BUILD_TOOLCHAIN.images.alpine}`,
  ...VOLUME_MOUNTS,
  "    environment:",
  "      UDP_WEBHOOK_URL: { from_secret: udp_webhook_url }",
  "      UDP_WEBHOOK_SECRET: { from_secret: udp_webhook_secret }",
  "    commands:",
  "      - |",
  ...[
    `[ -f ${WORK_DIR}/out/image-ref ] || { echo "Khong co image moi: khong bao UDP"; exit 0; }`,
    "apk add --no-cache jq curl openssl",
    "COMMIT_SHA=$DRONE_COMMIT_SHA PIPELINE_ID=$DRONE_BUILD_NUMBER REPO=$DRONE_REPO ACTOR=drone-cron",
    ...rebaseNotifyVars("$DRONE_BRANCH", `"$(cat ${WORK_DIR}/out/image-ref)"`),
    ...(params.build.signing === null
      ? []
      : [`UDP_SIGNATURE_B64=$(cat ${SIGNATURE_FILE})`]),
    ...notifyScript(
      '-H "X-UDP-Signature: sha256=$SIG"',
      notifyTokenLines(params.webhookUrl),
    ),
  ].map((line) => `        ${line}`),
];

/** [Plan #61 QĐ-14] Biến của bước ký — lượt build và lượt rebase (nhánh `main`) như nhau */
const signVars = {
  image: "%IMAGE%",
  project: "%PROJECT%",
  commit: "$DRONE_COMMIT_SHA",
  ref: "$DRONE_BRANCH",
  run: "$DRONE_BUILD_NUMBER",
};

const pipeline = (params: PipelineTemplateParams): string[] => {
  const schedule = rebaseScheduleOf(params.build, params.projectSlug);
  const sign = inClusterSignContainers(params.build, signVars);
  return [
    "# .drone.yml — sinh bởi UDP (Golden Path, §11)",
    "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
    ...(schedule === null
      ? []
      : [
          `# [Plan #61 QĐ-13] Vá image nền: drone cron add <owner/repo> ${REBASE_CRON} "0 ${schedule.cron}" --branch main (UTC)`,
        ]),
    "kind: pipeline",
    "type: kubernetes",
    "name: udp",
    `service_account_name: ${BUILDER_SERVICE_ACCOUNT}`,
    "trigger:",
    "  branch: [%BRANCHES%]",
    ...(schedule === null ? [] : ["  event:", "    exclude: [cron]"]),
    "environment:",
    '  UDP_TRACKED_FLAGS: "%FLAGS%"',
    "volumes:",
    "  - name: udp",
    "    temp: {}",
    "  - name: udp-auth",
    "    temp: {}",
    "steps:",
    "  - name: test",
    "    image: %TEST_IMAGE%",
    '    commands: ["%TEST%"]',
    ...stepSteps(stepsOf(params, "before-build")),
    ...buildSteps(
      inClusterBuildContainers(params.build, "drone", {
        image: "%IMAGE%",
        commit: "$DRONE_COMMIT_SHA",
      }),
    ),
    ...stepSteps(stepsOf(params, "after-build")),
    // Ký sau bước sau build: chỉ image đã qua quét mới được ký
    ...buildSteps(sign),
    ...notifyStep("success", sign.length > 0, params.webhookUrl),
    ...notifyStep("failure", sign.length > 0, params.webhookUrl),
    ...(schedule === null ? [] : rebasePipeline(params)),
  ];
};

const adapter: CicdDomainAdapter = createCicdAdapter({
  base,
  verifySignature: (headers, rawBody, secret) =>
    verifyHmacHeader(headers, rawBody, secret, "X-UDP-Signature", "sha256="),
  renderPipelineTemplate: (params) =>
    escapeSubstitution(fillTemplate(pipeline(params), templateValues(params))),
});

export default adapter;

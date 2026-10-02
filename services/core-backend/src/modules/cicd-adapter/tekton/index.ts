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
  rebaseTimeOf,
  templateValues,
} from "../../adapter-base/pipeline-template.js";
import {
  AUTH_DIR,
  BUILDER_SERVICE_ACCOUNT,
  BUILD_NAMESPACE,
  inClusterBuildContainers,
  inClusterLoginContainers,
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

/** Ảnh có digest trong workspace (tương đối với thư mục làm việc = workspace) — sau khi build xong mới có */
const IMAGE_REF_DIR = ".udp-out";
const IMAGE_REF_FILE = `${IMAGE_REF_DIR}/image-ref`;
/** [Plan #61 QĐ-13] Commit đầu `main` mà task lấy mã của lượt rebase ghi cho task sau */
const COMMIT_FILE = `${IMAGE_REF_DIR}/commit`;
/** [Plan #61 QĐ-16] Chữ ký mà task `sign` để lại trong workspace cho task báo UDP */
const SIGNATURE_WS_FILE = `${IMAGE_REF_DIR}/signature.b64`;

/**
 * Adapter Tekton (§5.5 CI/CD, Plan #36) — họ Helm (chart `tekton-pipeline`) + lớp bọc CI/CD.
 *
 * Pipeline chạy NGAY trong cluster của project, ở namespace `udp-build` ([Plan #61] BuildKit không root hay
 * Buildpacks, không cần Docker daemon — kaniko đã bị lưu trữ, và Task `kaniko` mà bản trước gọi không được cài). Tekton
 * không có webhook RA gốc: task `finally` của Pipeline mà UDP sinh ký thân bằng HMAC-SHA256 trong
 * `X-UDP-Signature: sha256=…` (QĐ-6). Registry đọc từ binding `registry.oci` — ghi thành
 * chú thích trên controller (người vận hành thấy pipeline đẩy đi đâu) và vào tham số `image` của
 * Pipeline.
 */

export const tektonConfigSchema = z.object({
  /** Bản sao controller của Tekton Pipelines */
  replicas: z.number().int().min(1).max(3).default(1),
});

const base = createHelmBasedAdapter({
  domainType: "CICD",
  toolId: "tekton",
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
  configSchema: tektonConfigSchema,
  chart: {
    name: "tekton-pipeline",
    version: "1.1.4",
    repo: "https://cdfoundation.github.io/tekton-helm-chart",
  },
  releaseName: "udp-tekton",
  companions: [buildNamespaceCompanion],
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => ({
    controller: {
      replicas: tektonConfigSchema.parse(config).replicas,
      podAnnotations: { "udp.dev/registry-ref": registryRefOf(ctx.resolved) },
    },
  }),

  bindings: () => [
    {
      id: "pipeline.trigger",
      version: "1.0.0",
      providedBy: "cicd:tekton",
      attributes: { provider: "tekton" },
    },
  ],
});

/** Secret Kubernetes mà bước đọc biến bí mật — khoá trùng TÊN biến */
const CI_SECRETS = "udp-ci-secrets";

/**
 * Bước của domain khác là một task nhúng: chạy trong image của nó, trên workspace mã nguồn. Bí mật
 * lấy từ Secret `udp-ci-secrets` theo TÊN; environment và ảnh tính từ tham số của PipelineRun.
 */
const stepTasks = (
  steps: readonly PipelineStep[],
  runAfter: readonly string[],
): string[] =>
  steps.flatMap((step) => [
    `    - name: ${stepId(step)}`,
    ...(runAfter.length === 0
      ? []
      : [`      runAfter: [${runAfter.join(", ")}]`]),
    "      workspaces:",
    "        - name: source",
    "          workspace: source",
    "      taskSpec:",
    "        workspaces: [{ name: source }]",
    "        steps:",
    "          - name: run",
    `            image: ${step.image}`,
    "            workingDir: $(workspaces.source.path)",
    ...(step.secretEnv.length + Object.keys(step.env).length === 0
      ? []
      : [
          "            env:",
          ...publicEnvOf(step).flatMap(([k, v]) => [
            `              - name: ${k}`,
            `                value: "${v}"`,
          ]),
          ...step.secretEnv.flatMap((name) => [
            `              - name: ${name}`,
            `                valueFrom: { secretKeyRef: { name: ${CI_SECRETS}, key: ${name} } }`,
          ]),
        ]),
    "            script: |",
    "              #!/bin/sh",
    "              set -e",
    `              export ${environmentOfBranch("$(params.branch)")}`,
    // [Plan #61 QĐ-7] Ảnh CÓ digest do task build ghi vào workspace; trước build thì chưa có
    `              export IMAGE_REF="$(cat ${IMAGE_REF_FILE} 2>/dev/null || echo $(params.image):$(params.revision))"`,
    ...step.commands.map((c) => `              ${c}`),
  ]);

/** [Plan #48 QĐ-4] Test trong image của runtime, trên workspace mã nguồn — trước build và mọi bước khác */
const TEST_TASK = [
  "    - name: test",
  "      runAfter: [fetch-source]",
  "      workspaces:",
  "        - name: source",
  "          workspace: source",
  "      taskSpec:",
  "        workspaces: [{ name: source }]",
  "        steps:",
  "          - name: run",
  "            image: %TEST_IMAGE%",
  "            workingDir: $(workspaces.source.path)",
  "            script: |",
  "              #!/bin/sh",
  "              set -e",
  "              %TEST%",
];

/**
 * [Plan #61 QĐ-12] Lấy mã nguồn — Pipeline cũ không có bước này nên workspace rỗng. Commit cụ thể lấy bằng `fetch`
 * nông theo SHA; repo riêng đọc `.git-credentials` từ Secret `udp-git` (tuỳ chọn) của namespace `udp-build`.
 */
const fetchTask = (
  name: string,
  revision: string,
  after: readonly string[] = [],
): string[] => [
  `    - name: ${name}`,
  "      workspaces:",
  "        - name: source",
  "          workspace: source",
  "      taskSpec:",
  "        workspaces: [{ name: source }]",
  "        volumes:",
  "          - name: udp-git",
  "            secret: { secretName: udp-git, optional: true }",
  "        steps:",
  "          - name: clone",
  `            image: ${BUILD_TOOLCHAIN.images.git}`,
  "            workingDir: $(workspaces.source.path)",
  "            volumeMounts: [{ name: udp-git, mountPath: /udp-git }]",
  "            script: |",
  "              #!/bin/sh",
  "              set -eu",
  '              [ -f /udp-git/.git-credentials ] && git config --global credential.helper "store --file=/udp-git/.git-credentials"',
  "              git init -q .",
  '              git remote add origin "$(params.repo-url)"',
  `              git fetch -q --depth 1 origin "${revision}"`,
  "              git checkout -q FETCH_HEAD",
  ...after.map((line) => `              ${line}`),
];

const FETCH_TASK = fetchTask("fetch-source", "$(params.revision)");

/** Một bước của task build — từ `BuildContainer` chung (build-script.ts) */
const buildSteps = (containers: readonly BuildContainer[]): string[] =>
  containers.flatMap((c) => [
    `          - name: ${c.name}`,
    `            image: ${c.image}`,
    "            workingDir: $(workspaces.source.path)",
    ...(c.runAsUser === null && !c.unconfined
      ? []
      : [
          "            securityContext:",
          ...(c.runAsUser === null
            ? []
            : [`              runAsUser: ${String(c.runAsUser)}`]),
          ...(c.unconfined
            ? [
                "              seccompProfile: { type: Unconfined }",
                "              appArmorProfile: { type: Unconfined }",
              ]
            : []),
        ]),
    ...(Object.keys(c.env).length + c.secretEnv.length === 0
      ? []
      : [
          "            env:",
          ...Object.entries(c.env)
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([k, v]) => [
              `              - name: ${k}`,
              `                value: '${v}'`,
            ]),
          ...c.secretEnv.flatMap((name) => [
            `              - name: ${name}`,
            `                valueFrom: { secretKeyRef: { name: ${CI_SECRETS}, key: ${name} } }`,
          ]),
        ]),
    "            volumeMounts:",
    `              - { name: udp, mountPath: ${WORK_DIR} }`,
    `              - { name: udp-auth, mountPath: ${AUTH_DIR} }`,
    "            script: |",
    "              #!/bin/sh",
    ...c.script.map((line) => `              ${line}`),
    // Bước cuối: ảnh có digest sang workspace cho task sau build và task báo UDP
    ...(c.name === "udp-digest"
      ? [
          `              mkdir -p ${IMAGE_REF_DIR} && cp ${WORK_DIR}/out/image-ref ${IMAGE_REF_FILE}`,
        ]
      : []),
    // Chữ ký sang workspace cho task báo UDP (ở `finally`, không thấy volume của task ký)
    ...(c.name === "udp-sign"
      ? [`              cp ${SIGNATURE_FILE} ${SIGNATURE_WS_FILE}`]
      : []),
  ]);

/**
 * [Plan #61 QĐ-14] Task `sign`: sau build và mọi task sau build (chỉ image đã qua quét mới được ký), trước task báo UDP.
 * Task riêng nên đăng nhập registry lại (cosign và oras đẩy chữ ký vào registry) và lấy ảnh có digest từ workspace.
 */
const signTask = (
  params: PipelineTemplateParams,
  after: readonly PipelineStep[],
): string[] => {
  const sign = inClusterSignContainers(params.build, {
    image: "$(params.image)",
    project: "%PROJECT%",
    commit: "$(params.revision)",
    ref: "$(params.branch)",
    run: "$(context.pipelineRun.name)",
  });
  if (sign.length === 0) return [];
  const imageRef: BuildContainer = {
    name: "udp-image-ref",
    image: BUILD_TOOLCHAIN.images.alpine,
    runAsUser: null,
    unconfined: false,
    env: {},
    secretEnv: [],
    script: [
      "set -eu",
      `mkdir -p ${WORK_DIR}/out && cp ${IMAGE_REF_FILE} ${WORK_DIR}/out/image-ref`,
    ],
  };
  return [
    "    - name: sign",
    `      runAfter: [${["build", ...after.map(stepId)].join(", ")}]`,
    "      workspaces:",
    "        - name: source",
    "          workspace: source",
    "      taskSpec:",
    "        workspaces: [{ name: source }]",
    "        volumes:",
    "          - name: udp",
    "            emptyDir: {}",
    "          - name: udp-auth",
    "            emptyDir: {}",
    "        steps:",
    ...buildSteps([
      imageRef,
      ...inClusterLoginContainers(params.build, "tekton"),
      ...sign,
    ]),
  ];
};

/**
 * [Plan #61 QĐ-13] Pipeline thứ hai của tệp: lấy đầu nhánh `main`, rebase image Buildpacks của commit đó, báo UDP
 * (`kind: rebase`) khi đã ra image mới. Lượt rebase hỏng ⇒ PipelineRun hỏng, không báo.
 */
const rebasePipeline = (params: PipelineTemplateParams): string[] => [
  "---",
  "apiVersion: tekton.dev/v1",
  "kind: Pipeline",
  "metadata:",
  "  name: udp-%PROJECT%-rebase",
  `  namespace: ${BUILD_NAMESPACE}`,
  "spec:",
  "  params:",
  "    - name: repo-url",
  "    - name: image",
  "      default: %IMAGE%",
  "  workspaces:",
  "    - name: source",
  "  tasks:",
  ...fetchTask("fetch-main", "main", [
    `mkdir -p ${IMAGE_REF_DIR} && git rev-parse HEAD > ${COMMIT_FILE}`,
  ]),
  "    - name: rebase",
  "      runAfter: [fetch-main]",
  "      workspaces:",
  "        - name: source",
  "          workspace: source",
  "      taskSpec:",
  "        workspaces: [{ name: source }]",
  "        volumes:",
  "          - name: udp",
  "            emptyDir: {}",
  "          - name: udp-auth",
  "            emptyDir: {}",
  "        steps:",
  ...buildSteps([
    ...inClusterRebaseContainers(params.build, "tekton", {
      image: "$(params.image)",
      commit: `$(cat $(workspaces.source.path)/${COMMIT_FILE})`,
    }),
    // Digest mới cũng phải được ký — image chưa ký không qua cổng deploy
    ...inClusterSignContainers(params.build, {
      image: "$(params.image)",
      project: "%PROJECT%",
      commit: `$(cat $(workspaces.source.path)/${COMMIT_FILE})`,
      ref: "main",
      run: "$(context.pipelineRun.name)",
    }),
  ]),
  "          - name: notify",
  `            image: ${BUILD_TOOLCHAIN.images.alpine}`,
  "            workingDir: $(workspaces.source.path)",
  "            env:",
  "              - name: UDP_WEBHOOK_URL",
  "                valueFrom: { secretKeyRef: { name: udp-webhook, key: url } }",
  "              - name: UDP_WEBHOOK_SECRET",
  "                valueFrom: { secretKeyRef: { name: udp-webhook, key: secret } }",
  "            volumeMounts:",
  `              - { name: udp, mountPath: ${WORK_DIR} }`,
  "            script: |",
  "              #!/bin/sh",
  "              set -eu",
  ...[
    `[ -f ${WORK_DIR}/out/image-ref ] || { echo "Khong co image moi: khong bao UDP"; exit 0; }`,
    "apk add --no-cache jq curl openssl",
    `COMMIT_SHA=$(cat ${COMMIT_FILE}) PIPELINE_ID=$(context.pipelineRun.name) REPO=%PROJECT% ACTOR=tekton`,
    ...rebaseNotifyVars("main", `"$(cat ${WORK_DIR}/out/image-ref)"`),
    ...(params.build.signing === null
      ? []
      : [`UDP_SIGNATURE_B64=$(cat ${SIGNATURE_FILE})`]),
    ...notifyScript('-H "X-UDP-Signature: sha256=$SIG"'),
  ].map((line) => `              ${line}`),
];

const pipeline = (params: PipelineTemplateParams): string[] => {
  const schedule = rebaseScheduleOf(params.build, params.projectSlug);
  const before = stepsOf(params, "before-build");
  const after = stepsOf(params, "after-build");
  const containers = inClusterBuildContainers(params.build, "tekton", {
    image: "$(params.image)",
    commit: "$(params.revision)",
  });
  return [
    "# tekton/udp-pipeline.yaml — sinh bởi UDP (Golden Path, §11)",
    "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
    `# Chạy một lượt ở namespace ${BUILD_NAMESPACE} bằng ServiceAccount ${BUILDER_SERVICE_ACCOUNT} (Tekton Triggers chưa có, §16):`,
    `#   tkn pipeline start udp-%PROJECT% -n ${BUILD_NAMESPACE} --serviceaccount ${BUILDER_SERVICE_ACCOUNT} -p repo-url=<url> -p revision=<commit> -p branch=<nhánh> -w name=source,volumeClaimTemplateFile=<pvc.yaml>`,
    `# Secret cần có ở ${BUILD_NAMESPACE}: udp-webhook (url, secret); ${CI_SECRETS} cho biến bí mật; udp-git (tuỳ chọn) cho repo riêng`,
    ...(schedule === null
      ? []
      : [
          `# [Plan #61 QĐ-13] Vá image nền mỗi ngày ${rebaseTimeOf(schedule)} UTC bằng hệ lập lịch của bạn (Tekton Triggers chưa có, §16):`,
          `#   tkn pipeline start udp-%PROJECT%-rebase -n ${BUILD_NAMESPACE} --serviceaccount ${BUILDER_SERVICE_ACCOUNT} -p repo-url=<url> -w name=source,volumeClaimTemplateFile=<pvc.yaml>`,
        ]),
    "apiVersion: tekton.dev/v1",
    "kind: Pipeline",
    "metadata:",
    "  name: udp-%PROJECT%",
    `  namespace: ${BUILD_NAMESPACE}`,
    "spec:",
    "  params:",
    "    - name: repo-url",
    "    - name: revision",
    "    - name: branch",
    "    - name: image",
    "      default: %IMAGE%",
    "    - name: environment",
    '      description: "nhánh main ⇒ %PROD%, nhánh khác ⇒ cùng tên"',
    "  workspaces:",
    "    - name: source",
    "  tasks:",
    ...FETCH_TASK,
    ...TEST_TASK,
    ...stepTasks(before, ["test"]),
    "    - name: build",
    `      runAfter: [${["test", ...before.map(stepId)].join(", ")}]`,
    "      workspaces:",
    "        - name: source",
    "          workspace: source",
    "      taskSpec:",
    "        workspaces: [{ name: source }]",
    "        volumes:",
    "          - name: udp",
    "            emptyDir: {}",
    "          - name: udp-auth",
    "            emptyDir: {}",
    "        steps:",
    ...buildSteps(containers),
    ...stepTasks(after, ["build"]),
    ...signTask(params, after),
    "  finally:",
    "    - name: notify-udp",
    // Trạng thái GỘP của mọi task — bước của domain khác hỏng cũng là pipeline hỏng
    "      params:",
    "        - name: status",
    "          value: $(tasks.status)",
    "      workspaces:",
    "        - name: source",
    "          workspace: source",
    "      taskSpec:",
    "        params: [{ name: status }]",
    "        workspaces: [{ name: source }]",
    "        steps:",
    "          - name: notify",
    `            image: ${BUILD_TOOLCHAIN.images.alpine}`,
    "            workingDir: $(workspaces.source.path)",
    "            env:",
    "              - name: UDP_WEBHOOK_URL",
    "                valueFrom: { secretKeyRef: { name: udp-webhook, key: url } }",
    "              - name: UDP_WEBHOOK_SECRET",
    "                valueFrom: { secretKeyRef: { name: udp-webhook, key: secret } }",
    "              - name: UDP_TRACKED_FLAGS",
    '                value: "%FLAGS%"',
    "            script: |",
    "              apk add --no-cache jq curl openssl",
    '              UDP_STATUS=$(case "$(params.status)" in Succeeded|Completed) echo success;; *) echo failure;; esac)',
    "              COMMIT_SHA=$(params.revision) COMMIT_TS= PIPELINE_ID=$(context.pipelineRun.name)",
    "              REPO=%PROJECT% REF=$(params.branch) ACTOR=tekton",
    `              IMAGE_REF=$([ "$UDP_STATUS" = success ] && cat ${IMAGE_REF_FILE} || echo "")`,
    ...(params.build.signing === null
      ? []
      : [
          `              UDP_SIGNATURE_B64=$([ "$UDP_STATUS" = success ] && cat ${SIGNATURE_WS_FILE} || echo "")`,
        ]),
    `              ${environmentOfBranch("$(params.branch)")}`,
    ...notifyScript('-H "X-UDP-Signature: sha256=$SIG"').map(
      (line) => `              ${line}`,
    ),
    ...(schedule === null ? [] : rebasePipeline(params)),
  ];
};

const adapter: CicdDomainAdapter = createCicdAdapter({
  base,
  verifySignature: (headers, rawBody, secret) =>
    verifyHmacHeader(headers, rawBody, secret, "X-UDP-Signature", "sha256="),
  renderPipelineTemplate: (params) =>
    fillTemplate(pipeline(params), templateValues(params)),
});

export default adapter;

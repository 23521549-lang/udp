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
 * Adapter Tekton (§5.5 CI/CD, Plan #36) — họ Helm (chart `tekton-pipeline`) + lớp bọc CI/CD.
 *
 * Pipeline chạy NGAY trong cluster của project (Kaniko build, không cần Docker daemon). Tekton
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
    '              export IMAGE_REF="$(params.image):$(params.revision)"',
    ...step.commands.map((c) => `              ${c}`),
  ]);

/** [Plan #48 QĐ-4] Test trong image của runtime, trên workspace mã nguồn — trước build và mọi bước khác */
const TEST_TASK = [
  "    - name: test",
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

const pipeline = (params: PipelineTemplateParams): string[] => {
  const before = stepsOf(params, "before-build");
  const after = stepsOf(params, "after-build");
  return [
    "# tekton/udp-pipeline.yaml — sinh bởi UDP (Golden Path, §11)",
    "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
    "apiVersion: tekton.dev/v1",
    "kind: Pipeline",
    "metadata:",
    "  name: udp-%PROJECT%",
    "spec:",
    "  params:",
    "    - name: revision",
    "    - name: branch",
    "    - name: image",
    "      default: %IMAGE%",
    "    - name: environment",
    '      description: "nhánh main ⇒ %PROD%, nhánh khác ⇒ cùng tên"',
    "  workspaces:",
    "    - name: source",
    "  tasks:",
    ...TEST_TASK,
    ...stepTasks(before, ["test"]),
    "    - name: build-and-push",
    `      runAfter: [${["test", ...before.map(stepId)].join(", ")}]`,
    "      taskRef: { name: kaniko }",
    "      params:",
    "        - name: IMAGE",
    "          value: $(params.image):$(params.revision)",
    "      workspaces:",
    "        - name: source",
    "          workspace: source",
    ...stepTasks(after, ["build-and-push"]),
    "  finally:",
    "    - name: notify-udp",
    // Trạng thái GỘP của mọi task — bước của domain khác hỏng cũng là pipeline hỏng
    "      params:",
    "        - name: status",
    "          value: $(tasks.status)",
    "      taskSpec:",
    "        params: [{ name: status }]",
    "        steps:",
    "          - name: notify",
    "            image: alpine:3.20",
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
    '              IMAGE_REF=$([ "$UDP_STATUS" = success ] && echo "$(params.image):$(params.revision)" || echo "")',
    `              ${environmentOfBranch("$(params.branch)")}`,
    ...notifyScript('-H "X-UDP-Signature: sha256=$SIG"').map(
      (line) => `              ${line}`,
    ),
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

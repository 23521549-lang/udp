import { z } from "zod";
import type {
  CicdDomainAdapter,
  PipelineStep,
  PipelineTemplateParams,
} from "@udp/adapter-core";
import {
  createCicdAdapter,
  registryRefOf,
  verifyTokenHeader,
} from "../../adapter-base/cicd.js";
import { createDescriptorAdapter } from "../../adapter-base/descriptor.js";
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
import {
  dockerHostBuildLines,
  needsOidc,
  oidcAudience,
  registrySecretNames,
} from "../../adapter-base/packaging/build-script.js";
import { BUILD_TOOLCHAIN } from "@udp/config";

/**
 * Adapter GitLab CI (§5.5 CI/CD, Plan #36) — lớp nền mô tả + lớp bọc CI/CD.
 *
 * Chữ ký theo kiểu webhook gốc của GitLab: token nguyên văn trong `X-Gitlab-Token` — vẫn so theo
 * thời gian hằng (§8.3). Hỗ trợ GitLab.com lẫn bản tự lưu trữ (`gitlabUrl`, chỉ `https://`).
 */

export const gitlabCiConfigSchema = z.object({
  /** `nhom/nhom-con/du-an` */
  projectPath: z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/),
  gitlabUrl: z
    .string()
    .regex(/^https:\/\/[a-z0-9.-]+(:\d{2,5})?$/)
    .default("https://gitlab.com"),
});

const base = createDescriptorAdapter({
  domainType: "CICD",
  toolId: "gitlab-ci",
  version: "1.0.0",
  capabilities: {
    provides: [{ id: "pipeline.trigger", version: "1.0.0" }],
    requires: [{ id: "registry.oci" }],
    hint: {
      "registry.oci":
        "CI cần nơi đẩy image: bật một tool ở domain Container Registry",
    },
  },
  configSchema: gitlabCiConfigSchema,
  descriptorName: "udp-cicd-gitlab-ci",
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/"],
  describe: (config, ctx) => {
    const parsed = gitlabCiConfigSchema.parse(config);
    return {
      project: `${parsed.gitlabUrl}/${parsed.projectPath}`,
      registryRef: registryRefOf(ctx.resolved),
      signature: "X-Gitlab-Token",
    };
  },
  bindings: () => [
    {
      id: "pipeline.trigger",
      version: "1.0.0",
      providedBy: "cicd:gitlab-ci",
      attributes: { provider: "gitlab-ci" },
    },
  ],
});

/** Hai job báo UDP: một khi mọi stage thành công, một khi có stage hỏng */
const notifyJob = (status: "success" | "failure", when: string): string[] => [
  `udp-notify-${status}:`,
  "  stage: notify",
  `  image: ${BUILD_TOOLCHAIN.images.alpine}`,
  `  when: ${when}`,
  "  variables:",
  `    UDP_STATUS: "${status}"`,
  "  script:",
  "    - apk add --no-cache jq curl openssl",
  "    - export COMMIT_SHA=$CI_COMMIT_SHA COMMIT_TS=$CI_COMMIT_TIMESTAMP PIPELINE_ID=$CI_PIPELINE_ID-$CI_JOB_ID",
  "    - export REPO=$CI_PROJECT_PATH REF=$CI_COMMIT_REF_NAME ACTOR=$GITLAB_USER_LOGIN",
  ...(status === "success" ? [] : ['    - export IMAGE_REF=""']),
  "    - |",
  ...notifyScript('-H "X-Gitlab-Token: $UDP_WEBHOOK_SECRET"').map(
    (line) => `      ${line}`,
  ),
];

/**
 * Bước của domain khác là một job trong image của nó. Image công cụ thường có entrypoint riêng —
 * GitLab đòi xoá nó để chạy `script`. Biến bí mật là biến CI/CD của project (GitLab đưa vào môi
 * trường mọi job), nên template chỉ ghi TÊN cần khai.
 */
const stepJobs = (steps: readonly PipelineStep[], stage: string): string[] =>
  steps.flatMap((step) => [
    `${stepId(step)}:`,
    `  stage: ${stage}`,
    `  image: { name: "${step.image}", entrypoint: [""] }`,
    ...(step.secretEnv.length === 0
      ? []
      : [`  # cần biến CI/CD (masked): ${step.secretEnv.join(", ")}`]),
    ...(Object.keys(step.env).length === 0
      ? []
      : [
          "  variables:",
          ...publicEnvOf(step).map(([k, v]) => `    ${k}: "${v}"`),
        ]),
    "  script:",
    "    - |",
    ...step.commands.map((c) => `      ${c}`),
  ]);

/**
 * [Plan #61 QĐ-5, QĐ-6] Job build: Docker CLI cạnh dịch vụ dind (TLS), cùng đoạn shell với GitHub Actions và CircleCI.
 * Đẩy bằng danh tính build ⇒ `id_tokens` cấp JWT có `aud` của cloud. Ảnh có digest sang job sau bằng dotenv.
 */
const buildJob = (params: PipelineTemplateParams): string[] => {
  const images = BUILD_TOOLCHAIN.images;
  const identity = params.build.identity;
  const secrets = registrySecretNames(params.build.push, "gitlab-ci");
  return [
    "build:",
    "  stage: build",
    `  image: ${images.dockerCli}`,
    "  services:",
    `    - name: ${images.dockerDind}`,
    "      alias: docker",
    "  variables:",
    '    DOCKER_TLS_CERTDIR: "/certs"',
    ...(needsOidc(params.build, "gitlab-ci") && identity !== null
      ? [
          "  id_tokens:",
          "    UDP_OIDC_TOKEN:",
          `      aud: "${oidcAudience(identity)}"`,
        ]
      : []),
    ...(secrets.length === 0
      ? []
      : [`  # cần biến CI/CD (masked): ${secrets.join(", ")}`]),
    "  script:",
    // `pack` tải bằng curl; image Docker CLI là Alpine
    "    - apk add --no-cache curl",
    "    - |",
    ...[
      ...dockerHostBuildLines(params.build, "gitlab-ci", {
        image: "%IMAGE%",
        commit: "$CI_COMMIT_SHA",
        tmp: "/tmp/udp-build",
      }),
      'echo "UDP_IMAGE_REF=$UDP_IMAGE_REF" > build.env',
    ].map((line) => `      ${line}`),
    "  artifacts:",
    "    reports:",
    "      dotenv: build.env",
  ];
};

const pipeline = (params: PipelineTemplateParams): string[] => {
  const before = stepsOf(params, "before-build");
  const after = stepsOf(params, "after-build");
  const stages = [
    "test",
    ...(before.length === 0 ? [] : ["before-build"]),
    "build",
    ...(after.length === 0 ? [] : ["after-build"]),
    "notify",
  ];
  return [
    "# .gitlab-ci.yml — sinh bởi UDP (Golden Path, §11)",
    "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
    `stages: [${stages.join(", ")}]`,
    "variables:",
    '  UDP_TRACKED_FLAGS: "%FLAGS%"',
    '  IMAGE_REF: "%IMAGE%:$CI_COMMIT_SHA"',
    // Mọi job (bước của domain khác, job báo UDP) đọc cùng environment của nhánh
    "default:",
    "  before_script:",
    `    - export ${environmentOfBranch("$CI_COMMIT_REF_NAME")}`,
    // [Plan #61 QĐ-7] Job sau build nhận ảnh CÓ digest qua dotenv của job build
    '    - export IMAGE_REF="${UDP_IMAGE_REF:-$IMAGE_REF}"',
    "workflow:",
    "  rules:",
    "    - if: '$CI_COMMIT_BRANCH =~ /^(%BRANCH_REGEX%)$/'",
    "test:",
    "  stage: test",
    "  image: %TEST_IMAGE%",
    '  script: ["%TEST%"]',
    ...stepJobs(before, "before-build"),
    ...buildJob(params),
    ...stepJobs(after, "after-build"),
    ...notifyJob("success", "on_success"),
    ...notifyJob("failure", "on_failure"),
  ];
};

const adapter: CicdDomainAdapter = createCicdAdapter({
  base,
  verifySignature: (headers, _rawBody, secret) =>
    verifyTokenHeader(headers, secret, "X-Gitlab-Token"),
  renderPipelineTemplate: (params) => {
    const values = templateValues(params);
    return fillTemplate(pipeline(params), {
      ...values,
      BRANCH_REGEX: (values.BRANCH_LIST ?? "main").split(" ").join("|"),
    });
  },
});

export default adapter;

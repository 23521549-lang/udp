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
  rebaseNotifyVars,
  templateValues,
} from "../../adapter-base/pipeline-template.js";
import {
  dockerHostBuildLines,
  dockerHostLoginLines,
  needsOidc,
  oidcAudience,
  registrySecretNames,
} from "../../adapter-base/packaging/build-script.js";
import { dockerHostRebaseLines } from "../../adapter-base/packaging/rebase-script.js";
import { dockerHostSignLines } from "../../adapter-base/packaging/sign-script.js";
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

/**
 * [Plan #61 QĐ-13] Khi có lịch rebase, lượt theo lịch (`CI_PIPELINE_SOURCE == "schedule"`) chỉ chạy job rebase —
 * mọi job khác mang luật này. `rules` thay `when` ở cấp job (GitLab không nhận cả hai).
 */
function whenOf(when: string, rebase: boolean): string[] {
  if (!rebase) return when === "on_success" ? [] : [`  when: ${when}`];
  return [
    "  rules:",
    `    - if: '$CI_PIPELINE_SOURCE == "schedule"'`,
    "      when: never",
    `    - when: ${when}`,
  ];
}

/** Hai job báo UDP: một khi mọi stage thành công, một khi có stage hỏng */
const notifyJob = (
  status: "success" | "failure",
  when: string,
  rebase: boolean,
): string[] => [
  `udp-notify-${status}:`,
  "  stage: notify",
  `  image: ${BUILD_TOOLCHAIN.images.alpine}`,
  ...(rebase ? whenOf(when, true) : [`  when: ${when}`]),
  "  variables:",
  `    UDP_STATUS: "${status}"`,
  "  script:",
  "    - apk add --no-cache jq curl openssl",
  "    - export COMMIT_SHA=$CI_COMMIT_SHA COMMIT_TS=$CI_COMMIT_TIMESTAMP PIPELINE_ID=$CI_PIPELINE_ID-$CI_JOB_ID",
  // [Plan #61 QĐ-16] Chữ ký do job `sign` để lại (artifact): cổng deploy của UDP kiểm
  ...(status === "success"
    ? [
        `    - export UDP_SIGNATURE_B64=$(cat ${SIGNATURE_ARTIFACT} 2>/dev/null || true)`,
      ]
    : []),
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
const stepJobs = (
  steps: readonly PipelineStep[],
  stage: string,
  rebase: boolean,
): string[] =>
  steps.flatMap((step) => [
    `${stepId(step)}:`,
    `  stage: ${stage}`,
    `  image: { name: "${step.image}", entrypoint: [""] }`,
    ...whenOf("on_success", rebase),
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
/** Phần chung của job có Docker (build, rebase): Docker CLI cạnh dind (TLS), JWT cho danh tính build, tên secret */
function dockerJob(params: PipelineTemplateParams): string[] {
  const images = BUILD_TOOLCHAIN.images;
  // JWT cho cloud: ký bằng khoá KMS, hay đẩy bằng danh tính build — cùng danh tính khi cả hai (cloud của project)
  const identity =
    params.build.signing?.identity ??
    (needsOidc(params.build, "gitlab-ci") ? params.build.identity : null);
  const secrets = registrySecretNames(params.build.push, "gitlab-ci");
  return [
    `  image: ${images.dockerCli}`,
    "  services:",
    `    - name: ${images.dockerDind}`,
    "      alias: docker",
    "  variables:",
    '    DOCKER_TLS_CERTDIR: "/certs"',
    ...(identity !== null
      ? [
          "  id_tokens:",
          "    UDP_OIDC_TOKEN:",
          `      aud: "${oidcAudience(identity)}"`,
        ]
      : []),
    ...(secrets.length === 0
      ? []
      : [`  # cần biến CI/CD (masked): ${secrets.join(", ")}`]),
  ];
}

const buildJob = (
  params: PipelineTemplateParams,
  rebase: boolean,
): string[] => {
  return [
    "build:",
    "  stage: build",
    ...dockerJob(params),
    ...whenOf("on_success", rebase),
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

/** Tệp chữ ký (base64) mà job `sign` để lại cho job báo UDP — artifact, không dotenv (dotenv giới hạn 5 KB) */
const SIGNATURE_ARTIFACT = "udp-signature.b64";

/** [Plan #61 QĐ-14] Ký image có digest ở `digest` (biểu thức shell); ra `UDP_SIGNATURE_B64` */
const signLinesOf = (
  params: PipelineTemplateParams,
  vars: { digest: string; commit: string; ref: string; run: string },
): string[] =>
  dockerHostSignLines(params.build, "gitlab-ci", {
    image: "%IMAGE%",
    project: "%PROJECT%",
    tmp: "/tmp/udp-sign",
    ...vars,
  });

/**
 * [Plan #61 QĐ-14] Job `sign`: sau mọi job sau build (chỉ image đã qua quét mới được ký), trước job báo UDP. Job riêng
 * nên đăng nhập registry lại (cosign và oras đẩy chữ ký vào registry).
 */
const signJob = (params: PipelineTemplateParams, rebase: boolean): string[] =>
  params.build.signing === null
    ? []
    : [
        "sign:",
        "  stage: sign",
        ...dockerJob(params),
        ...whenOf("on_success", rebase),
        "  script:",
        "    - apk add --no-cache curl jq",
        "    - |",
        ...[
          ...dockerHostLoginLines(params.build, "gitlab-ci"),
          'UDP_DIGEST="${IMAGE_REF##*@}"',
          ...signLinesOf(params, {
            digest: "$UDP_DIGEST",
            commit: "$CI_COMMIT_SHA",
            ref: "$CI_COMMIT_REF_NAME",
            run: "$CI_PIPELINE_ID-$CI_JOB_ID",
          }),
          `printf '%s' "$UDP_SIGNATURE_B64" > ${SIGNATURE_ARTIFACT}`,
        ].map((line) => `      ${line}`),
        "  artifacts:",
        `    paths: [${SIGNATURE_ARTIFACT}]`,
      ];

/**
 * [Plan #61 QĐ-13] Job của lượt theo lịch (Build, Pipeline schedules, nhánh `main`): rebase image Buildpacks của commit
 * đầu `main` rồi báo UDP (`kind: rebase`). Không phải Buildpacks ⇒ đoạn shell dừng xanh trước bước báo.
 */
const rebaseJob = (params: PipelineTemplateParams): string[] => [
  "rebase:",
  "  stage: build",
  ...dockerJob(params),
  "  rules:",
  `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $CI_COMMIT_BRANCH == "main"'`,
  "  script:",
  "    - apk add --no-cache curl jq openssl",
  "    - export PIPELINE_ID=$CI_PIPELINE_ID-$CI_JOB_ID REPO=$CI_PROJECT_PATH ACTOR=$GITLAB_USER_LOGIN",
  "    - |",
  ...[
    "COMMIT_SHA=$CI_COMMIT_SHA",
    ...dockerHostRebaseLines(params.build, "gitlab-ci", {
      image: "%IMAGE%",
      commit: "$CI_COMMIT_SHA",
      tmp: "/tmp/udp-rebase",
    }),
    // Digest mới của lượt rebase cũng phải được ký — image chưa ký không qua cổng deploy
    ...(params.build.signing === null
      ? []
      : [
          'UDP_DIGEST="${UDP_IMAGE_REF##*@}"',
          ...signLinesOf(params, {
            digest: "$UDP_DIGEST",
            commit: "$CI_COMMIT_SHA",
            ref: "main",
            run: "$PIPELINE_ID",
          }),
        ]),
    ...rebaseNotifyVars("$CI_COMMIT_REF_NAME"),
    ...notifyScript('-H "X-Gitlab-Token: $UDP_WEBHOOK_SECRET"'),
  ].map((line) => `      ${line}`),
];

const pipeline = (params: PipelineTemplateParams): string[] => {
  const before = stepsOf(params, "before-build");
  const after = stepsOf(params, "after-build");
  const schedule = rebaseScheduleOf(params.build, params.projectSlug);
  const rebase = schedule !== null;
  const stages = [
    "test",
    ...(before.length === 0 ? [] : ["before-build"]),
    "build",
    ...(after.length === 0 ? [] : ["after-build"]),
    ...(params.build.signing === null ? [] : ["sign"]),
    "notify",
  ];
  return [
    "# .gitlab-ci.yml — sinh bởi UDP (Golden Path, §11)",
    "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
    ...(schedule === null
      ? []
      : [
          `# [Plan #61 QĐ-13] Vá image nền: tạo lịch ở Build, Pipeline schedules — nhánh main, cron "${schedule.cron}", múi giờ UTC`,
        ]),
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
    ...whenOf("on_success", rebase),
    '  script: ["%TEST%"]',
    ...stepJobs(before, "before-build", rebase),
    ...buildJob(params, rebase),
    ...stepJobs(after, "after-build", rebase),
    ...signJob(params, rebase),
    ...notifyJob("success", "on_success", rebase),
    ...notifyJob("failure", "on_failure", rebase),
    ...(rebase ? rebaseJob(params) : []),
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

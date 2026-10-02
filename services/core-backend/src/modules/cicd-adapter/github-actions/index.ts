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
import { createDescriptorAdapter } from "../../adapter-base/descriptor.js";
import {
  dockerRunLine,
  stepId,
  stepsOf,
} from "../../adapter-base/pipeline-steps.js";
import {
  environmentExpr,
  fillTemplate,
  notifyScript,
  rebaseNotifyVars,
  rebaseTimeOf,
  templateValues,
  TEST_IN_CONTAINER,
} from "../../adapter-base/pipeline-template.js";
import { githubOwner } from "../../adapter-base/github.js";
import {
  dockerHostBuildLines,
  effectivePush,
  needsOidc,
  registrySecretNames,
} from "../../adapter-base/packaging/build-script.js";
import { dockerHostRebaseLines } from "../../adapter-base/packaging/rebase-script.js";
import { dockerHostSignLines } from "../../adapter-base/packaging/sign-script.js";
import { BUILD_TOOLCHAIN } from "@udp/config";

const CHECKOUT = BUILD_TOOLCHAIN.actions.checkout;

/**
 * Adapter GitHub Actions (§5.5 CI/CD, Plan #36) — lớp nền mô tả + lớp bọc CI/CD.
 *
 * Không cài gì vào cluster: workflow chạy ở GitHub. Cluster giữ ConfigMap mô tả (repo, registry mà
 * pipeline đẩy image tới — đọc từ binding `registry.oci`, không đoán). Bước "báo UDP" của workflow
 * ký thân bằng HMAC-SHA256 trong `X-Hub-Signature-256: sha256=…` — cùng kiểu webhook gốc của GitHub.
 */

export const githubActionsConfigSchema = z.object({
  /** `owner/repo` */
  repository: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
    .refine((r) => githubOwner.safeParse(r.split("/")[0]).success),
});

const base = createDescriptorAdapter({
  domainType: "CICD",
  toolId: "github-actions",
  version: "1.0.0",
  capabilities: {
    provides: [{ id: "pipeline.trigger", version: "1.0.0" }],
    requires: [{ id: "registry.oci" }],
    hint: {
      "registry.oci":
        "CI cần nơi đẩy image: bật một tool ở domain Container Registry",
    },
  },
  configSchema: githubActionsConfigSchema,
  descriptorName: "udp-cicd-github-actions",
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/"],
  describe: (config, ctx) => ({
    repository: githubActionsConfigSchema.parse(config).repository,
    registryRef: registryRefOf(ctx.resolved),
    signature: "X-Hub-Signature-256",
  }),
  bindings: () => [
    {
      id: "pipeline.trigger",
      version: "1.0.0",
      providedBy: "cicd:github-actions",
      attributes: { provider: "github-actions" },
    },
  ],
});

/** Bước của domain khác chạy trong image của nó; bí mật lấy từ `secrets` của repo theo TÊN */
const stepLines = (steps: readonly PipelineStep[]): string[] =>
  steps.flatMap((step) => [
    `      - name: ${stepId(step)}`,
    ...(step.secretEnv.length === 0
      ? []
      : [
          "        env:",
          ...step.secretEnv.map(
            (name) => `          ${name}: \${{ secrets.${name} }}`,
          ),
        ]),
    "        run: |",
    `          ${dockerRunLine(step)}`,
  ]);

/** [Plan #61 QĐ-6] Quyền tối thiểu của `GITHUB_TOKEN`: đọc mã; thêm `id-token` khi đẩy bằng danh tính build, `packages` khi đẩy GHCR */
const permissions = (params: PipelineTemplateParams): string[] => {
  const push = effectivePush(params.build.push, "github-actions");
  return [
    "permissions:",
    "  contents: read",
    // JWT cho cloud: đẩy bằng danh tính build, hay ký bằng khoá KMS (Plan #61 QĐ-14)
    ...(needsOidc(params.build, "github-actions") ||
    params.build.signing !== null
      ? ["  id-token: write"]
      : []),
    ...(push.kind === "github-token" ? ["  packages: write"] : []),
  ];
};

/** Biến đăng nhập registry: token của lượt chạy cho GHCR, hay hai secret của registry dùng mật khẩu */
const registryEnv = (params: PipelineTemplateParams): string[] => {
  const push = effectivePush(params.build.push, "github-actions");
  if (push.kind === "github-token") {
    return ["          GITHUB_TOKEN: ${{ github.token }}"];
  }
  return registrySecretNames(params.build.push, "github-actions").map(
    (name) => `          ${name}: \${{ secrets.${name} }}`,
  );
};

const buildEnv = (params: PipelineTemplateParams): string[] => {
  const env = registryEnv(params);
  return env.length === 0 ? [] : ["        env:", ...env];
};

/** [Plan #61 QĐ-14] Ký image có digest ở `digest` (biểu thức shell); `UDP_SIGNATURE_B64` cho bước báo UDP */
const signLinesOf = (
  params: PipelineTemplateParams,
  vars: { digest: string; commit: string; ref: string; run: string },
): string[] =>
  dockerHostSignLines(params.build, "github-actions", {
    image: "%IMAGE%",
    project: "%PROJECT%",
    tmp: "$RUNNER_TEMP/udp-sign",
    ...vars,
  });

/** Bước "Ký image" của job build: sau bước sau build (chỉ image đã qua quét mới được ký), trước bước báo UDP */
const signStep = (params: PipelineTemplateParams): string[] =>
  params.build.signing === null
    ? []
    : [
        "      - name: Ký image",
        "        run: |",
        ...[
          'UDP_DIGEST="${IMAGE_REF##*@}"',
          ...signLinesOf(params, {
            digest: "$UDP_DIGEST",
            commit: "$GITHUB_SHA",
            ref: "$GITHUB_REF_NAME",
            run: "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT",
          }),
          'echo "UDP_SIGNATURE_B64=$UDP_SIGNATURE_B64" >> "$GITHUB_ENV"',
        ].map((line) => `          ${line}`),
      ];

/**
 * [Plan #61 QĐ-13] Job của lượt theo lịch: rebase image Buildpacks của commit đầu `main` rồi báo UDP (`kind: rebase`).
 * Không phải Buildpacks ⇒ đoạn shell dừng xanh trước bước báo. Rebase hỏng ⇒ job đỏ, không báo.
 */
const rebaseJob = (params: PipelineTemplateParams): string[] => [
  "  rebase:",
  "    if: github.event_name == 'schedule'",
  "    runs-on: ubuntu-latest",
  "    steps:",
  `      - uses: ${CHECKOUT.repo}@${CHECKOUT.sha} # ${CHECKOUT.version}`,
  "        with:",
  "          ref: main",
  "      - name: Rebase image nền và báo UDP",
  "        env:",
  ...registryEnv(params),
  "          UDP_WEBHOOK_URL: ${{ vars.UDP_WEBHOOK_URL }}",
  "          UDP_WEBHOOK_SECRET: ${{ secrets.UDP_WEBHOOK_SECRET }}",
  "          PIPELINE_ID: ${{ github.run_id }}-${{ github.run_attempt }}",
  "          REPO: ${{ github.repository }}",
  "          ACTOR: ${{ github.actor }}",
  "        run: |",
  ...[
    "COMMIT_SHA=$(git rev-parse HEAD)",
    ...dockerHostRebaseLines(params.build, "github-actions", {
      image: "%IMAGE%",
      commit: "$COMMIT_SHA",
      tmp: "$RUNNER_TEMP/udp-rebase",
    }),
    // Digest mới của lượt rebase cũng phải được ký — image chưa ký không qua cổng deploy
    ...(params.build.signing === null
      ? []
      : [
          'UDP_DIGEST="${UDP_IMAGE_REF##*@}"',
          ...signLinesOf(params, {
            digest: "$UDP_DIGEST",
            commit: "$COMMIT_SHA",
            ref: "main",
            run: "$PIPELINE_ID",
          }),
        ]),
    ...rebaseNotifyVars("refs/heads/main"),
    ...notifyScript('-H "X-Hub-Signature-256: sha256=$SIG"'),
  ].map((line) => `          ${line}`),
];

const workflow = (params: PipelineTemplateParams): string[] => {
  const schedule = rebaseScheduleOf(params.build, params.projectSlug);
  return [
    "# .github/workflows/udp.yml — sinh bởi UDP (Golden Path, §11)",
    "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
    "name: UDP CI/CD",
    "on:",
    "  push:",
    "    branches: [%BRANCHES%]",
    ...(schedule === null
      ? []
      : [
          `  # [Plan #61 QĐ-13] Vá image nền (rebase) mỗi ngày lúc ${rebaseTimeOf(schedule)} UTC — lượt này chỉ chạy job rebase`,
          "  schedule:",
          `    - cron: "${schedule.cron}"`,
        ]),
    ...permissions(params),
    "jobs:",
    "  build-and-deploy:",
    ...(schedule === null ? [] : ["    if: github.event_name != 'schedule'"]),
    "    runs-on: ubuntu-latest",
    "    env:",
    "      IMAGE_REF: %IMAGE%:${{ github.sha }}",
    '      UDP_TRACKED_FLAGS: "%FLAGS%"',
    "    steps:",
    // Bước ĐẦU: mọi bước sau (kể cả bước của domain khác và bước báo UDP) đọc cùng giá trị
    "      - name: Chọn environment theo nhánh",
    "        run: |",
    `          echo "UDP_ENVIRONMENT=${environmentExpr("$GITHUB_REF_NAME")}" >> "$GITHUB_ENV"`,
    `      - uses: ${CHECKOUT.repo}@${CHECKOUT.sha} # ${CHECKOUT.version}`,
    "      - name: Test",
    `        run: ${TEST_IN_CONTAINER}`,
    ...stepLines(stepsOf(params, "before-build")),
    "      - name: Build và đẩy image",
    ...buildEnv(params),
    "        run: |",
    ...[
      ...dockerHostBuildLines(params.build, "github-actions", {
        image: "%IMAGE%",
        commit: "$GITHUB_SHA",
        tmp: "$RUNNER_TEMP/udp-build",
      }),
      // [Plan #61 QĐ-7] Bước sau build và bước báo UDP dùng đúng digest vừa đẩy
      'echo "IMAGE_REF=$UDP_IMAGE_REF" >> "$GITHUB_ENV"',
    ].map((line) => `          ${line}`),
    ...stepLines(stepsOf(params, "after-build")),
    ...signStep(params),
    "      - name: Báo UDP",
    "        if: always()",
    "        env:",
    "          UDP_WEBHOOK_URL: ${{ vars.UDP_WEBHOOK_URL }}",
    "          UDP_WEBHOOK_SECRET: ${{ secrets.UDP_WEBHOOK_SECRET }}",
    "          UDP_STATUS: ${{ job.status == 'success' && 'success' || 'failure' }}",
    "          COMMIT_SHA: ${{ github.sha }}",
    "          COMMIT_TS: ${{ github.event.head_commit.timestamp }}",
    "          PIPELINE_ID: ${{ github.run_id }}-${{ github.run_attempt }}",
    "          REPO: ${{ github.repository }}",
    "          REF: ${{ github.ref }}",
    "          ACTOR: ${{ github.actor }}",
    "        run: |",
    '          [ "$UDP_STATUS" = "success" ] || IMAGE_REF=""',
    ...notifyScript('-H "X-Hub-Signature-256: sha256=$SIG"').map(
      (line) => `          ${line}`,
    ),
    ...(schedule === null ? [] : rebaseJob(params)),
  ];
};

const adapter: CicdDomainAdapter = createCicdAdapter({
  base,
  verifySignature: (headers, rawBody, secret) =>
    verifyHmacHeader(
      headers,
      rawBody,
      secret,
      "X-Hub-Signature-256",
      "sha256=",
    ),
  renderPipelineTemplate: (params) =>
    fillTemplate(workflow(params), templateValues(params)),
});

export default adapter;

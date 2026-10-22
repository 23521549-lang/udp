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
import { dockerHostBuildLines } from "../../adapter-base/packaging/build-script.js";
import { dockerHostRebaseLines } from "../../adapter-base/packaging/rebase-script.js";
import { dockerHostSignLines } from "../../adapter-base/packaging/sign-script.js";

/**
 * Adapter CircleCI (§5.5 CI/CD, Plan #36) — lớp nền mô tả + lớp bọc CI/CD.
 *
 * Chữ ký theo kiểu webhook gốc của CircleCI: `circleci-signature: v1=<HMAC-SHA256 hex>` trên thân
 * thô.
 */

const CIRCLECI_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const circleciConfigSchema = z.object({
  /** `gh/owner/repo`, `bb/owner/repo` hay `circleci/<org-id>/<project-id>` */
  projectSlug: z
    .string()
    .regex(/^(gh|bb|circleci)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  /**
   * [Plan #61 QĐ-6] Id tổ chức và project của CircleCI (Organization/Project Settings) — chủ thể JWT OIDC của CircleCI
   * mang hai id này, nên danh tính build trong cloud chỉ tin được đúng project khi biết chúng. Không bí mật.
   */
  organizationId: z.string().regex(CIRCLECI_UUID).optional(),
  projectId: z.string().regex(CIRCLECI_UUID).optional(),
});

const base = createDescriptorAdapter({
  domainType: "CICD",
  toolId: "circleci",
  version: "1.0.0",
  capabilities: {
    provides: [{ id: "pipeline.trigger", version: "1.0.0" }],
    requires: [{ id: "registry.oci" }],
    hint: {
      "registry.oci":
        "CI cần nơi đẩy image: bật một tool ở domain Container Registry",
    },
  },
  configSchema: circleciConfigSchema,
  descriptorName: "udp-cicd-circleci",
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/"],
  describe: (config, ctx) => ({
    projectSlug: circleciConfigSchema.parse(config).projectSlug,
    registryRef: registryRefOf(ctx.resolved),
    signature: "circleci-signature",
  }),
  bindings: () => [
    {
      id: "pipeline.trigger",
      version: "1.0.0",
      providedBy: "cicd:circleci",
      attributes: { provider: "circleci" },
    },
  ],
});

const notifyStep = (status: "success" | "failure", when: string): string[] => [
  "      - run:",
  `          name: Báo UDP (${status})`,
  `          when: ${when}`,
  "          command: |",
  `            export UDP_STATUS=${status}`,
  "            export COMMIT_SHA=$CIRCLE_SHA1 COMMIT_TS= PIPELINE_ID=$CIRCLE_WORKFLOW_ID",
  "            export REPO=$CIRCLE_PROJECT_USERNAME/$CIRCLE_PROJECT_REPONAME REF=$CIRCLE_BRANCH ACTOR=$CIRCLE_USERNAME",
  ...(status === "success" ? [] : ['            export IMAGE_REF=""']),
  ...notifyScript('-H "circleci-signature: v1=$SIG"', OIDC_TOKEN_LINES).map(
    (line) => `            ${line}`,
  ),
];

/** Bước của domain khác: `docker run` trên máy chạy; bí mật là biến môi trường của project */
const stepRuns = (steps: readonly PipelineStep[]): string[] =>
  steps.flatMap((step) => [
    "      - run:",
    `          name: ${stepId(step)}`,
    "          command: |",
    `            ${dockerRunLine(step)}`,
  ]);

/** [Plan #61 QĐ-14] Ký image có digest ở `digest` (biểu thức shell); ra `UDP_SIGNATURE_B64` */
const signLinesOf = (
  params: PipelineTemplateParams,
  vars: { digest: string; commit: string; ref: string; run: string },
): string[] =>
  dockerHostSignLines(params.build, "circleci", {
    image: "%IMAGE%",
    project: "%PROJECT%",
    tmp: "/tmp/udp-sign",
    ...vars,
  });

/** Bước "Ký image": sau bước sau build (chỉ image đã qua quét mới được ký), trước bước báo UDP */
const signStep = (params: PipelineTemplateParams): string[] =>
  params.build.signing === null
    ? []
    : [
        "      - run:",
        "          name: Ký image",
        "          command: |",
        ...[
          'UDP_DIGEST="${IMAGE_REF##*@}"',
          ...signLinesOf(params, {
            digest: "$UDP_DIGEST",
            commit: "$CIRCLE_SHA1",
            ref: "$CIRCLE_BRANCH",
            run: "$CIRCLE_WORKFLOW_ID",
          }),
          'echo "export UDP_SIGNATURE_B64=$UDP_SIGNATURE_B64" >> "$BASH_ENV"',
        ].map((line) => `            ${line}`),
      ];

/**
 * Executor `machine`: Docker chạy ngay trên máy của job. Với `docker` + `setup_remote_docker` thì
 * engine ở máy khác và `docker run -v` không thấy thư mục làm việc — bước của domain khác hỏng.
 */
/**
 * [Plan #61 QĐ-13] Job của lượt theo lịch (Project Settings, Triggers, nhánh `main`): rebase image Buildpacks của commit
 * đầu `main` rồi báo UDP (`kind: rebase`). Không phải Buildpacks ⇒ đoạn shell dừng xanh trước bước báo.
 */
const rebaseJob = (params: PipelineTemplateParams): string[] => [
  "  rebase:",
  "    machine:",
  "      image: ubuntu-2204:current",
  "    steps:",
  "      - checkout",
  "      - run:",
  "          name: Rebase image nền và báo UDP",
  "          command: |",
  ...[
    "COMMIT_SHA=$CIRCLE_SHA1 PIPELINE_ID=$CIRCLE_WORKFLOW_ID",
    "REPO=$CIRCLE_PROJECT_USERNAME/$CIRCLE_PROJECT_REPONAME ACTOR=$CIRCLE_USERNAME",
    ...dockerHostRebaseLines(params.build, "circleci", {
      image: "%IMAGE%",
      commit: "$CIRCLE_SHA1",
      tmp: "/tmp/udp-rebase",
    }),
    // Digest mới của lượt rebase cũng phải được ký — image chưa ký không qua cổng deploy
    ...(params.build.signing === null
      ? []
      : [
          'UDP_DIGEST="${UDP_IMAGE_REF##*@}"',
          ...signLinesOf(params, {
            digest: "$UDP_DIGEST",
            commit: "$CIRCLE_SHA1",
            ref: "main",
            run: "$PIPELINE_ID",
          }),
        ]),
    ...rebaseNotifyVars("$CIRCLE_BRANCH"),
    ...notifyScript('-H "circleci-signature: v1=$SIG"', OIDC_TOKEN_LINES),
  ].map((line) => `            ${line}`),
];

/**
 * [Plan #61 QD-17, 61d-2a] Trusted Deploy: CircleCI tiem san token OIDC cua luot chay vao
 * `$CIRCLE_OIDC_TOKEN_V2`, nen buoc bao chi can doi ten bien.
 *
 * Da kiem tai tai lieu CircleCI (02/10/2026): `aud` mac dinh LA ORGANIZATION_ID, va doi no can mot tinh
 * nang rieng o muc to chuc ("OIDC Tokens With Custom Claims") chu KHONG dat duoc trong `config.yml`. Nen
 * bo kiem cua UDP mong doi `aud` = `organizationId`, va cai gia phai cong bo (§16): voi CircleCI, `aud`
 * khong buoc token vao dung project nay — moi job trong cung to chuc deu co token mang dung `aud` do, nen
 * viec buoc token vao project doi hoan toan sang claim `oidc.circleci.com/project-id`.
 */
const OIDC_TOKEN_LINES = ['UDP_OIDC_TOKEN="$CIRCLE_OIDC_TOKEN_V2"'];

/** Điều kiện lượt theo lịch — `pipeline.trigger_source` đã ngừng hỗ trợ từ 01/08/2026, dùng `pipeline.trigger.type` */
const SCHEDULED = "equal: [schedule, << pipeline.trigger.type >>]";

const config = (params: PipelineTemplateParams): string[] => {
  const schedule = rebaseScheduleOf(params.build, params.projectSlug);
  return [
    "# .circleci/config.yml — sinh bởi UDP (Golden Path, §11)",
    "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
    ...(schedule === null
      ? []
      : [
          `# [Plan #61 QĐ-13] Vá image nền: thêm lịch ở Project Settings, Triggers — nhánh main, mỗi ngày ${rebaseTimeOf(schedule)} UTC`,
        ]),
    "version: 2.1",
    "jobs:",
    "  build-and-deploy:",
    "    machine:",
    "      image: ubuntu-2204:current",
    "    environment:",
    '      UDP_TRACKED_FLAGS: "%FLAGS%"',
    "    steps:",
    // Bước ĐẦU: `BASH_ENV` đưa hai biến vào mọi bước sau, kể cả bước báo UDP
    "      - run: |",
    `          echo "export UDP_ENVIRONMENT=${environmentExpr("$CIRCLE_BRANCH")}" >> "$BASH_ENV"`,
    '          echo "export IMAGE_REF=%IMAGE%:$CIRCLE_SHA1" >> "$BASH_ENV"',
    "      - checkout",
    `      - run: ${TEST_IN_CONTAINER}`,
    ...stepRuns(stepsOf(params, "before-build")),
    "      - run:",
    "          name: Build và đẩy image",
    "          command: |",
    ...[
      ...dockerHostBuildLines(params.build, "circleci", {
        image: "%IMAGE%",
        commit: "$CIRCLE_SHA1",
        tmp: "/tmp/udp-build",
      }),
      // [Plan #61 QĐ-7] Bước sau build và bước báo UDP dùng đúng digest vừa đẩy
      'echo "export IMAGE_REF=$UDP_IMAGE_REF" >> "$BASH_ENV"',
    ].map((line) => `            ${line}`),
    ...stepRuns(stepsOf(params, "after-build")),
    ...signStep(params),
    ...notifyStep("success", "on_success"),
    ...notifyStep("failure", "on_fail"),
    ...(schedule === null ? [] : rebaseJob(params)),
    "workflows:",
    "  udp:",
    ...(schedule === null
      ? []
      : ["    when:", "      not:", `        ${SCHEDULED}`]),
    "    jobs:",
    "      - build-and-deploy:",
    "          filters:",
    "            branches:",
    "              only: [%BRANCHES%]",
    ...(schedule === null
      ? []
      : [
          "  udp-rebase:",
          "    when:",
          `      ${SCHEDULED}`,
          "    jobs:",
          "      - rebase:",
          "          filters:",
          "            branches:",
          "              only: [main]",
        ]),
  ];
};

const adapter: CicdDomainAdapter = createCicdAdapter({
  base,
  verifySignature: (headers, rawBody, secret) =>
    verifyHmacHeader(headers, rawBody, secret, "circleci-signature", "v1="),
  renderPipelineTemplate: (params) =>
    fillTemplate(config(params), templateValues(params)),
});

export default adapter;

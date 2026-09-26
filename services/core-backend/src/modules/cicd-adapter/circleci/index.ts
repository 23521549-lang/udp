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
  templateValues,
} from "../../adapter-base/pipeline-template.js";

/**
 * Adapter CircleCI (§5.5 CI/CD, Plan #36) — lớp nền mô tả + lớp bọc CI/CD.
 *
 * Chữ ký theo kiểu webhook gốc của CircleCI: `circleci-signature: v1=<HMAC-SHA256 hex>` trên thân
 * thô.
 */

export const circleciConfigSchema = z.object({
  /** `gh/owner/repo`, `bb/owner/repo` hay `circleci/<org-id>/<project-id>` */
  projectSlug: z
    .string()
    .regex(/^(gh|bb|circleci)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
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
  ...notifyScript('-H "circleci-signature: v1=$SIG"').map(
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

/**
 * Executor `machine`: Docker chạy ngay trên máy của job. Với `docker` + `setup_remote_docker` thì
 * engine ở máy khác và `docker run -v` không thấy thư mục làm việc — bước của domain khác hỏng.
 */
const config = (params: PipelineTemplateParams): string[] => [
  "# .circleci/config.yml — sinh bởi UDP (Golden Path, §11)",
  "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
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
  "      - run: npm ci && npm test",
  ...stepRuns(stepsOf(params, "before-build")),
  '      - run: docker build -t "$IMAGE_REF" . && docker push "$IMAGE_REF"',
  ...stepRuns(stepsOf(params, "after-build")),
  ...notifyStep("success", "on_success"),
  ...notifyStep("failure", "on_fail"),
  "workflows:",
  "  udp:",
  "    jobs:",
  "      - build-and-deploy:",
  "          filters:",
  "            branches:",
  "              only: [%BRANCHES%]",
];

const adapter: CicdDomainAdapter = createCicdAdapter({
  base,
  verifySignature: (headers, rawBody, secret) =>
    verifyHmacHeader(headers, rawBody, secret, "circleci-signature", "v1="),
  renderPipelineTemplate: (params) =>
    fillTemplate(config(params), templateValues(params)),
});

export default adapter;

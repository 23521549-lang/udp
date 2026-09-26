import { z } from "zod";
import type { CicdDomainAdapter } from "@udp/adapter-core";
import {
  createCicdAdapter,
  registryRefOf,
  verifyHmacHeader,
} from "../../adapter-base/cicd.js";
import { createDescriptorAdapter } from "../../adapter-base/descriptor.js";
import {
  environmentOfBranch,
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
  status === "success"
    ? '            export IMAGE_REF="%IMAGE%:$CIRCLE_SHA1"'
    : '            export IMAGE_REF=""',
  `            ${environmentOfBranch("$CIRCLE_BRANCH")}`,
  ...notifyScript('-H "circleci-signature: v1=$SIG"').map(
    (line) => `            ${line}`,
  ),
];

const CONFIG = [
  "# .circleci/config.yml — sinh bởi UDP (Golden Path, §11)",
  "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
  "version: 2.1",
  "jobs:",
  "  build-and-deploy:",
  "    docker:",
  "      - image: cimg/node:20.17",
  "    environment:",
  '      UDP_TRACKED_FLAGS: "%FLAGS%"',
  "    steps:",
  "      - checkout",
  "      - setup_remote_docker",
  "      - run: npm ci && npm test",
  '      - run: docker build -t "%IMAGE%:$CIRCLE_SHA1" . && docker push "%IMAGE%:$CIRCLE_SHA1"',
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
    fillTemplate(CONFIG, templateValues(params)),
});

export default adapter;

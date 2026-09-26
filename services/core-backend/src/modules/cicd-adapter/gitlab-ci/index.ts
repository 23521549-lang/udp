import { z } from "zod";
import type { CicdDomainAdapter } from "@udp/adapter-core";
import {
  createCicdAdapter,
  registryRefOf,
  verifyTokenHeader,
} from "../../adapter-base/cicd.js";
import { createDescriptorAdapter } from "../../adapter-base/descriptor.js";
import {
  environmentOfBranch,
  fillTemplate,
  notifyScript,
  templateValues,
} from "../../adapter-base/pipeline-template.js";

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
  "  image: alpine:3.20",
  `  when: ${when}`,
  "  variables:",
  `    UDP_STATUS: "${status}"`,
  "  script:",
  "    - apk add --no-cache jq curl openssl",
  "    - export COMMIT_SHA=$CI_COMMIT_SHA COMMIT_TS=$CI_COMMIT_TIMESTAMP PIPELINE_ID=$CI_PIPELINE_ID-$CI_JOB_ID",
  "    - export REPO=$CI_PROJECT_PATH REF=$CI_COMMIT_REF_NAME ACTOR=$GITLAB_USER_LOGIN",
  status === "success"
    ? '    - export IMAGE_REF="%IMAGE%:$CI_COMMIT_SHA"'
    : '    - export IMAGE_REF=""',
  "    - |",
  `      ${environmentOfBranch("$CI_COMMIT_REF_NAME")}`,
  ...notifyScript('-H "X-Gitlab-Token: $UDP_WEBHOOK_SECRET"').map(
    (line) => `      ${line}`,
  ),
];

const PIPELINE = [
  "# .gitlab-ci.yml — sinh bởi UDP (Golden Path, §11)",
  "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
  "stages: [test, build, notify]",
  "variables:",
  '  UDP_TRACKED_FLAGS: "%FLAGS%"',
  "workflow:",
  "  rules:",
  "    - if: '$CI_COMMIT_BRANCH =~ /^(%BRANCH_REGEX%)$/'",
  "test:",
  "  stage: test",
  "  image: node:20-alpine",
  "  script: [npm ci, npm test]",
  "build:",
  "  stage: build",
  "  image: docker:27",
  "  services: [docker:27-dind]",
  "  script:",
  '    - docker build -t "%IMAGE%:$CI_COMMIT_SHA" .',
  '    - docker push "%IMAGE%:$CI_COMMIT_SHA"',
  ...notifyJob("success", "on_success"),
  ...notifyJob("failure", "on_failure"),
];

const adapter: CicdDomainAdapter = createCicdAdapter({
  base,
  verifySignature: (headers, _rawBody, secret) =>
    verifyTokenHeader(headers, secret, "X-Gitlab-Token"),
  renderPipelineTemplate: (params) => {
    const values = templateValues(params);
    return fillTemplate(PIPELINE, {
      ...values,
      BRANCH_REGEX: (values.BRANCH_LIST ?? "main").split(" ").join("|"),
    });
  },
});

export default adapter;

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
  TEST_IN_CONTAINER,
} from "../../adapter-base/pipeline-template.js";
import { githubOwner } from "../../adapter-base/github.js";
import {
  dockerHostBuildLines,
  effectivePush,
  needsOidc,
  registrySecretNames,
} from "../../adapter-base/packaging/build-script.js";
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
    ...(needsOidc(params.build, "github-actions") ? ["  id-token: write"] : []),
    ...(push.kind === "github-token" ? ["  packages: write"] : []),
  ];
};

/** Biến của bước build: token của lượt chạy cho GHCR, hay hai secret của registry dùng mật khẩu */
const buildEnv = (params: PipelineTemplateParams): string[] => {
  const push = effectivePush(params.build.push, "github-actions");
  if (push.kind === "github-token") {
    return ["        env:", "          GITHUB_TOKEN: ${{ github.token }}"];
  }
  const names = registrySecretNames(params.build.push, "github-actions");
  return names.length === 0
    ? []
    : [
        "        env:",
        ...names.map((name) => `          ${name}: \${{ secrets.${name} }}`),
      ];
};

const workflow = (params: PipelineTemplateParams): string[] => [
  "# .github/workflows/udp.yml — sinh bởi UDP (Golden Path, §11)",
  "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
  "name: UDP CI/CD",
  "on:",
  "  push:",
  "    branches: [%BRANCHES%]",
  ...permissions(params),
  "jobs:",
  "  build-and-deploy:",
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
];

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

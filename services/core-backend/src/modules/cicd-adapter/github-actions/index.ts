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
import { githubOwner } from "../../adapter-base/github.js";

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

const WORKFLOW = [
  "# .github/workflows/udp.yml — sinh bởi UDP (Golden Path, §11)",
  "# Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
  "name: UDP CI/CD",
  "on:",
  "  push:",
  "    branches: [%BRANCHES%]",
  "jobs:",
  "  build-and-deploy:",
  "    runs-on: ubuntu-latest",
  "    env:",
  "      IMAGE_REF: %IMAGE%:${{ github.sha }}",
  '      UDP_TRACKED_FLAGS: "%FLAGS%"',
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - name: Test",
  "        run: npm test",
  "      - name: Build và đẩy image",
  '        run: docker build -t "$IMAGE_REF" . && docker push "$IMAGE_REF"',
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
  `          ${environmentOfBranch("$GITHUB_REF_NAME")}`,
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
    fillTemplate(WORKFLOW, templateValues(params)),
});

export default adapter;

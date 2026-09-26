import { z } from "zod";
import type { CicdDomainAdapter } from "@udp/adapter-core";
import {
  createCicdAdapter,
  registryRefOf,
  verifyHmacHeader,
} from "../../adapter-base/cicd.js";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import {
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

const PIPELINE = [
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
  "    - name: build-and-push",
  "      taskRef: { name: kaniko }",
  "      params:",
  "        - name: IMAGE",
  "          value: $(params.image):$(params.revision)",
  "      workspaces:",
  "        - name: source",
  "          workspace: source",
  "  finally:",
  "    - name: notify-udp",
  "      params:",
  "        - name: status",
  "          value: $(tasks.build-and-push.status)",
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
  '              UDP_STATUS=$([ "$(params.status)" = "Succeeded" ] && echo success || echo failure)',
  "              COMMIT_SHA=$(params.revision) COMMIT_TS= PIPELINE_ID=$(context.pipelineRun.name)",
  "              REPO=%PROJECT% REF=$(params.branch) ACTOR=tekton",
  '              IMAGE_REF=$([ "$UDP_STATUS" = success ] && echo "$(params.image):$(params.revision)" || echo "")',
  '              UDP_ENVIRONMENT=$([ "$(params.branch)" = main ] && echo "%PROD%" || echo "$(params.branch)")',
  ...notifyScript('-H "X-UDP-Signature: sha256=$SIG"').map(
    (line) => `              ${line}`,
  ),
];

const adapter: CicdDomainAdapter = createCicdAdapter({
  base,
  verifySignature: (headers, rawBody, secret) =>
    verifyHmacHeader(headers, rawBody, secret, "X-UDP-Signature", "sha256="),
  renderPipelineTemplate: (params) =>
    fillTemplate(PIPELINE, templateValues(params)),
});

export default adapter;

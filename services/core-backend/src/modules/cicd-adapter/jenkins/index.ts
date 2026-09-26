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
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import {
  dockerRunLine,
  stepId,
  stepsOf,
} from "../../adapter-base/pipeline-steps.js";
import {
  fillTemplate,
  notifyScript,
  templateValues,
} from "../../adapter-base/pipeline-template.js";

/**
 * Adapter Jenkins (§5.5 CI/CD, Plan #36) — họ Helm (chart `jenkins`) + lớp bọc CI/CD.
 *
 * Jenkins không có webhook RA gốc, nên `Jenkinsfile` mà UDP sinh ký thân bằng HMAC-SHA256 trong
 * `X-UDP-Signature: sha256=…` (QĐ-6). Registry mà pipeline đẩy image tới vào biến toàn cục
 * `UDP_REGISTRY` qua Configuration-as-Code — đọc từ binding `registry.oci`, không đoán. Mật khẩu
 * admin là bí mật của tool; home của Jenkins trên PVC ⇒ `maxStorageGb`.
 */

export const jenkinsConfigSchema = z.object({
  adminUser: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{2,31}$/)
    .default("admin"),
  adminPassword: z.string().min(12).describe("secret"),
  storageGb: z.number().int().min(5).max(500).default(20),
});

const base = createHelmBasedAdapter({
  domainType: "CICD",
  toolId: "jenkins",
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
  configSchema: jenkinsConfigSchema,
  chart: {
    name: "jenkins",
    version: "5.7.2",
    repo: "https://charts.jenkins.io",
  },
  releaseName: "udp-jenkins",
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: (config, ctx) => {
    const parsed = jenkinsConfigSchema.parse(config);
    const registry = registryRefOf(ctx.resolved);
    return {
      controller: {
        admin: { username: parsed.adminUser },
        installPlugins: [
          "kubernetes",
          "workflow-aggregator",
          "git",
          "configuration-as-code",
          "credentials-binding",
        ],
        JCasC: {
          configScripts: {
            "udp-registry": [
              "jenkins:",
              "  globalNodeProperties:",
              "  - envVars:",
              "      env:",
              "      - key: UDP_REGISTRY",
              `        value: "${registry}"`,
            ].join("\n"),
          },
        },
      },
      persistence: { size: `${String(parsed.storageGb)}Gi` },
    };
  },
  secretValues: (config) => ({
    controller: {
      admin: { password: jenkinsConfigSchema.parse(config).adminPassword },
    },
  }),

  bindings: () => [
    {
      id: "pipeline.trigger",
      version: "1.0.0",
      providedBy: "cicd:jenkins",
      attributes: { provider: "jenkins" },
    },
  ],
});

const notify = (status: "success" | "failure"): string[] => [
  "      sh '''",
  `        export UDP_STATUS=${status}`,
  "        export COMMIT_SHA=$GIT_COMMIT COMMIT_TS= PIPELINE_ID=$BUILD_TAG",
  "        export REPO=$JOB_NAME REF=$BRANCH_NAME ACTOR=jenkins",
  ...(status === "success" ? [] : ['        export IMAGE_REF=""']),
  ...notifyScript('-H "X-UDP-Signature: sha256=$SIG"').map(
    (line) => `        ${line}`,
  ),
  "      '''",
];

/** Credential Jenkins mang tên kebab của biến: `AWS_ACCESS_KEY_ID` ⇒ `aws-access-key-id` */
const credentialId = (name: string): string =>
  name.toLowerCase().replaceAll("_", "-");

/**
 * Bước của domain khác là một stage chạy `docker run` trên agent. Bí mật đi qua
 * `withCredentials` (credential kiểu "secret text" cùng tên kebab) — không bao giờ nằm trong
 * Jenkinsfile.
 */
const stepStages = (steps: readonly PipelineStep[]): string[] =>
  steps.flatMap((step) => {
    // Nhiều dòng: dòng lệnh kết thúc bằng nháy đơn, dính vào `'''` là Groovy đóng chuỗi sớm
    const run = (indent: string) => [
      `${indent}sh '''`,
      `${indent}  ${dockerRunLine(step)}`,
      `${indent}'''`,
    ];
    return [
      `    stage('${stepId(step)}') {`,
      "      steps {",
      ...(step.secretEnv.length === 0
        ? run("        ")
        : [
            `        withCredentials([${step.secretEnv
              .map(
                (name) =>
                  `string(credentialsId: '${credentialId(name)}', variable: '${name}')`,
              )
              .join(", ")}]) {`,
            ...run("          "),
            "        }",
          ]),
      "      }",
      "    }",
    ];
  });

const jenkinsfile = (params: PipelineTemplateParams): string[] => [
  "// Jenkinsfile — sinh bởi UDP (Golden Path, §11)",
  "// Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
  "pipeline {",
  "  agent any",
  "  environment {",
  "    UDP_TRACKED_FLAGS = '%FLAGS%'",
  '    IMAGE_REF = "%IMAGE%:${env.GIT_COMMIT}"',
  "    UDP_ENVIRONMENT = \"${env.BRANCH_NAME == 'main' ? '%PROD%' : env.BRANCH_NAME}\"",
  "    UDP_WEBHOOK_URL = credentials('udp-webhook-url')",
  "    UDP_WEBHOOK_SECRET = credentials('udp-webhook-secret')",
  "  }",
  "  stages {",
  "    stage('Test') { steps { sh 'npm ci && npm test' } }",
  ...stepStages(stepsOf(params, "before-build")),
  "    stage('Build và đẩy image') {",
  '      steps { sh \'docker build -t "$IMAGE_REF" . && docker push "$IMAGE_REF"\' }',
  "    }",
  ...stepStages(stepsOf(params, "after-build")),
  "  }",
  "  post {",
  "    success {",
  ...notify("success"),
  "    }",
  "    failure {",
  ...notify("failure"),
  "    }",
  "  }",
  "}",
];

const adapter: CicdDomainAdapter = createCicdAdapter({
  base,
  verifySignature: (headers, rawBody, secret) =>
    verifyHmacHeader(headers, rawBody, secret, "X-UDP-Signature", "sha256="),
  renderPipelineTemplate: (params) =>
    fillTemplate(jenkinsfile(params), templateValues(params)),
});

export default adapter;

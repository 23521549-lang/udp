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
  publicEnvOf,
  stepId,
  stepsOf,
} from "../../adapter-base/pipeline-steps.js";
import {
  fillTemplate,
  notifyScript,
  templateValues,
} from "../../adapter-base/pipeline-template.js";
import {
  AUTH_DIR,
  BUILDER_SERVICE_ACCOUNT,
  BUILD_NAMESPACE,
  inClusterBuildContainers,
  WORK_DIR,
  type BuildContainer,
} from "../../adapter-base/packaging/build-script.js";
import { buildNamespaceCompanion } from "../../adapter-base/packaging/build-namespace.js";
import { BUILD_TOOLCHAIN } from "@udp/config";

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
      // [Plan #61 QĐ-12] Pod build ở `udp-build`, không ở `udp-system` cạnh bí mật của nền tảng; chart tạo Role
      // `schedule-agents` ở namespace này cho SA của controller
      agent: { namespace: BUILD_NAMESPACE },
    };
  },
  companions: [buildNamespaceCompanion],
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
  "      container('udp-notify') {",
  "        sh '''",
  "          apk add --no-cache jq curl openssl >/dev/null",
  `          export UDP_STATUS=${status}`,
  "          export COMMIT_SHA=$GIT_COMMIT COMMIT_TS= PIPELINE_ID=$BUILD_TAG",
  "          export REPO=$JOB_NAME REF=$BRANCH_NAME ACTOR=jenkins",
  ...(status === "success" ? [] : ['          export IMAGE_REF=""']),
  ...notifyScript('-H "X-UDP-Signature: sha256=$SIG"').map(
    (line) => `          ${line}`,
  ),
  "        '''",
  "      }",
];

/** Credential Jenkins mang tên kebab của biến: `AWS_ACCESS_KEY_ID` ⇒ `aws-access-key-id` */
const credentialId = (name: string): string =>
  name.toLowerCase().replaceAll("_", "-");

/** Bọc `body` trong `withCredentials` khi có biến bí mật — credential kiểu "secret text" cùng tên kebab */
const withSecrets = (
  names: readonly string[],
  indent: string,
  body: string[],
): string[] =>
  names.length === 0
    ? body
    : [
        `${indent}withCredentials([${names
          .map(
            (name) =>
              `string(credentialsId: '${credentialId(name)}', variable: '${name}')`,
          )
          .join(", ")}]) {`,
        ...body.map((line) => `  ${line}`),
        `${indent}}`,
      ];

/** Một lệnh `sh` nhiều dòng trong container — kịch bản không có backslash hay ba nháy đơn (luật của build-script) */
const shIn = (
  container: string,
  indent: string,
  script: string[],
): string[] => [
  `${indent}container('${container}') {`,
  `${indent}  sh '''`,
  ...script.map((line) => `${indent}    ${line}`),
  `${indent}  '''`,
  `${indent}}`,
];

/**
 * [Plan #61 QĐ-12] Pod của mỗi lượt chạy, ở namespace `udp-build` (giá trị `agent.namespace` của chart), chạy bằng
 * `udp-builder`. Container nào không bắt buộc UID chạy bằng root: bước `sh` của Jenkins ghi tệp điều khiển vào
 * `$WORKSPACE@tmp`, các container khác UID làm hỏng nhau (BuildKit giữ UID 1000 — cùng UID với `jnlp`).
 */
const podYaml = (
  params: PipelineTemplateParams,
  build: readonly BuildContainer[],
): string[] => {
  const steps = [
    ...stepsOf(params, "before-build"),
    ...stepsOf(params, "after-build"),
  ];
  const containers: {
    name: string;
    image: string;
    runAsUser: number;
    unconfined: boolean;
    env: [string, string][];
  }[] = [
    {
      name: "udp-test",
      image: "%TEST_IMAGE%",
      runAsUser: 0,
      unconfined: false,
      env: [],
    },
    ...steps.map((step) => ({
      name: stepId(step),
      image: step.image,
      runAsUser: 0,
      unconfined: false,
      env: publicEnvOf(step),
    })),
    ...build.map((c) => ({
      name: c.name,
      image: c.image,
      runAsUser: c.runAsUser ?? 0,
      unconfined: c.unconfined,
      env: Object.entries(c.env).sort(([a], [b]) => a.localeCompare(b)),
    })),
    {
      name: "udp-notify",
      image: BUILD_TOOLCHAIN.images.alpine,
      runAsUser: 0,
      unconfined: false,
      env: [],
    },
  ];
  return [
    "apiVersion: v1",
    "kind: Pod",
    "spec:",
    `  serviceAccountName: ${BUILDER_SERVICE_ACCOUNT}`,
    "  volumes:",
    "    - name: udp",
    "      emptyDir: {}",
    "    - name: udp-auth",
    "      emptyDir: {}",
    "  containers:",
    ...containers.flatMap((c) => [
      `    - name: ${c.name}`,
      `      image: ${c.image}`,
      // Container đứng chờ; Jenkins chạy từng `sh` vào nó
      "      command: [cat]",
      "      tty: true",
      "      securityContext:",
      `        runAsUser: ${String(c.runAsUser)}`,
      ...(c.unconfined
        ? [
            "        seccompProfile: { type: Unconfined }",
            "        appArmorProfile: { type: Unconfined }",
          ]
        : []),
      ...(c.env.length === 0
        ? []
        : [
            "      env:",
            ...c.env.flatMap(([k, v]) => [
              `        - name: ${k}`,
              `          value: '${v}'`,
            ]),
          ]),
      "      volumeMounts:",
      `        - { name: udp, mountPath: ${WORK_DIR} }`,
      `        - { name: udp-auth, mountPath: ${AUTH_DIR} }`,
    ]),
  ];
};

/** Bước của domain khác: chạy trong container của nó trong pod; bí mật qua `withCredentials` */
const stepStages = (steps: readonly PipelineStep[]): string[] =>
  steps.flatMap((step) => [
    `    stage('${stepId(step)}') {`,
    "      steps {",
    ...withSecrets(
      step.secretEnv,
      "        ",
      shIn(stepId(step), "        ", step.commands),
    ),
    "      }",
    "    }",
  ]);

const jenkinsfile = (params: PipelineTemplateParams): string[] => {
  const build = inClusterBuildContainers(params.build, "jenkins", {
    image: "%IMAGE%",
    commit: "$GIT_COMMIT",
  });
  return [
    "// Jenkinsfile — sinh bởi UDP (Golden Path, §11)",
    "// Rollout: %ROLLOUT% — deploy chỉ áp image, flag vẫn tắt; bật dần flag trên Portal",
    "pipeline {",
    "  agent {",
    "    kubernetes {",
    "      yaml '''",
    ...podYaml(params, build),
    "'''",
    "    }",
    "  }",
    "  environment {",
    "    UDP_TRACKED_FLAGS = '%FLAGS%'",
    "    UDP_ENVIRONMENT = \"${env.BRANCH_NAME == 'main' ? '%PROD%' : env.BRANCH_NAME}\"",
    "    UDP_WEBHOOK_URL = credentials('udp-webhook-url')",
    "    UDP_WEBHOOK_SECRET = credentials('udp-webhook-secret')",
    "  }",
    "  stages {",
    "    stage('Test') {",
    "      steps {",
    // `IMAGE_REF` gán bằng `env.` (không trong `environment`): sau build nó đổi thành ảnh có digest
    '        script { env.IMAGE_REF = "%IMAGE%:${env.GIT_COMMIT}" }',
    ...shIn("udp-test", "        ", ["%TEST%"]),
    "      }",
    "    }",
    ...stepStages(stepsOf(params, "before-build")),
    "    stage('Build và đẩy image') {",
    "      steps {",
    ...build.flatMap((c) =>
      withSecrets(c.secretEnv, "        ", shIn(c.name, "        ", c.script)),
    ),
    // [Plan #61 QĐ-7] Bước sau build và bước báo UDP dùng đúng digest vừa đẩy
    "        container('udp-digest') {",
    `          script { env.IMAGE_REF = sh(script: 'cat ${WORK_DIR}/out/image-ref', returnStdout: true).trim() }`,
    "        }",
    "      }",
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
};

const adapter: CicdDomainAdapter = createCicdAdapter({
  base,
  verifySignature: (headers, rawBody, secret) =>
    verifyHmacHeader(headers, rawBody, secret, "X-UDP-Signature", "sha256="),
  renderPipelineTemplate: (params) =>
    fillTemplate(jenkinsfile(params), templateValues(params)),
});

export default adapter;

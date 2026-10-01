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
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import {
  publicEnvOf,
  stepId,
  stepsOf,
} from "../../adapter-base/pipeline-steps.js";
import {
  fillTemplate,
  notifyScript,
  rebaseTimeOf,
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
import { inClusterRebaseContainers } from "../../adapter-base/packaging/rebase-script.js";
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

/** [Plan #61 QĐ-13] Stage của lượt build — lượt theo lịch (TimerTrigger) chỉ chạy stage rebase */
const NOT_ON_TIMER = "      when { not { triggeredBy 'TimerTrigger' } }";

/** Bước của domain khác: chạy trong container của nó trong pod; bí mật qua `withCredentials` */
const stepStages = (
  steps: readonly PipelineStep[],
  rebase: boolean,
): string[] =>
  steps.flatMap((step) => [
    `    stage('${stepId(step)}') {`,
    ...(rebase ? [NOT_ON_TIMER] : []),
    "      steps {",
    ...withSecrets(
      step.secretEnv,
      "        ",
      shIn(stepId(step), "        ", step.commands),
    ),
    "      }",
    "    }",
  ]);

/**
 * Container của pod chạy được một container của lượt rebase: cùng image, cùng biến, cùng quyền — pod của Jenkins dựng
 * MỘT lần cho cả pipeline, nên lượt rebase dùng lại container sẵn có (không thêm container nào đứng chờ trong pod)
 */
function podContainerFor(
  c: BuildContainer,
  pod: readonly BuildContainer[],
): string {
  const same = pod.find(
    (p) =>
      p.image === c.image &&
      p.runAsUser === c.runAsUser &&
      p.unconfined === c.unconfined &&
      JSON.stringify(p.env) === JSON.stringify(c.env),
  );
  if (same === undefined) {
    throw new Error(`pod build không có container chạy được ${c.name}`);
  }
  return same.name;
}

/**
 * [Plan #61 QĐ-13] Stage của lượt theo lịch: rebase image Buildpacks của commit đầu `main`; ảnh có digest mới vào
 * `IMAGE_REF` — không phải Buildpacks thì `IMAGE_REF` rỗng và bước báo bỏ qua.
 */
const rebaseStage = (
  rebase: readonly BuildContainer[],
  pod: readonly BuildContainer[],
): string[] => [
  "    stage('Vá image nền (rebase)') {",
  "      when { triggeredBy 'TimerTrigger' }",
  "      steps {",
  "        script { env.UDP_KIND = 'rebase' }",
  ...rebase.flatMap((c) =>
    withSecrets(
      c.secretEnv,
      "        ",
      shIn(podContainerFor(c, pod), "        ", c.script),
    ),
  ),
  "        container('udp-digest') {",
  `          script { env.IMAGE_REF = sh(script: 'cat ${WORK_DIR}/out/image-ref 2>/dev/null || true', returnStdout: true).trim() }`,
  "        }",
  "      }",
  "    }",
];

/** Bước báo UDP của `post`: lượt theo lịch chỉ báo khi đã ra image mới, và không báo khi hỏng (không phải lần deploy) */
const notifyPost = (
  status: "success" | "failure",
  rebase: boolean,
): string[] => {
  if (!rebase) return notify(status);
  const when =
    status === "success"
      ? "env.UDP_KIND != 'rebase' || env.IMAGE_REF"
      : "env.UDP_KIND != 'rebase'";
  return [
    "      script {",
    `        if (${when}) {`,
    ...notify(status).map((line) => `    ${line}`),
    "        }",
    "      }",
  ];
};

const jenkinsfile = (params: PipelineTemplateParams): string[] => {
  const build = inClusterBuildContainers(params.build, "jenkins", {
    image: "%IMAGE%",
    commit: "$GIT_COMMIT",
  });
  const schedule = rebaseScheduleOf(params.build, params.projectSlug);
  const rebase =
    schedule === null
      ? null
      : inClusterRebaseContainers(params.build, "jenkins", {
          image: "%IMAGE%",
          commit: "$GIT_COMMIT",
        });
  const onTimer = rebase !== null;
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
    ...(schedule === null
      ? []
      : [
          `  // [Plan #61 QĐ-13] Vá image nền mỗi ngày ${rebaseTimeOf(schedule)} (giờ của Jenkins, mặc định UTC) — chỉ ở nhánh main`,
          "  triggers {",
          `    cron(env.BRANCH_NAME == 'main' ? '${schedule.cron}' : '')`,
          "  }",
        ]),
    "  stages {",
    "    stage('Test') {",
    ...(onTimer ? [NOT_ON_TIMER] : []),
    "      steps {",
    // `IMAGE_REF` gán bằng `env.` (không trong `environment`): sau build nó đổi thành ảnh có digest
    '        script { env.IMAGE_REF = "%IMAGE%:${env.GIT_COMMIT}" }',
    ...shIn("udp-test", "        ", ["%TEST%"]),
    "      }",
    "    }",
    ...stepStages(stepsOf(params, "before-build"), onTimer),
    "    stage('Build và đẩy image') {",
    ...(onTimer ? [NOT_ON_TIMER] : []),
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
    ...stepStages(stepsOf(params, "after-build"), onTimer),
    ...(rebase === null ? [] : rebaseStage(rebase, build)),
    "  }",
    "  post {",
    "    success {",
    ...notifyPost("success", onTimer),
    "    }",
    "    failure {",
    ...notifyPost("failure", onTimer),
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

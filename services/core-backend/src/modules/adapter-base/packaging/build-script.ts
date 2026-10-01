import {
  assertBuildPlanSafe,
  identityCloudOf,
  type BuildIdentity,
  type BuildPlan,
  type RegistryPush,
} from "@udp/adapter-core";
import { BUILD_TOOLCHAIN } from "@udp/config";

/**
 * [Plan #61 QĐ-4..QĐ-7] Các đoạn shell mà sáu CI/CD adapter dùng để build image — MỘT nơi viết, sáu cú pháp chỉ đặt
 * chúng vào chỗ (khối `run: |` của YAML, `sh '''…'''` của Groovy, `script: |` của Tekton).
 *
 * Luật ký tự: KHÔNG backslash, không nháy đơn lồng trong nháy đơn, không `%CHỮ_HOA%` (chỗ trống của template) — thì
 * không phải thoát ký tự ở cú pháp nào. Chuỗi lấy từ kế hoạch đã qua `assertBuildPlanSafe`.
 *
 * Hai môi trường:
 *  - **Máy có Docker** (GitHub Actions, GitLab với dịch vụ dind, CircleCI `machine`): `docker buildx` hay `pack`; CLI
 *    của cloud chạy bằng `docker run -i` và nhận JWT qua stdin — không bind mount, vì dind của GitLab không thấy tệp
 *    của job. Mật khẩu registry đi thẳng vào `docker login --password-stdin`, không bao giờ thành tệp.
 *  - **Trong cluster** (Jenkins, Tekton, Drone): các container của MỘT pod ở namespace `udp-build`, chung hai emptyDir —
 *    `/udp` (chiến lược, mã nguồn cho Buildpacks, kết quả) và `/udp-auth` (JWT, `config.json` của registry). Không gì
 *    nằm trong thư mục build: một `COPY . .` không bao giờ chép mật khẩu vào image.
 */

export const BUILD_NAMESPACE = "udp-build";
export const BUILDER_SERVICE_ACCOUNT = "udp-builder";
/** Thẻ cache trong CHÍNH repository image — hai định dạng cache khác nhau nên hai thẻ */
export const CACHE_TAG_BUILDKIT = "udp-cache-buildkit";
export const CACHE_TAG_BUILDPACKS = "udp-cache-cnb";
/** Hai emptyDir chung của pod build trong cluster */
export const WORK_DIR = "/udp";
export const AUTH_DIR = "/udp-auth";
/** Docker Hub: khoá trong `config.json` không phải `docker.io` */
const DOCKER_HUB_AUTH_KEY = "https://index.docker.io/v1/";

export type DockerHostCi = "github-actions" | "gitlab-ci" | "circleci";
export type InClusterCi = "jenkins" | "tekton" | "drone";
export type CiTool = DockerHostCi | InClusterCi;

/**
 * Cách đẩy THẬT ở một CI. `github-token` chỉ có nghĩa ở GitHub Actions — CI khác đẩy GHCR bằng token là secret.
 * CircleCI đẩy ACR bằng token của ACR: chủ thể JWT của CircleCI chứa id người chạy, mà federated credential của
 * Azure chỉ nhận chủ thể khớp đúng (QĐ-6).
 */
export function effectivePush(push: RegistryPush, ci: CiTool): RegistryPush {
  const basic = { kind: "basic", server: push.server } as const;
  if (push.kind === "github-token" && ci !== "github-actions") return basic;
  if (push.kind === "azure-acr" && ci === "circleci") return basic;
  return push;
}

/** Registry cần JWT ở CI này (đẩy bằng danh tính build) */
export const needsOidc = (plan: BuildPlan, ci: CiTool): boolean =>
  identityCloudOf(effectivePush(plan.push, ci).kind) !== null;

/**
 * `aud` của JWT mà cloud chấp nhận: AWS — client id của nhà cung cấp OIDC; GCP — audience mặc định của provider
 * Workload Identity; Azure — audience chuẩn của federated credential.
 */
export function oidcAudience(identity: BuildIdentity): string {
  switch (identity.cloud) {
    case "aws":
      return "sts.amazonaws.com";
    case "gcp":
      return `https://iam.googleapis.com/${identity.workloadIdentityProvider}`;
    case "azure":
      return "api://AzureADTokenExchange";
  }
}

/** Tên biến bí mật mà kiểu đăng nhập cần ở CI — Portal chỉ đúng các tên này */
export function registrySecretNames(push: RegistryPush, ci: CiTool): string[] {
  return effectivePush(push, ci).kind === "basic"
    ? ["UDP_REGISTRY_USERNAME", "UDP_REGISTRY_PASSWORD"]
    : [];
}

// ------------------------------------------------------------------------------------------- chung

/** Đặt `UDP_STRATEGY` theo chiến lược — `auto` xét Dockerfile của ĐÚNG commit đang build */
export function strategyLines(plan: BuildPlan): string[] {
  const dockerfile = dockerfilePath(plan);
  switch (plan.strategy) {
    case "auto":
      return [
        `if [ -f "${dockerfile}" ]; then UDP_STRATEGY=dockerfile; else UDP_STRATEGY=buildpacks; fi`,
        `echo "UDP build: $UDP_STRATEGY (co ${dockerfile} thi Dockerfile, khong thi Buildpacks)"`,
      ];
    case "dockerfile":
      return [
        `[ -f "${dockerfile}" ] || { echo "Cai dat dong goi ghim Dockerfile nhung khong thay ${dockerfile}"; exit 1; }`,
        "UDP_STRATEGY=dockerfile",
      ];
    case "buildpacks":
      return [
        "UDP_STRATEGY=buildpacks",
        'echo "UDP build: buildpacks (ghim trong cai dat dong goi)"',
      ];
  }
}

/** `<context>/<dockerfile>` — `./Dockerfile` khi context là gốc */
export const dockerfilePath = (plan: BuildPlan): string =>
  `${plan.context}/${plan.dockerfile}`;

/** Thư mục chứa Dockerfile và tên tệp — `buildctl` nhận hai thứ tách nhau */
function dockerfileParts(plan: BuildPlan): { dir: string; file: string } {
  const full = dockerfilePath(plan);
  const at = full.lastIndexOf("/");
  return { dir: full.slice(0, at), file: full.slice(at + 1) };
}

/** Lời nhắn khi registry của cloud chưa có danh tính build — bước đăng nhập dừng ở đây */
const missingIdentity = (plan: BuildPlan): string[] => [
  `echo "Chua co danh tinh build cho registry ${plan.push.server}: chay script trong muc Dong goi cua UDP roi dan ket qua vao do"`,
  "exit 1",
];

/**
 * Lệnh lấy mật khẩu registry của cloud, ĐỌC JWT từ `tokenFile` — chạy BÊN TRONG image CLI của cloud (máy có Docker:
 * sau khi `cat > tokenFile` từ stdin; trong cluster: tệp do bước xin token ghi). In mật khẩu ra stdout. `command`
 * KHÔNG có nháy đơn: trên máy có Docker nó nằm trong `sh -ec '…'`; giá trị cần nháy đi bằng `env` của container.
 */
function cloudPasswordCommand(
  plan: BuildPlan,
  tokenFile: string,
): { command: string; env: Record<string, string> } {
  const id = plan.identity;
  const push = plan.push;
  if (id === null) throw new Error("cloudPasswordCommand cần danh tính build");
  if (push.kind === "aws-ecr" && id.cloud === "aws") {
    // Đường web identity có sẵn của AWS CLI: tự `AssumeRoleWithWebIdentity` từ hai biến này
    return {
      command: `AWS_WEB_IDENTITY_TOKEN_FILE=${tokenFile} aws ecr get-login-password --region ${push.region}`,
      env: { AWS_ROLE_ARN: id.roleArn, AWS_ROLE_SESSION_NAME: "udp-build" },
    };
  }
  if (push.kind === "gcp" && id.cloud === "gcp") {
    // Tệp `external_account`: STS của Google đổi JWT lấy token, rồi mạo danh service account chỉ được đẩy image
    return {
      command: [
        'printf "%s" "$UDP_GCP_CRED" > /tmp/udp-gcp.json',
        "gcloud auth login --cred-file=/tmp/udp-gcp.json --quiet >/dev/null 2>&1",
        "gcloud auth print-access-token",
      ].join(" && "),
      env: { UDP_GCP_CRED: gcpCredential(id, tokenFile) },
    };
  }
  if (push.kind === "azure-acr" && id.cloud === "azure") {
    return {
      command: [
        `az login --service-principal --username ${id.clientId} --tenant ${id.tenantId} --federated-token "$(cat ${tokenFile})" --allow-no-subscriptions >/dev/null`,
        `az acr login --name ${push.registryName} --expose-token --output tsv --query accessToken 2>/dev/null`,
      ].join(" && "),
      env: {},
    };
  }
  throw new Error(
    `danh tính ${id.cloud} không đẩy được vào registry ${push.kind}`,
  );
}

/** Cấu hình `external_account` của Workload Identity Federation — JSON không bí mật */
function gcpCredential(
  id: Extract<BuildIdentity, { cloud: "gcp" }>,
  tokenFile: string,
): string {
  return JSON.stringify({
    type: "external_account",
    audience: `//iam.googleapis.com/${id.workloadIdentityProvider}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    credential_source: { file: tokenFile },
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${id.serviceAccount}:generateAccessToken`,
  });
}

/** Image CLI và tên người dùng của `docker login` theo registry của cloud */
function cloudCli(plan: BuildPlan): { image: string; username: string } {
  const images = BUILD_TOOLCHAIN.images;
  switch (plan.push.kind) {
    case "aws-ecr":
      return { image: images.awsCli, username: "AWS" };
    case "gcp":
      return { image: images.gcloud, username: "oauth2accesstoken" };
    case "azure-acr":
      return {
        image: images.azureCli,
        username: "00000000-0000-0000-0000-000000000000",
      };
    default:
      throw new Error(`${plan.push.kind} không phải registry của cloud`);
  }
}

// ------------------------------------------------------------------------------- máy có Docker

/** Lệnh lấy JWT vào `UDP_OIDC_TOKEN` theo CI — GitLab nhận sẵn từ `id_tokens` của job */
export function dockerHostOidcLines(
  ci: DockerHostCi,
  audience: string,
): string[] {
  switch (ci) {
    case "github-actions":
      // Cần `permissions: id-token: write` ở workflow
      return [
        `UDP_OIDC_TOKEN=$(curl -sSf -G --data-urlencode "audience=${audience}" -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL" | jq -r .value)`,
      ];
    case "gitlab-ci":
      return [
        ': "${UDP_OIDC_TOKEN:?job build thieu id_tokens UDP_OIDC_TOKEN}"',
      ];
    case "circleci":
      return [
        `UDP_OIDC_TOKEN=$(circleci run oidc get --claims '{"aud":"${audience}"}')`,
      ];
  }
}

/** Đăng nhập registry trên máy có Docker — mật khẩu đi thẳng vào `--password-stdin` */
export function dockerHostLoginLines(
  plan: BuildPlan,
  ci: DockerHostCi,
): string[] {
  const push = effectivePush(plan.push, ci);
  switch (push.kind) {
    case "basic":
      return [
        '[ -n "${UDP_REGISTRY_USERNAME:-}" ] && [ -n "${UDP_REGISTRY_PASSWORD:-}" ] || { echo "Thieu secret UDP_REGISTRY_USERNAME / UDP_REGISTRY_PASSWORD cua CI"; exit 1; }',
        `printf '%s' "$UDP_REGISTRY_PASSWORD" | docker login --username "$UDP_REGISTRY_USERNAME" --password-stdin ${push.server}`,
      ];
    case "github-token":
      // `GITHUB_TOKEN` của chính lượt chạy, quyền `packages: write` khai ở workflow
      return [
        `printf '%s' "$GITHUB_TOKEN" | docker login --username "$GITHUB_ACTOR" --password-stdin ${push.server}`,
      ];
    default: {
      if (plan.identity === null) return missingIdentity(plan);
      const cli = cloudCli(plan);
      const password = cloudPasswordCommand(plan, "/tmp/udp-oidc");
      const envFlags = Object.entries(password.env).map(
        ([k, v]) => `-e ${k}='${v}'`,
      );
      return [
        ...dockerHostOidcLines(ci, oidcAudience(plan.identity)),
        [
          `printf '%s' "$UDP_OIDC_TOKEN" |`,
          "docker run --rm -i",
          ...envFlags,
          `--entrypoint sh ${cli.image}`,
          `-ec 'cat > /tmp/udp-oidc && ${password.command}' |`,
          `docker login --username ${cli.username} --password-stdin ${push.server}`,
        ].join(" "),
      ];
    }
  }
}

/**
 * Build và đẩy trên máy có Docker; đặt `UDP_DIGEST` rồi `UDP_IMAGE_REF="<image>:<commit>@<digest>"` (QĐ-7). `tmp` là
 * thư mục tạm NGOÀI repo (`$RUNNER_TEMP` của GitHub, `/tmp` ở CI khác).
 */
export function dockerHostBuildLines(
  plan: BuildPlan,
  ci: DockerHostCi,
  vars: { image: string; commit: string; tmp: string },
): string[] {
  assertBuildPlanSafe(plan);
  const { image, commit, tmp } = vars;
  const tag = `${image}:${commit}`;
  const pack = BUILD_TOOLCHAIN.pack;
  const packUrl = `https://github.com/buildpacks/pack/releases/download/v${pack.version}/pack-v${pack.version}-linux.tgz`;
  return [
    "set -eu",
    `UDP_TMP="${tmp}"`,
    'mkdir -p "$UDP_TMP"',
    ...strategyLines(plan),
    ...dockerHostLoginLines(plan, ci),
    'if [ "$UDP_STRATEGY" = dockerfile ]; then',
    // Máy chạy giữ lại builder (runner tự host, lượt chạy lại): dùng lại thay vì dừng pipeline
    "  docker buildx create --name udp-build --driver docker-container --use >/dev/null 2>&1 || docker buildx use udp-build",
    [
      "  docker buildx build",
      `--platform ${plan.platform}`,
      `--file "${dockerfilePath(plan)}"`,
      `--tag "${tag}"`,
      "--push",
      "--sbom=true --provenance=mode=max",
      `--cache-from "type=registry,ref=${image}:${CACHE_TAG_BUILDKIT}"`,
      `--cache-to "type=registry,ref=${image}:${CACHE_TAG_BUILDKIT},mode=max,image-manifest=true,oci-mediatypes=true"`,
      '--metadata-file "$UDP_TMP/build-meta.json"',
      `"${plan.context}"`,
    ].join(" "),
    `  UDP_DIGEST=$(${digestFromBuildkit('"$UDP_TMP/build-meta.json"')})`,
    "else",
    `  curl -fsSL -o "$UDP_TMP/pack.tgz" "${packUrl}"`,
    `  echo "${pack.linuxSha256}  $UDP_TMP/pack.tgz" | sha256sum -c -`,
    '  tar -xzf "$UDP_TMP/pack.tgz" -C "$UDP_TMP" pack',
    // Bản sao không có .git: lịch sử repo không vào image
    '  rm -rf "$UDP_TMP/app" && mkdir -p "$UDP_TMP/app"',
    `  tar -C "${plan.context}" --exclude=./.git -cf - . | tar -C "$UDP_TMP/app" -xf -`,
    [
      '  "$UDP_TMP/pack" build',
      `"${tag}"`,
      `--builder ${BUILD_TOOLCHAIN.images.builder}`,
      "--trust-builder",
      '--path "$UDP_TMP/app"',
      `--platform ${plan.platform}`,
      "--publish",
      `--cache-image "${image}:${CACHE_TAG_BUILDPACKS}"`,
      '--report-output-dir "$UDP_TMP/report"',
    ].join(" "),
    `  UDP_DIGEST=$(${digestFromReport('"$UDP_TMP/report/report.toml"')})`,
    "fi",
    '[ -n "$UDP_DIGEST" ] || { echo "Khong doc duoc digest cua image vua day"; exit 1; }',
    `UDP_IMAGE_REF="${tag}@$UDP_DIGEST"`,
    'echo "UDP image: $UDP_IMAGE_REF"',
  ];
}

/** Digest trong tệp `--metadata-file` của BuildKit — không backslash, không jq */
const digestFromBuildkit = (file: string): string =>
  `grep -o '"containerimage.digest": *"sha256:[0-9a-f]*"' ${file} | grep -oE 'sha256:[0-9a-f]{64}' | head -n 1`;

/** Digest trong `report.toml` của lifecycle (`[image] digest = "sha256:…"`) */
const digestFromReport = (file: string): string =>
  `grep -E '^ *digest *= *"sha256:' ${file} | grep -oE 'sha256:[0-9a-f]{64}' | head -n 1`;

// -------------------------------------------------------------------------------- trong cluster

/** Một container của pod build trong cluster — mỗi CI đặt nó thành container của pod template, step, hay task step */
export interface BuildContainer {
  /** Tên DNS-label, duy nhất trong pod */
  name: string;
  image: string;
  /** Shell script, mỗi phần tử một dòng */
  script: string[];
  /**
   * UID mà container BẮT BUỘC chạy (`null` = mặc định của image). Jenkins chạy mọi container `null` bằng root: bước
   * `sh` của nó ghi tệp điều khiển vào `$WORKSPACE@tmp`, nên các container khác UID làm hỏng nhau. Builder Buildpacks
   * chạy bằng root vẫn an toàn: `creator` đọc thông tin đăng nhập, đổi chủ thư mục rồi tự hạ quyền xuống UID của
   * builder (`priv.RunAs` của lifecycle).
   */
  runAsUser: number | null;
  /** BuildKit không root: seccomp và AppArmor `Unconfined` (mẫu Kubernetes của dự án BuildKit) */
  unconfined: boolean;
  env: Record<string, string>;
  /** TÊN biến bí mật mà CI phải đưa vào container này */
  secretEnv: string[];
}

/**
 * Các container build trong cluster, theo thứ tự: chuẩn bị → (xin token → đăng nhập) → build Dockerfile → build
 * Buildpacks → digest. Hai bước build tự bỏ qua khi chiến lược không phải của mình — nên mọi CI chạy CÙNG một
 * dãy, không phải rẽ nhánh theo cú pháp của nó. Bước cuối ghi `/udp/out/image-ref`.
 */
export function inClusterBuildContainers(
  plan: BuildPlan,
  ci: InClusterCi,
  vars: { image: string; commit: string },
): BuildContainer[] {
  assertBuildPlanSafe(plan);
  const images = BUILD_TOOLCHAIN.images;
  const { image, commit } = vars;
  const tag = `${image}:${commit}`;
  const user = BUILD_TOOLCHAIN.builderUser;
  const parts = dockerfileParts(plan);
  const push = effectivePush(plan.push, ci);
  const container = (
    c: Partial<BuildContainer> &
      Pick<BuildContainer, "name" | "image" | "script">,
  ): BuildContainer => ({
    runAsUser: null,
    unconfined: false,
    env: {},
    secretEnv: [],
    ...c,
  });

  const prepare = container({
    name: "udp-prepare",
    image: images.alpine,
    runAsUser: 0,
    script: [
      "set -eu",
      `mkdir -p ${WORK_DIR}/out ${WORK_DIR}/app ${WORK_DIR}/layers ${WORK_DIR}/platform`,
      `chmod 0777 ${WORK_DIR}/out`,
      ...strategyLines(plan),
      `echo "$UDP_STRATEGY" > ${WORK_DIR}/strategy`,
      'if [ "$UDP_STRATEGY" = buildpacks ]; then',
      // Builder chạy bằng UID của nó và xây ngay trong thư mục ứng dụng: bản sao riêng, không .git
      `  tar -C "${plan.context}" --exclude=./.git -cf - . | tar -C ${WORK_DIR}/app -xf -`,
      `  chown -R ${String(user.uid)}:${String(user.gid)} ${WORK_DIR}/app ${WORK_DIR}/layers ${WORK_DIR}/platform`,
      "fi",
    ],
  });

  const login: BuildContainer[] = [];
  if (push.kind === "basic") {
    login.push(
      container({
        name: "udp-login",
        image: images.alpine,
        secretEnv: ["UDP_REGISTRY_USERNAME", "UDP_REGISTRY_PASSWORD"],
        script: [
          "set -eu",
          '[ -n "${UDP_REGISTRY_USERNAME:-}" ] && [ -n "${UDP_REGISTRY_PASSWORD:-}" ] || { echo "Thieu secret UDP_REGISTRY_USERNAME / UDP_REGISTRY_PASSWORD"; exit 1; }',
          ...dockerConfigLines(
            push.server,
            'printf "%s:%s" "$UDP_REGISTRY_USERNAME" "$UDP_REGISTRY_PASSWORD"',
          ),
        ],
      }),
    );
  } else if (plan.identity === null) {
    login.push(
      container({
        name: "udp-login",
        image: images.alpine,
        script: missingIdentity(plan),
      }),
    );
  } else {
    const cli = cloudCli(plan);
    const tokenFile = `${AUTH_DIR}/oidc-token`;
    const password = cloudPasswordCommand(plan, tokenFile);
    login.push(
      container({
        name: "udp-token",
        image: images.curl,
        script: tokenRequestLines(oidcAudience(plan.identity), tokenFile),
      }),
      container({
        name: "udp-login",
        image: cli.image,
        env: password.env,
        script: [
          "set -eu",
          `UDP_PASSWORD=$(${password.command})`,
          ...dockerConfigLines(
            push.server,
            `printf "%s:%s" "${cli.username}" "$UDP_PASSWORD"`,
          ),
        ],
      }),
    );
  }

  const skipUnless = (wanted: string, other: string): string =>
    `[ "$(cat ${WORK_DIR}/strategy)" = ${wanted} ] || { echo "Bo qua: build bang ${other}"; exit 0; }`;

  const dockerfile = container({
    name: "udp-build-dockerfile",
    image: images.buildkit,
    runAsUser: BUILD_TOOLCHAIN.buildkitUser.uid,
    unconfined: true,
    env: {
      BUILDKITD_FLAGS: "--oci-worker-no-process-sandbox",
      DOCKER_CONFIG: AUTH_DIR,
    },
    script: [
      "set -eu",
      skipUnless("dockerfile", "Buildpacks"),
      [
        "buildctl-daemonless.sh build",
        "--frontend dockerfile.v0",
        `--local context=${plan.context}`,
        `--local dockerfile=${parts.dir}`,
        `--opt filename=${parts.file}`,
        `--opt platform=${plan.platform}`,
        "--opt attest:sbom=",
        "--opt attest:provenance=mode=max",
        `--import-cache type=registry,ref=${image}:${CACHE_TAG_BUILDKIT}`,
        `--export-cache type=registry,ref=${image}:${CACHE_TAG_BUILDKIT},mode=max,image-manifest=true,oci-mediatypes=true`,
        `--output type=image,name=${tag},push=true`,
        `--metadata-file ${WORK_DIR}/out/build-meta.json`,
      ].join(" "),
    ],
  });

  const buildpacks = container({
    name: "udp-build-buildpacks",
    image: images.builder,
    env: {
      CNB_PLATFORM_API: BUILD_TOOLCHAIN.cnbPlatformApi,
      DOCKER_CONFIG: AUTH_DIR,
    },
    script: [
      "set -eu",
      skipUnless("buildpacks", "Dockerfile"),
      [
        "/cnb/lifecycle/creator",
        `-uid=${String(user.uid)}`,
        `-gid=${String(user.gid)}`,
        `-app=${WORK_DIR}/app`,
        `-layers=${WORK_DIR}/layers`,
        `-platform=${WORK_DIR}/platform`,
        `-cache-image=${image}:${CACHE_TAG_BUILDPACKS}`,
        `-report=${WORK_DIR}/out/report.toml`,
        `"${tag}"`,
      ].join(" "),
    ],
  });

  const digest = container({
    name: "udp-digest",
    image: images.alpine,
    script: [
      "set -eu",
      `if [ -f ${WORK_DIR}/out/build-meta.json ]; then`,
      `  UDP_DIGEST=$(${digestFromBuildkit(`${WORK_DIR}/out/build-meta.json`)})`,
      "else",
      `  UDP_DIGEST=$(${digestFromReport(`${WORK_DIR}/out/report.toml`)})`,
      "fi",
      '[ -n "$UDP_DIGEST" ] || { echo "Khong doc duoc digest cua image vua day"; exit 1; }',
      `echo "${tag}@$UDP_DIGEST" > ${WORK_DIR}/out/image-ref`,
      `echo "UDP image: $(cat ${WORK_DIR}/out/image-ref)"`,
    ],
  });

  return [prepare, ...login, dockerfile, buildpacks, digest];
}

/** Ghi `config.json` của registry vào `/udp-auth` — `credential` là lệnh in `user:password` */
function dockerConfigLines(server: string, credential: string): string[] {
  const key = server === "docker.io" ? DOCKER_HUB_AUTH_KEY : server;
  return [
    `UDP_AUTH=$(${credential} | base64 -w 0)`,
    `printf '{"auths":{"%s":{"auth":"%s"}}}' "${key}" "$UDP_AUTH" > ${AUTH_DIR}/config.json`,
    `chmod 0644 ${AUTH_DIR}/config.json`,
  ];
}

/**
 * Xin JWT cho ServiceAccount `udp-builder` với `aud` của cloud (TokenRequest) bằng chính token của pod — Role trong
 * `udp-build` chỉ cho SA đó xin token của CHÍNH nó. Không cần annotation nào trên SA, không cần UDP ghi vào cluster.
 */
function tokenRequestLines(audience: string, file: string): string[] {
  const body = JSON.stringify({
    apiVersion: "authentication.k8s.io/v1",
    kind: "TokenRequest",
    spec: { audiences: [audience], expirationSeconds: 3600 },
  });
  return [
    "set -eu",
    "SA=/var/run/secrets/kubernetes.io/serviceaccount",
    [
      "curl -sSf",
      '--cacert "$SA/ca.crt"',
      '-H "Authorization: Bearer $(cat $SA/token)"',
      '-H "Content-Type: application/json"',
      "-X POST",
      `"https://kubernetes.default.svc/api/v1/namespaces/${BUILD_NAMESPACE}/serviceaccounts/${BUILDER_SERVICE_ACCOUNT}/token"`,
      `-d '${body}'`,
      `| grep -oE '"token": ?"[^"]+"' | sed -E 's/^"token": ?"//; s/"$//' > ${file}`,
    ].join(" "),
    `[ -s ${file} ] || { echo "Khong xin duoc token cua ServiceAccount ${BUILDER_SERVICE_ACCOUNT}"; exit 1; }`,
    `chmod 0644 ${file}`,
  ];
}

// ----------------------------------------------------------------------------------------- test

/**
 * Lệnh và image của bước test (QĐ-9). `skip` in một câu rõ ràng; `missing` dừng pipeline với lời nhắn — pipeline
 * xanh mà không test gì tệ hơn pipeline đỏ nói rõ thiếu gì.
 */
export function testStep(plan: BuildPlan): { command: string; image: string } {
  switch (plan.test.kind) {
    case "run":
      return { command: plan.test.command, image: plan.test.image };
    case "skip":
      return {
        command: "echo Buoc test bi tat trong cai dat dong goi cua UDP",
        image: BUILD_TOOLCHAIN.images.alpine,
      };
    case "missing":
      return {
        command: `echo Chua co lenh test cho ngon ngu ${plan.test.language} - khai trong muc Dong goi cua UDP && exit 1`,
        image: BUILD_TOOLCHAIN.images.alpine,
      };
  }
}

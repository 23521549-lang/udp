import {
  assertBuildPlanSafe,
  type BuildIdentity,
  type BuildPlan,
} from "@udp/adapter-core";
import { BUILD_TOOLCHAIN, SIGNING_CONFIG_JSON } from "@udp/config";
import {
  AUTH_DIR,
  dockerHostOidcLines,
  gcpCredential,
  oidcAudience,
  tokenRequestLines,
  WORK_DIR,
  type BuildContainer,
  type DockerHostCi,
} from "./build-script.js";

/**
 * [Plan #61 QĐ-14] Ký image sau khi build (và sau rebase) bằng khoá KMS trong cloud của CHÍNH project — cùng luật ký
 * tự với `build-script.ts`.
 *
 *  - Bundle Sigstore v0.3 (`cosign sign`, mặc định của cosign v3): referrer OCI, registry thiếu API referrers thì tag dự
 *    phòng. Không Rekor công khai: signing config không khai dịch vụ nào.
 *  - Chữ ký tương thích simple signing (`compat`) cho podman/skopeo/bootc/CRI-O: `cosign sign-blob` trên nội dung simple
 *    signing rồi `oras push` vào tag `sha256-<hex>.sig` — không cờ sắp bỏ, không `cosign attach` (bị xoá ở v4).
 *  - Annotation ĐƯỢC KÝ (subject của in-toto statement): project, commit, nhánh, lượt chạy, thời điểm ký — cổng deploy
 *    của Service 1 kiểm chúng.
 *  - Bundle ra `UDP_SIGNATURE_B64` (một dòng) — bước báo UDP gửi kèm.
 */

/** Đầu vào của bước ký — mọi giá trị là biểu thức shell (trừ `image`, `project`) */
export interface SignVars {
  /** Repository của image, không tag (`ghcr.io/acme/web`) */
  image: string;
  /** Biểu thức ra digest `sha256:…` của image vừa đẩy */
  digest: string;
  project: string;
  commit: string;
  /** Tên nhánh (không `refs/heads/`) */
  ref: string;
  run: string;
}

/** Tải cosign (và oras khi ký tương thích) vào `$UDP_TMP`, kiểm sha256 */
export function signToolLines(compat: boolean): string[] {
  const { cosign, oras } = BUILD_TOOLCHAIN;
  return [
    `curl -fsSL -o "$UDP_TMP/cosign" "https://github.com/sigstore/cosign/releases/download/v${cosign.version}/cosign-linux-amd64"`,
    `echo "${cosign.linuxSha256}  $UDP_TMP/cosign" | sha256sum -c -`,
    'chmod +x "$UDP_TMP/cosign"',
    ...(compat
      ? [
          `curl -fsSL -o "$UDP_TMP/oras.tgz" "https://github.com/oras-project/oras/releases/download/v${oras.version}/oras_${oras.version}_linux_amd64.tar.gz"`,
          `echo "${oras.linuxSha256}  $UDP_TMP/oras.tgz" | sha256sum -c -`,
          'tar -xzf "$UDP_TMP/oras.tgz" -C "$UDP_TMP" oras',
        ]
      : []),
    `printf '%s' '${SIGNING_CONFIG_JSON}' > "$UDP_TMP/signing-config.json"`,
  ];
}

/**
 * Biến môi trường để cosign gọi KMS bằng thông tin đăng nhập ngắn hạn của lượt chạy — JWT nằm ở `tokenFile` (ngoài
 * thư mục build). SDK của từng cloud tự đổi JWT lấy token: AWS web identity, GCP `external_account`, Azure workload
 * identity.
 */
export function kmsCredentialLines(
  identity: BuildIdentity,
  tokenFile: string,
  region: string,
): string[] {
  switch (identity.cloud) {
    case "aws":
      return [
        `export AWS_ROLE_ARN=${identity.roleArn} AWS_ROLE_SESSION_NAME=udp-sign AWS_WEB_IDENTITY_TOKEN_FILE=${tokenFile} AWS_REGION=${region}`,
      ];
    case "gcp":
      return [
        `printf '%s' '${gcpCredential(identity, tokenFile)}' > ${tokenFile}.json`,
        `export GOOGLE_APPLICATION_CREDENTIALS=${tokenFile}.json`,
      ];
    case "azure":
      return [
        `export AZURE_CLIENT_ID=${identity.clientId} AZURE_TENANT_ID=${identity.tenantId} AZURE_FEDERATED_TOKEN_FILE=${tokenFile}`,
      ];
  }
}

/** Ký: bundle (và chữ ký tương thích khi `compat`); ra `UDP_SIGNATURE_B64`. Cần cosign/oras đã tải và quyền KMS */
export function signLines(
  key: string,
  compat: boolean,
  vars: SignVars,
): string[] {
  const target = `${vars.image}@${vars.digest}`;
  const annotations = [
    `-a dev.udp.project=${vars.project}`,
    `-a dev.udp.commit=${vars.commit}`,
    `-a dev.udp.ref=${vars.ref}`,
    `-a dev.udp.run=${vars.run}`,
    '-a dev.udp.issued-at="$UDP_ISSUED_AT"',
  ];
  return [
    "UDP_ISSUED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    [
      '"$UDP_TMP/cosign" sign --yes',
      `--key "${key}"`,
      '--signing-config "$UDP_TMP/signing-config.json"',
      '--bundle "$UDP_TMP/signature.json"',
      ...annotations,
      `"${target}"`,
    ].join(" "),
    ...(compat ? compatLines(key, vars) : []),
    'UDP_SIGNATURE_B64=$(base64 -w 0 < "$UDP_TMP/signature.json")',
    `echo "UDP signed: ${target}"`,
  ];
}

/** Chữ ký simple signing ở tag `sha256-<hex>.sig` — cách podman/skopeo/bootc/CRI-O tìm chữ ký */
function compatLines(key: string, vars: SignVars): string[] {
  return [
    `UDP_DIGEST_HEX=$(printf '%s' "${vars.digest}" | sed 's/^sha256://')`,
    [
      `printf '{"critical":{"identity":{"docker-reference":"%s"},"image":{"docker-manifest-digest":"%s"},"type":"cosign container image signature"},"optional":{"dev.udp.project":"%s","dev.udp.commit":"%s","dev.udp.ref":"%s","dev.udp.run":"%s","dev.udp.issued-at":"%s"}}'`,
      `"${vars.image}" "${vars.digest}" "${vars.project}" "${vars.commit}" "${vars.ref}" "${vars.run}" "$UDP_ISSUED_AT"`,
      '> "$UDP_TMP/simple-signing.json"',
    ].join(" "),
    [
      '"$UDP_TMP/cosign" sign-blob --yes',
      `--key "${key}"`,
      '--signing-config "$UDP_TMP/signing-config.json"',
      '--bundle "$UDP_TMP/simple-signing.bundle.json"',
      '"$UDP_TMP/simple-signing.json"',
    ].join(" "),
    'UDP_SIMPLE_SIG=$(jq -r .messageSignature.signature "$UDP_TMP/simple-signing.bundle.json")',
    `printf '{"simple-signing.json":{"dev.cosignproject.cosign/signature":"%s"}}' "$UDP_SIMPLE_SIG" > "$UDP_TMP/simple-signing.annotations.json"`,
    `printf '%s' '{"architecture":"","os":"","config":{},"rootfs":{"type":"layers","diff_ids":[]}}' > "$UDP_TMP/simple-signing.config.json"`,
    [
      'cd "$UDP_TMP" && ./oras push',
      `"${vars.image}:sha256-$UDP_DIGEST_HEX.sig"`,
      "--config simple-signing.config.json:application/vnd.oci.image.config.v1+json",
      "--annotation-file simple-signing.annotations.json",
      "simple-signing.json:application/vnd.dev.cosign.simplesigning.v1+json",
      "&& cd - >/dev/null",
    ].join(" "),
  ];
}

/** Region của khoá AWS lấy từ ARN trong URI KMS (`awskms:///arn:aws:kms:<region>:…`) — SDK cần biết region */
export function kmsRegionOf(key: string): string {
  const m = /^awskms:\/\/\/arn:aws:kms:([a-z0-9-]+):/.exec(key);
  return m?.[1] ?? "";
}

/** Tệp JWT của bước ký trên máy có Docker — ngoài thư mục build, xoá khi xong */
const HOST_TOKEN_FILE = "/tmp/udp-sign-oidc";

/**
 * Bước ký trên máy có Docker (GitHub Actions, GitLab với dind, CircleCI): JWT của lượt chạy cho cloud của khoá ⇒
 * thông tin đăng nhập KMS ⇒ tải công cụ ⇒ ký. Đăng nhập registry phải có sẵn (`~/.docker/config.json`). Kế hoạch
 * không ký ⇒ không dòng nào.
 */
export function dockerHostSignLines(
  plan: BuildPlan,
  ci: DockerHostCi,
  vars: SignVars & { tmp: string },
): string[] {
  assertBuildPlanSafe(plan);
  const signing = plan.signing;
  if (signing === null) return [];
  return [
    "set -eu",
    `UDP_TMP="${vars.tmp}"`,
    'mkdir -p "$UDP_TMP"',
    ...dockerHostOidcLines(ci, oidcAudience(signing.identity)),
    `printf '%s' "$UDP_OIDC_TOKEN" > ${HOST_TOKEN_FILE}`,
    ...kmsCredentialLines(
      signing.identity,
      HOST_TOKEN_FILE,
      kmsRegionOf(signing.key),
    ),
    ...signToolLines(signing.compat),
    ...signLines(signing.key, signing.compat, vars),
    `rm -f ${HOST_TOKEN_FILE} ${HOST_TOKEN_FILE}.json`,
  ];
}

/** Chữ ký (bundle, base64 một dòng) mà bước báo UDP của CI trong cluster đọc */
export const SIGNATURE_FILE = `${WORK_DIR}/out/signature.b64`;

/**
 * Bước ký trong cluster (Jenkins, Tekton, Drone): MỘT container Alpine chạy bằng root, cùng image và biến với
 * `udp-prepare` — Jenkins chạy nó ngay trong container đó, pod không thêm container nào. Tự xin token ServiceAccount với
 * `aud` của cloud của khoá, đọc thông tin đăng nhập registry ở `/udp-auth`, ghi `/udp/out/signature.b64`. Chưa có
 * `/udp/out/image-ref` (lượt rebase không ra image mới) ⇒ dừng xanh.
 */
export function inClusterSignContainers(
  plan: BuildPlan,
  vars: Omit<SignVars, "digest">,
): BuildContainer[] {
  assertBuildPlanSafe(plan);
  const signing = plan.signing;
  if (signing === null) return [];
  const tokenFile = `${AUTH_DIR}/sign-token`;
  return [
    {
      name: "udp-sign",
      image: BUILD_TOOLCHAIN.images.alpine,
      runAsUser: 0,
      unconfined: false,
      env: {},
      secretEnv: [],
      script: [
        "set -eu",
        `[ -f ${WORK_DIR}/out/image-ref ] || { echo "Khong co image moi: khong ky"; exit 0; }`,
        "apk add --no-cache curl jq >/dev/null",
        `UDP_TMP=${WORK_DIR}/sign`,
        'mkdir -p "$UDP_TMP"',
        `export DOCKER_CONFIG=${AUTH_DIR}`,
        ...tokenRequestLines(oidcAudience(signing.identity), tokenFile).filter(
          (line) => line !== "set -eu",
        ),
        ...kmsCredentialLines(
          signing.identity,
          tokenFile,
          kmsRegionOf(signing.key),
        ),
        ...signToolLines(signing.compat),
        `UDP_DIGEST=$(sed 's/.*@//' ${WORK_DIR}/out/image-ref)`,
        ...signLines(signing.key, signing.compat, {
          ...vars,
          digest: "$UDP_DIGEST",
        }),
        `printf '%s' "$UDP_SIGNATURE_B64" > ${SIGNATURE_FILE}`,
        `rm -f ${tokenFile} ${tokenFile}.json`,
      ],
    },
  ];
}

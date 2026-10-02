/**
 * [Plan #61 QĐ-8] Công cụ mà pipeline UDP sinh ra dùng để build image của khách — MỘT chỗ ghim.
 *
 * Mọi image ghim theo digest (tag chỉ để người đọc biết phiên bản): tag đẩy đè được — sự cố Trivy 03/2026
 * (CVE-2026-33634) đẩy đè 75/76 tag của `trivy-action` để lấy cắp secret CI. Action của GitHub ghim theo SHA
 * 40 ký tự; `pack` tải bản phát hành rồi kiểm sha256. Chỉ dùng MỘT action bên thứ ba (`actions/checkout`):
 * mọi việc khác là lệnh shell và image ghim digest, nên bề mặt chuỗi cung ứng nhỏ nhất.
 *
 * Đổi phiên bản: sửa ở đây (đủ cả tag và digest), chạy lại test. `toolchain:check` báo khi có bản mới hơn.
 */

export const BUILD_TOOLCHAIN = {
  images: {
    /** BuildKit không root — build Dockerfile trong cluster bằng `buildctl-daemonless.sh` */
    buildkit:
      "moby/buildkit:v0.33.1-rootless@sha256:f8a833b2de9d68e27f0815e4a737abdfaf8a2e4c615650557df11025101557b4",
    /** Builder Paketo Ubuntu 24.04: .NET, Go, Java, Java Native Image, Node.js, PHP, Procfile, Python, Ruby, web tĩnh; amd64 + arm64 */
    builder:
      "paketobuildpacks/ubuntu-noble-builder:0.0.201@sha256:46786dec16ff7908c938b6a8153f3bf58babe0f73885beb477bff8a7a6fc8807",
    /** Docker CLI có buildx — job build của GitLab chạy trong image này cạnh dịch vụ dind */
    dockerCli:
      "docker:29.8.2-cli@sha256:b1805116a6a86cc591b5d5f60a910a0715cdcc9d18d866ad68b1457ead25c35c",
    dockerDind:
      "docker:29.8.2-dind@sha256:7dcdfc4a20246236f558175182ccace1eb15a41bd3eb119dd2284f393498b7c1",
    awsCli:
      "amazon/aws-cli:2.37.8@sha256:420ab345e847291b541b45d989535f55bcff957c27fa1100fae4aa233e86398c",
    gcloud:
      "google/cloud-sdk:587.0.0-slim@sha256:7c2dbc4eeba1e500b788be19cae33599cefe3294949a62c034bd1c2002329f69",
    azureCli:
      "mcr.microsoft.com/azure-cli:2.90.0@sha256:e3768dde8142efa45d8f356a317aaac77abd7da15ba3719b0a150e9453f251db",
    /** Bước báo UDP và bước chuẩn bị (jq, curl, openssl cài lúc chạy từ kho của đúng bản Alpine này) */
    alpine:
      "alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6",
    /** Lấy mã nguồn trong Tekton */
    git: "alpine/git:v2.54.0@sha256:832b1cd1a271509f3d5272a1a62d4cb2ab1a53426ebde1f6c2cb7349f907dc6f",
    /** Xin token ServiceAccount (TokenRequest) trong cluster — curl kiểm chứng chỉ, wget của busybox thì không */
    curl: "curlimages/curl:8.22.0@sha256:58adaa4e8dca9c988bae2aba4ab3434a0bb2da16bbe3f92dec39ec7785166777",
  },
  pack: {
    version: "0.40.9",
    /** sha256 của `pack-v<version>-linux.tgz` công bố cạnh bản phát hành */
    linuxSha256:
      "dc0ee1e931cf8a106d7555a01a214864f9acb60b77adf15d69b74df4404758e9",
  },
  /**
   * [Plan #61 QĐ-14] Ký image (bundle Sigstore + chữ ký tương thích). Nâng cosign thì bản mới phải kéo
   * `sigstore/sigstore` ≥ v1.10.10: lỗi Azure KMS sigstore#2409 (ghép sai chữ ký EC) có từ v1.10.9; 3.1.3 dùng v1.10.8.
   */
  cosign: {
    version: "3.1.3",
    /** sha256 của `cosign-linux-amd64` công bố trong `cosign_checksums.txt` */
    linuxSha256:
      "4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71",
  },
  /** Gắn chữ ký tương thích vào registry — cosign khuyên dùng oras thay `cosign attach` (bị xoá ở v4) */
  oras: {
    version: "1.3.4",
    /** sha256 của `oras_<version>_linux_amd64.tar.gz` công bố trong `oras_<version>_checksums.txt` */
    linuxSha256:
      "f27adb935022d94df8dc77719c322dda592c78a0d57a6f7dcdd8d900b248c454",
  },
  actions: {
    checkout: {
      repo: "actions/checkout",
      version: "v7.0.1",
      sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
    },
  },
  /** Người dùng của builder Paketo (`CNB_USER_ID`/`CNB_GROUP_ID` trong cấu hình image) — `creator` chạy bằng nó */
  builderUser: { uid: 1001, gid: 1001 },
  /** Platform API mà `creator` nói — lifecycle 0.21.21 của builder nhận 0.7…0.15 */
  cnbPlatformApi: "0.14",
  /** BuildKit không root chạy bằng UID này (ảnh `-rootless`) */
  buildkitUser: { uid: 1000, gid: 1000 },
} as const;

/**
 * [Plan #61 QĐ-9] Image của bước test theo ngôn ngữ — chỉ những ngôn ngữ có lệnh test KHÔNG mơ hồ. Node.js và
 * Python khớp image của Dockerfile Golden Path.
 */
export const TEST_IMAGES = {
  nodejs:
    "node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402",
  python:
    "python:3.12.14-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f",
  go: "golang:1.27.1@sha256:e0174e51e81218523251d85d248a90d24c3d5e81543b4f07a5d66229397db190",
  "java-maven":
    "maven:3.9.16-eclipse-temurin-25@sha256:93b8a14ea2f412782e4e842651273b4d903e35cc496284f178fbbe2d67d00976",
  "java-gradle":
    "gradle:9.8.0-jdk25@sha256:30f0c2e94f2b91cffaa192cebc86f1ba8efc574b9a8e93b33164e5f2ed839c08",
  dotnet:
    "mcr.microsoft.com/dotnet/sdk:10.0.401@sha256:35d40304542c8689331f8cab17c65926cdf48fe711e289321d71924b230a7d29",
} as const;

/**
 * [Plan #61 QĐ-11] Kiến trúc CPU của node mà UDP dựng (t3/m5 của AWS, e2 của GCP, Dsv5 của Azure đều x86) — build
 * cho đúng kiến trúc này. Test của cloud adapter khẳng định mọi cỡ node là x86: thêm Graviton hay Ampere thì đỏ.
 */
export const NODE_ARCH = "amd64";
export const BUILD_PLATFORM = `linux/${NODE_ARCH}` as const;

/**
 * [Plan #61 QĐ-14] Signing config của cosign KHÔNG khai dịch vụ nào: không Fulcio, không Rekor, không TSA — ký bằng
 * khoá KMS, image riêng tư không lộ tên hay digest ra sổ minh bạch công khai. Đúng nội dung `cosign signing-config
 * create` sinh ra; đây là cách cosign v3 khuyên dùng thay cờ `--tlog-upload=false` (sắp bỏ).
 */
export const SIGNING_CONFIG_JSON =
  '{"mediaType":"application/vnd.dev.sigstore.signingconfig.v0.2+json","rekorTlogConfig":{},"tsaConfig":{}}';

/** `name:tag@sha256:<64 hex>` — dạng ghim mà test của toolchain và của template đòi */
export const PINNED_IMAGE =
  /^[a-z0-9.\-/]+(:[A-Za-z0-9_.-]+)?@sha256:[0-9a-f]{64}$/;

interface StepImageSpec {
  repo: string;
  /** Hậu tố của tag sau phiên bản (`-debug`) */
  tagSuffix: string;
  /** Dạng phiên bản người dùng ghi trong cấu hình domain (không gồm digest) */
  version: RegExp;
  /** Mặc định của cấu hình domain */
  latest: string;
  /** Phiên bản ⇒ digest của image (index đa kiến trúc khi nhà phát hành có) */
  pins: Readonly<Record<string, string>>;
}

/**
 * [Plan #61 QĐ-8] Image của bước pipeline mà domain khác góp (Plan #37: Terraform, Pulumi, Ansible, Checkov, Grype,
 * ZAP). Người dùng chọn PHIÊN BẢN trong cấu hình domain; UDP đổi nó thành image ghim digest ở bảng này. Phiên bản
 * ngoài bảng phải ghi kèm digest (`1.2.3@sha256:…`), nên bước nào cũng chạy đúng image đã kiểm.
 *
 * Bản mặc định cũ vẫn trong bảng: project đã lưu nó không bị nâng âm thầm (Terraform nâng định dạng state một chiều).
 * Pulumi: ba image theo runtime, CÙNG một tập phiên bản (test giữ điều đó).
 */
export const STEP_IMAGES = {
  grype: {
    repo: "anchore/grype",
    // Bản `-debug` có busybox: image thường dựng từ `scratch`, không có shell để chạy lệnh của bước
    tagSuffix: "-debug",
    version: /^v\d+\.\d+\.\d+$/,
    latest: "v0.119.0",
    pins: {
      "v0.119.0":
        "sha256:166001ed93ae8463acad508c746586ced665abe9d817ae452ed9b781ddb6cebb",
      "v0.84.0":
        "sha256:b33d2dd2c6895857a62b01a4468b1417313a418de2166d34ced0fac679ad63be",
    },
  },
  checkov: {
    repo: "bridgecrew/checkov",
    tagSuffix: "",
    version: /^\d+\.\d+\.\d+$/,
    latest: "3.3.22",
    pins: {
      "3.3.22":
        "sha256:617c76e3f9b1f7907ebca9abb6b9d746844edcb48e9bd775e4692c69c1c6ac47",
      "3.2.255":
        "sha256:4aeb6ec527837beb5507392074b56df946545ebb34b8da8855c6814d80b6944a",
    },
  },
  zap: {
    repo: "ghcr.io/zaproxy/zaproxy",
    tagSuffix: "",
    version: /^\d+\.\d+\.\d+$/,
    latest: "2.17.0",
    pins: {
      "2.17.0":
        "sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef",
      "2.15.0":
        "sha256:8dc78e39fafc3281ac2cf54eab05c3ea02721a1ea58f1c135f981a57f4e218b1",
    },
  },
  terraform: {
    repo: "hashicorp/terraform",
    tagSuffix: "",
    version: /^\d+\.\d+\.\d+$/,
    latest: "1.16.4",
    pins: {
      "1.16.4":
        "sha256:985cdc6c1d9b0a65b83377f666efd2f740b47f02ac55be1ced3d18f7d3b0e829",
      "1.9.8":
        "sha256:18f9986038bbaf02cf49db9c09261c778161c51dcc7fb7e355ae8938459428cd",
    },
  },
  "pulumi-nodejs": {
    repo: "pulumi/pulumi-nodejs",
    tagSuffix: "",
    version: /^\d+\.\d+\.\d+$/,
    latest: "3.267.0",
    pins: {
      "3.267.0":
        "sha256:5ddf68eab8e39f14dff483cc807906b59280f2bb3268450e2ee28928abb3d9f8",
      "3.136.1":
        "sha256:0b7bc2da68b6f3baf321937aad704c6df27c359a928ea9eafd8d3177b0b9c6df",
    },
  },
  "pulumi-python": {
    repo: "pulumi/pulumi-python",
    tagSuffix: "",
    version: /^\d+\.\d+\.\d+$/,
    latest: "3.267.0",
    pins: {
      "3.267.0":
        "sha256:07d7335ccd4254ad8f1e4841155d4862f7a1e964a0d0bd6f1488da2fba851c5e",
      "3.136.1":
        "sha256:ff2fd2753debc649d36b6cbfb251d6c7fde600bfec241a4abeba91d72ac98f87",
    },
  },
  "pulumi-go": {
    repo: "pulumi/pulumi-go",
    tagSuffix: "",
    version: /^\d+\.\d+\.\d+$/,
    latest: "3.267.0",
    pins: {
      "3.267.0":
        "sha256:2c896c3d58543bcc7b04812d6355492a8f795d6ce6dee2375a11ff3f7673720c",
      "3.136.1":
        "sha256:8971a3e15eebb161e5d5c5d1395ac671f1ee11c5adfacc10f5b48e222708e20a",
    },
  },
  ansible: {
    repo: "alpine/ansible",
    tagSuffix: "",
    version: /^\d+\.\d+\.\d+$/,
    latest: "2.21.0",
    pins: {
      "2.21.0":
        "sha256:514964555c1132eb1948078a95ac6d50c21a49d540fca73176e66828e6ad19ac",
      "2.18.1":
        "sha256:22227b578da3371267201879f44de86569e9b531db536e1d9d2b83aed35b6cfc",
    },
  },
} as const satisfies Record<string, StepImageSpec>;

export type StepImageTool = keyof typeof STEP_IMAGES;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Phiên bản trong cấu hình domain ⇒ phần tag và digest (digest ghi kèm thắng bảng), `null` khi không ghim được */
function stepPin(
  tool: StepImageTool,
  version: string,
): { version: string; digest: string } | null {
  const spec: StepImageSpec = STEP_IMAGES[tool];
  const at = version.indexOf("@");
  const bare = at >= 0 ? version.slice(0, at) : version;
  if (!spec.version.test(bare)) return null;
  const digest = at >= 0 ? version.slice(at + 1) : spec.pins[bare];
  return digest !== undefined && DIGEST.test(digest)
    ? { version: bare, digest }
    : null;
}

/** Phiên bản dùng được: có trong bảng, hay đúng dạng và ghi kèm digest */
export function isPinnedStepVersion(
  tool: StepImageTool,
  version: string,
): boolean {
  return stepPin(tool, version) !== null;
}

/** Phiên bản ⇒ `repo:tag@sha256:…` — schema của adapter đã chặn phiên bản không ghim được */
export function stepImage(tool: StepImageTool, version: string): string {
  const pin = stepPin(tool, version);
  if (pin === null) {
    throw new Error(`${tool}: phiên bản ${version} chưa ghim digest`);
  }
  const spec: StepImageSpec = STEP_IMAGES[tool];
  return `${spec.repo}:${pin.version}${spec.tagSuffix}@${pin.digest}`;
}

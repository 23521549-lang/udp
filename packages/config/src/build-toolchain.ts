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
      "amazon/aws-cli:2.37.7@sha256:95f8d1e6d31aaa16997d1406eb532b0ca6a9830fe8a859c37a0fd223f10959e5",
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

/** `name:tag@sha256:<64 hex>` — dạng ghim mà test của toolchain và của template đòi */
export const PINNED_IMAGE =
  /^[a-z0-9.\-/]+(:[A-Za-z0-9_.-]+)?@sha256:[0-9a-f]{64}$/;

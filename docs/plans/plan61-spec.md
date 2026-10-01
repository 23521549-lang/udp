# Plan #61 — Spec: đóng gói ứng dụng thành container

Ngày 01/10/2026. Đề xuất đã duyệt: `docs/plans/plan61-de-xuat-dong-goi.md` (hướng B, ký image cách (b), làm luôn plan
phát hành SDK — Plan #62). Người dùng: "duyệt hướng này, chọn b, duyệt 3".

## 1. Mục tiêu và tiêu chí đạt

Một project trên UDP, ở BẤT KỲ CI nào trong sáu CI và BẤT KỲ registry nào trong chín registry, đẩy được image của ứng
dụng viết bằng một ngôn ngữ phổ biến, không khoá dài hạn khi tránh được, rồi deploy đúng byte đã build.

| Mã   | Tiêu chí                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | Mọi ô (sáu CI × năm kiểu đăng nhập registry) sinh pipeline có bước đăng nhập trước bước đẩy; không ô nào để bí mật trong tệp pipeline |
| AC-2 | Repo có Dockerfile ⇒ BuildKit; không có ⇒ Buildpacks Paketo; ghim chiến lược được; quyết định lúc pipeline chạy                       |
| AC-3 | Jenkins, Tekton, Drone build trong namespace `udp-build`, không cần Docker daemon, không chạy trong `udp-system`; kaniko không còn    |
| AC-4 | Pipeline báo UDP `repo:<commit>@sha256:<digest>`; Service 1 áp đúng chuỗi đó; dạng cũ vẫn nhận                                        |
| AC-5 | Mọi image và action UDP chọn ghim theo digest/SHA; test chặn ghim theo tag                                                            |
| AC-6 | Bước test: mặc định theo ngôn ngữ khi lệnh không mơ hồ, khai được, tắt được tường minh; không có lệnh thì dừng như hôm nay            |
| AC-7 | SBOM ở cả hai chiến lược; provenance ở đường Dockerfile; image Buildpacks được rebase theo lịch                                       |
| AC-8 | Image được ký bằng khoá KMS trong cloud của khách; Kyverno (nếu bật) kiểm chữ ký ở namespace environment                              |
| AC-9 | Portal: mục "Đóng gói" nói UDP build thế nào và vì sao, đổi được cài đặt, hiện việc cần làm (secret, script danh tính) — hai ngôn ngữ |

## 2. Quyết định

**QĐ-1 — Bốn đợt.** 61a: chạy được thật (AC-1, AC-3, AC-4, AC-5). 61b: Buildpacks, cài đặt build, bước test, Portal
(AC-2, AC-6, AC-9). 61c: SBOM, provenance, rebase, job báo phiên bản (AC-7). 61d: ký và kiểm chữ ký (AC-8). Mỗi đợt
qua đủ cổng rồi mới commit.

**QĐ-2 — Ranh giới giao diện (E1).** `PipelineTemplateParams` thêm `build: BuildPlan` — một MỞ RỘNG BỐI CẢNH như
`environments` của D-P29, không đổi tên hay thêm phương thức của `CicdDomainAdapter`; `languageRuntime` giữ (tương
thích) nhưng bước test đọc `build.test`. Registry khai cách đẩy bằng THUỘC TÍNH của binding `registry.oci`
(`pushAuth` và tham số), không thêm export mới. E1 ghi một lần mở rộng bối cảnh.

**QĐ-3 — `BuildPlan` (thuần, `@udp/adapter-core`).**

```ts
interface BuildPlan {
  strategy: "auto" | "dockerfile" | "buildpacks";
  context: string; // thư mục build, tương đối, "." mặc định
  dockerfile: string; // tương đối với context
  platform: string; // "linux/amd64" (QĐ-11)
  push: RegistryPush;
  identity: BuildIdentity | null; // bắt buộc với registry của cloud (QĐ-6)
  test:
    | { kind: "run"; command: string; image: string }
    | { kind: "skip" }
    | { kind: "missing"; language: string };
}
```

61c thêm `rebase`, 61d thêm `signing`.

`RegistryPush` là `basic` | `github-token` | `aws-ecr` | `gcp` | `azure-acr`, kèm máy chủ và tham số của kiểu.
Service 1 dựng `BuildPlan` từ cài đặt build của project (QĐ-9), binding `registry.oci` và cấu hình của adapter CI.

**QĐ-4 — Chọn chiến lược lúc chạy.** `auto`: có `<context>/<dockerfile>` ⇒ BuildKit, không có ⇒ Buildpacks — một điều
kiện shell CHUNG cho cả sáu CI: máy có Docker rẽ nhánh trong một bước; trong cluster, bước chuẩn bị ghi chiến lược ra
`/udp/strategy` và hai bước build tự bỏ qua khi không phải lượt của mình (Tekton không cần `when`, Jenkins không cần
`fileExists`). Ghim `dockerfile` mà thiếu tệp ⇒ dừng với lời nhắn; ghim `buildpacks` ⇒ bỏ qua Dockerfile.

**QĐ-5 — Lệnh build.**

| Chiến lược | Máy có Docker (GitHub Actions, GitLab `docker:dind`, CircleCI `machine`)                                | Trong cluster (Jenkins, Tekton, Drone)                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Dockerfile | `docker buildx` với driver `docker-container`, `--push`, `--metadata-file` ⇒ digest                     | `buildctl-daemonless.sh` trong `moby/buildkit:<v>-rootless`, `--oci-worker-no-process-sandbox`, `--metadata-file` |
| Buildpacks | `pack build --publish` (tải bản phát hành ghim sha256), `--report-output-dir` ⇒ digest, `--cache-image` | `/cnb/lifecycle/creator` trong ảnh builder, chạy UID 1001, `-report` ⇒ digest, `-cache-image`                     |

Pod BuildKit: seccomp và AppArmor `Unconfined`, UID 1000 (đúng mẫu Kubernetes của dự án BuildKit). Drone không đặt được
seccomp cho từng bước nên bước BuildKit của Drone là `privileged` (BuildKit vẫn không root) và repo phải được đánh dấu
Trusted — ghi ở §16. Không còn kaniko.

**QĐ-6 — Đăng nhập registry: mọi CI lấy một JWT, đổi lấy mật khẩu ngắn hạn.**

| Kiểu           | Máy chủ                                                                            | Cách lấy mật khẩu                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `basic`        | Docker Hub, Harbor, Nexus, Artifactory; GHCR ngoài GitHub Actions; ACR từ CircleCI | Secret CI `UDP_REGISTRY_USERNAME` / `UDP_REGISTRY_PASSWORD` (ACR: token có quyền đẩy)                              |
| `github-token` | GHCR, GitHub Packages                                                              | GitHub Actions: `GITHUB_TOKEN` với `packages: write`; CI khác rơi về `basic`                                       |
| `aws-ecr`      | ECR                                                                                | `aws ecr get-login-password` với `AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE` (đường web identity của AWS CLI)   |
| `gcp`          | Artifact Registry                                                                  | Tệp `external_account` (Workload Identity Federation, mạo danh service account) ⇒ `gcloud auth print-access-token` |
| `azure-acr`    | ACR                                                                                | `az login --federated-token` ⇒ `az acr login --expose-token`                                                       |

JWT theo CI: GitHub — `ACTIONS_ID_TOKEN_REQUEST_*` (`permissions: id-token: write`); GitLab — `id_tokens`; CircleCI —
`CIRCLE_OIDC_TOKEN_V2`; Jenkins/Tekton/Drone — TokenRequest cho ServiceAccount `udp-builder` của namespace `udp-build`
(Role chỉ cho tự xin token của chính nó). CLI của cloud chạy trong image ghim digest (`docker run -i`, token qua stdin:
không bind mount — dind của GitLab không thấy tệp của job). Mật khẩu không bao giờ nằm trong thư mục build: máy có Docker
đi thẳng `docker login --password-stdin`; trong cluster ghi `config.json` vào emptyDir `/udp-auth` ngoài workspace.

Danh tính build là của khách: Portal sinh MỘT script cho cloud của registry (AWS CLI, gcloud, az) mà chủ tài khoản chạy
một lần (CloudShell) — tạo nhà cung cấp OIDC khi cần, vai trò hay service account hay managed identity chỉ tin đúng chủ
thể của CI (repo GitHub, project GitLab, project CircleCI, hay `system:serviceaccount:udp-build:udp-builder` trên issuer
của cluster), chỉ được đẩy vào đúng repository image; in ra một dòng JSON để dán vào Portal. UDP không tự mở tài khoản
cloud của khách cho một bên thứ ba và không cần thêm quyền IAM cho vai trò BYOC. Azure không nhận chủ thể đại diện nên
mỗi nhánh một federated credential; CircleCI + Azure không có chủ thể cố định ⇒ ACR dùng token (`basic`).

**QĐ-7 — Deploy theo digest.** Mỗi lượt ra digest; `IMAGE_REF="<image>:<commit>@<digest>"` trước các bước sau build và
bước báo UDP. `deployBodySchema` nhận thêm `:tag@sha256:…`; `tagOf` và `versionLabelOf` ưu tiên tag (commit) khi có cả
hai; job deploy áp nguyên chuỗi. `imageWithTag` của rollout SERVICE_LEVEL giữ nguyên (người dùng chọn tag).

**QĐ-8 — Ghim một chỗ.** `@udp/config` `BUILD_TOOLCHAIN`: mọi image UDP chọn (BuildKit, builder Paketo, CLI ba cloud,
`docker` cli/dind, `alpine`, `alpine/git`, image test theo ngôn ngữ) dạng `name:tag@sha256:…`, `pack` (phiên bản +
sha256 tệp tải), `actions/checkout` (SHA 40 ký tự). Test: mọi `uses:` trong pipeline sinh ra là SHA; mọi image do UDP
chọn có digest; bước của domain khác (Terraform, Pulumi, Ansible, Checkov, Grype, ZAP) và Dockerfile Golden Path cũng
ghim digest. Script `toolchain:check` đọc registry và GitHub, báo bản mới hơn (không tự đổi); CI chạy nó theo lịch tuần.

**QĐ-9 — Cài đặt build của project.** Cột `projects.build_settings` (JSONB, NULL = mặc định):
`{ strategy, context, dockerfile, language, test, identity }`. `language`: `nodejs | python | go | java-maven |
java-gradle | dotnet | ruby | php | static | other`, mặc định suy từ `languageRuntime` hay lần quét repo. `test`:
`default | custom(command, image) | none`. Lệnh mặc định chỉ cho Node.js, Python, Go, Maven, Gradle, .NET; `none` là
lựa chọn tường minh, pipeline in câu "bước test bị tắt trong cài đặt". `identity` là MÃ định danh không bí mật
(ARN vai trò AWS; tên provider Workload Identity + email service account GCP; client id + tenant id Azure) — schema chặn
mọi thứ trông như khoá. API: `GET /projects/:id/build` (VIEWER) trả cài đặt + dự đoán + việc cần làm + script danh tính;
`PUT /projects/:id/build` (MAINTAINER) đổi cài đặt, ghi nhật ký `project.build.update`.

**QĐ-10 — Quét repo.** Nhận thêm `go.mod`, `*.csproj`/`*.sln`/`*.fsproj`, `Gemfile`, `composer.json`, `Cargo.toml`,
trang tĩnh (`index.html` ở gốc, không có tệp ngôn ngữ), và Maven/Gradle tách nhau; phát hiện Dockerfile ở gốc. Finding
mới `packaging`: chiến lược dự đoán và lý do. Rust: Buildpacks Paketo không hỗ trợ ⇒ cần Dockerfile, finding nói rõ.

**QĐ-11 — Kiến trúc.** Mọi node UDP dựng là x86 (`t3`/`m5`, `e2`, `Dsv5`) và UDP chưa nhận cluster mang sẵn: build
`linux/amd64`. Hằng `NODE_ARCH = "amd64"` đặt cạnh bảng cỡ node của cloud adapter; test khẳng định mọi cỡ node là x86 —
thêm node Graviton/Ampere thì test đỏ, buộc sửa kế hoạch build.

**QĐ-12 — CI trong cluster.** Bộ nền dùng chung `adapter-base/packaging/build-namespace.ts`: release `raw` đi kèm dựng namespace
`udp-build` (không ResourceQuota, LimitRange mặc định đủ cho BuildKit, chặn ingress), ServiceAccount `udp-builder`, Role
cho nó tự xin token. Jenkins: `agent.namespace: udp-build`, pod template trong Jenkinsfile (container test, công cụ,
BuildKit, builder) — bước của domain khác thành container của pod thay cho `docker run`; container không bắt buộc UID
chạy bằng root vì bước `sh` của Jenkins ghi `$WORKSPACE@tmp` (builder vẫn hạ quyền: `creator` tự `RunAs` UID 1001). Drone:
`DRONE_NAMESPACE_DEFAULT` + `rbac.buildNamespaces` = `udp-build`, `service_account_name: udp-builder`. Tekton: task
`git-clone` nhúng (`alpine/git`), PipelineRun ở `udp-build` với `udp-builder`; cách tạo PipelineRun ghi trong tệp sinh ra
(Tekton Triggers chưa có — §16, có từ trước plan này); ảnh có digest sang task sau qua workspace, không qua result —
`finally` bị bỏ qua khi result của task hỏng vắng, mà bước báo UDP lúc hỏng phải chạy. Kyverno miễn trừ thêm `udp-build`.

**QĐ-13 — SBOM, provenance, rebase (61c).** Dockerfile: `--sbom=true --provenance=mode=max` (BuildKit lưu trong image
index — chạy cả với registry thiếu API referrers). Buildpacks: SBOM có sẵn trong image (Paketo: CycloneDX, SPDX, Syft).
Rebase: pipeline theo lịch (GitHub `schedule`; Jenkins `cron`; GitLab, CircleCI, Drone: lịch khai trong giao diện của CI,
pipeline nhận biết lượt theo lịch) chạy `/cnb/lifecycle/rebaser` lên image của commit đầu nhánh `main`; image không phải
Buildpacks ⇒ bỏ qua có lời nhắn; digest không đổi ⇒ không báo UDP; đổi ⇒ báo như một lần deploy production.

**QĐ-14 — Ký (61d, cách (b)).** Khoá KMS bất đối xứng trong cloud của registry (script danh tính tạo, cấp quyền `Sign`
cho đúng danh tính build). `cosign sign --key <awskms|gcpkms|azurekms>://…` lên digest vừa build, chứng thực ký bằng
chính thông tin đăng nhập cloud của bước đăng nhập. Khoá công khai (PEM, không bí mật) lưu ở cài đặt build; khi Kyverno
bật, UDP thêm `ClusterPolicy` `verifyImages` cho image của project ở namespace environment (Audit mặc định, Enforce là
lựa chọn). Registry không phải của cloud vẫn ký được nếu project có danh tính build ở một cloud.

**QĐ-15 — Bản xem thử và tài liệu.** Bản xem thử: mục "Đóng gói" với dữ liệu mẫu đủ trạng thái (tự động/Dockerfile/
Buildpacks, có/thiếu danh tính, test tắt, Rust cần Dockerfile). Tài liệu: §5.5, §8.3, §11, §12.2, §16, D-P54; sổ nợ.

## 3. Ngoài phạm vi (nêu rõ)

- Image đa kiến trúc (QĐ-11 giải thích vì sao chưa cần).
- Tự động tạo danh tính build bằng vai trò BYOC (QĐ-6 giải thích vì sao script).
- Tekton Triggers (tự chạy pipeline khi push) — giới hạn có từ trước, ghi §16.
- Nhiều image trong một project — mô hình hiện tại là một workload mỗi project.

## 4. Kiểm chứng

- Hợp đồng CI/CD mở rộng: mọi ô CI × kiểu đăng nhập × chiến lược; YAML của mọi template parse được; mọi khối shell qua
  `bash -n`; không bí mật trong tệp; thứ tự đăng nhập < build < sau-build < báo UDP; digest vào `IMAGE_REF`.
- Service 1: API build (quyền, nhật ký, schema chặn khoá), dựng `BuildPlan`, webhook dạng `tag@digest`, golden.
- Job CI `build-smoke` trong CI của UDP: build ứng dụng mẫu (Node.js, Python, Go, Maven, .NET, và một Dockerfile) bằng
  ĐÚNG khối shell mà renderer sinh, đẩy vào registry cục bộ, chạy image và gọi `/healthz`.
- Không chạy được ở đây (vào sổ nợ `cicd-webhook-real` mở rộng): GitLab, CircleCI, Jenkins, Tekton, Drone thật; OIDC
  thật với ba cloud; ký KMS thật; Kyverno `verifyImages` trên cluster thật.

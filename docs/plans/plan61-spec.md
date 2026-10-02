# Plan #61 — Spec: đóng gói ứng dụng thành container

Ngày 01/10/2026. Đề xuất đã duyệt: `docs/plans/plan61-de-xuat-dong-goi.md` (hướng B, ký image cách (b), làm luôn plan
phát hành SDK — Plan #62). Người dùng: "duyệt hướng này, chọn b, duyệt 3".

## 1. Mục tiêu và tiêu chí đạt

Một project trên UDP, ở BẤT KỲ CI nào trong sáu CI và BẤT KỲ registry nào trong chín registry, đẩy được image của ứng
dụng viết bằng một ngôn ngữ phổ biến, không khoá dài hạn khi tránh được, rồi deploy đúng byte đã build.

| Mã    | Tiêu chí                                                                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1  | Mọi ô (sáu CI × năm kiểu đăng nhập registry) sinh pipeline có bước đăng nhập trước bước đẩy; không ô nào để bí mật trong tệp pipeline                             |
| AC-2  | Repo có Dockerfile ⇒ BuildKit; không có ⇒ Buildpacks Paketo; ghim chiến lược được; quyết định lúc pipeline chạy                                                   |
| AC-3  | Jenkins, Tekton, Drone build trong namespace `udp-build`, không cần Docker daemon, không chạy trong `udp-system`; kaniko không còn                                |
| AC-4  | Pipeline báo UDP `repo:<commit>@sha256:<digest>`; Service 1 áp đúng chuỗi đó; dạng cũ vẫn nhận                                                                    |
| AC-5  | Mọi image và action UDP chọn ghim theo digest/SHA; test chặn ghim theo tag                                                                                        |
| AC-6  | Bước test: mặc định theo ngôn ngữ khi lệnh không mơ hồ, khai được, tắt được tường minh; không có lệnh thì dừng như hôm nay                                        |
| AC-7  | SBOM ở cả hai chiến lược; provenance ở đường Dockerfile; image Buildpacks được rebase theo lịch                                                                   |
| AC-8  | Mọi project deploy được đều ký image bằng khoá KMS ở cloud của CHÍNH project (bất kể registry); hai định dạng: bundle Sigstore và chữ ký tương thích podman/CRI-O |
| AC-9  | Portal: mục "Đóng gói" nói UDP build thế nào và vì sao, đổi được cài đặt, hiện việc cần làm (secret, script danh tính) — hai ngôn ngữ                             |
| AC-10 | Cổng deploy của UDP: image phải thuộc repo của project; chữ ký kiểm bằng khoá công khai, đúng digest, đúng commit/nhánh, không cũ hơn bản đang chạy               |
| AC-11 | Trusted Deploy: webhook mang token OIDC của chính lượt chạy, kiểm chữ ký nơi phát, gắn claim với cấu hình project, dùng MỘT lần                                   |
| AC-12 | Kyverno dòng 1.19 kiểm chữ ký lúc tạo pod (Audit/Deny), không thành điểm chết; luồng cập nhật có E2E và tự áp bản vá                                              |

## 2. Quyết định

**QĐ-1 — Sáu đợt.** 61a: chạy được thật (AC-1, AC-3, AC-4, AC-5). 61b: Buildpacks, cài đặt build, bước test, Portal
(AC-2, AC-6, AC-9). 61c: SBOM, provenance, rebase, job báo phiên bản (AC-7). 61d chia ba (duyệt 01/10/2026: phương án C, đã khắc phục
bốn điểm yếu): 61d-1 ký và cổng deploy (AC-8, AC-10), 61d-2 Trusted Deploy (AC-11), 61d-3 Kyverno (AC-12). Mỗi đợt
qua đủ cổng rồi mới commit.

**[02/10/2026] 61d-2 chia hai: 61d-2a và 61d-2b.** Quyết sau vòng QA soát kế hoạch 61d-2, vì một chặn cứng đã kiểm lại
bằng mã: đường Trusted Deploy cho ba CI chạy TRONG CỤM không làm được mà không chạm phía cụm, bằng cả hai lối hiện
thực. Lối TokenReview cần `authentication.k8s.io/tokenreviews: create` mà không ServiceAccount nào của §12.2 có (chữ
`tokenreviews` xuất hiện 0 lần trong thiết kế), cộng bootstrap lại mọi cụm đang chạy và một method mới trên
`ClusterAccess` (hôm nay `write()` trả `Promise<void>` nên không đọc được `status`). Lối JWKS-của-cụm thì Service 1
không lưu URL issuer của cụm ở đâu, mà mọi cụm lại có CÙNG một chủ thể `system:serviceaccount:udp-build:udp-builder`
nên chỉ issuer nhận diện được project — tức phải học và lưu issuer lúc provision, cũng chạm đường provisioning. Vì vậy:
**61d-2a** làm ba nhà cung cấp SaaS (GitHub Actions, GitLab CI, CircleCI) và không chạm cụm; **61d-2b** làm bộ ký trong
cụm cho CircleCI + Azure cùng Trusted Deploy cho ba CI trong cụm, và quyết lối nào ở đó. Tới hết 61d-2a, AC-11 đạt cho
ba CI SaaS; ba CI trong cụm giữ HMAC và Portal nói rõ "chưa khả dụng" kèm lý do.

**[03/10/2026] 61d-2b chia ba: 61d-2b-0, 61d-2b-1, 61d-2b-2.** Quyết sau vòng kiểm dữ kiện ngoài của kế hoạch
61d-2b, vì ba lý do đều là dữ kiện mới, không phải ước lượng lại. (1) Lượt kiểm phát hiện **một lỗi đang sống**: `sub`
của GitHub Actions đã đổi sang hình bất biến `repo:<owner>@<id>/<name>@<id>:ref:…` và **đã áp tự động từ 15/07/2026**
cho repo mới tạo, đổi tên hay chuyển chủ, mà script danh tính của UDP so theo hình cũ ở AWS và Azure ⇒ những repo đó
không đẩy và không ký được; vòng QA tìm thêm ba lỗ cùng họ trong chính tệp đó. Sửa lỗi đi trước tính năng, nên nó
thành **61d-2b-0**. (2) Lý do chặn cứng mà QĐ-1 nêu cho lối JWKS-của-cụm đã **không còn đúng**: ClusterRoleBinding
MẶC ĐỊNH của Kubernetes (`system:service-account-issuer-discovery` gắn cho nhóm `system:serviceaccounts`) cho mọi
ServiceAccount — kể cả `udp-tooling` — đọc `/openid/v1/jwks` trên API server, nên UDP kiểm được token SA mà **không**
thêm quyền nào, **không** bootstrap lại cụm, và **không** phải lưu issuer: nó buộc token vào project bằng KHOÁ của
cụm chứ không bằng chuỗi issuer. Đó là **61d-2b-1**. (3) Bộ ký trong cụm vẫn là lối duy nhất cho CircleCI + Azure
(tài liệu Microsoft 18/09/2026: FIC linh hoạt chỉ nhận GitHub, GitLab, Terraform Cloud), và nó là việc duy nhất trong
ba việc phải **GHI** vào cụm khách ⇒ **61d-2b-2**, với một điều phải công bố ngay từ spec: chữ ký do UDP đặt sau cổng
deploy **không** chứng minh nguồn gốc build, nó chỉ chứng minh "UDP đã cho phép byte này", và giá trị thật của nó là
để Kyverno (61d-3) có chữ ký mà kiểm lúc admission.

**[03/10/2026] 61d-3 làm TRƯỚC 61d-2b-2.** Quyết khi viết plan chi tiết cho 61d-2b-2 (R1), vì một dữ kiện kiểm
được: `cluster/bootstrap.ts` không cho `udp-tooling` một quyền `batch/jobs` nào và namespace `udp-build` chỉ tồn tại
ở project dùng CI trong cụm, nên bộ ký trong cụm đòi quyền mới trên cụm khách **cộng một lượt bootstrap lại mọi cụm
đang chạy** — đúng cái giá mà QĐ-1 đã từ chối cho lối TokenReview, lần này chỉ để mua một tổ hợp CI × cloud. AC-12
(Kyverno) là tiêu chí nghiệm thu nên đi trước; 61d-2b-2 giữ nguyên dòng giới hạn đã công bố ở §16 (không chữ ký,
image vẫn deploy, chế độ bắt buộc không bật được, mục Ký image nói đúng lý do) cho tới khi làm. Phân tích ba thiết kế
nằm ở `plan61-plan.md`.

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
ghim digest. Bước của domain khác: người dùng vẫn chọn PHIÊN BẢN trong cấu hình domain, `STEP_IMAGES` đổi nó thành image
ghim; bản ngoài bảng phải ghi kèm digest (`1.2.3@sha256:…`); bản mặc định cũ ở lại trong bảng để project đã lưu nó không
bị nâng âm thầm (Terraform nâng định dạng state một chiều); `assertSafe` của bước từ chối image không digest. Script `toolchain:check` đọc registry và GitHub, báo bản mới hơn (không tự đổi); CI chạy nó theo lịch tuần.

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

Rebase — vá lớp hệ điều hành của image Buildpacks mà không build lại:

- **Pipeline.** Lượt theo lịch chạy trên `main`: chọn chiến lược như lượt build (cùng điều kiện shell); không phải
  Buildpacks ⇒ in lời nhắn rồi dừng xanh. Đăng nhập như lượt build, rồi rebase TẠI CHỖ image của commit đầu `main`
  (`pack rebase --publish` trên máy có Docker; `/cnb/lifecycle/rebaser` trong cluster — cùng image builder ghim), đọc
  digest từ `report.toml`, báo UDP với `kind: "rebase"`. Rebase hỏng (vd. commit đầu chưa có image) ⇒ job đỏ, KHÔNG báo
  UDP: đó không phải một lần deploy hỏng, không được tính vào tỉ lệ lỗi thay đổi của DORA. Tag `<commit>` dời sang
  digest mới; digest cũ vẫn kéo được (không registry adapter nào đặt luật xoá image mất tag) nên deploy cũ và rollback
  không gãy.
- **UDP quyết, không phải pipeline.** Bản sửa so với bản đầu của QĐ này: pipeline không so digest, vì "commit đầu
  `main`" không nhất thiết là thứ đang chạy ở production (vừa rollback có chủ đích, hay lượt deploy cuối hỏng). Webhook
  `kind: "rebase"` chỉ nhận cho environment production, `status: success` có `imageRef`; UDP xem lần deploy MỚI NHẤT của
  workload ở production: đang chờ/chạy/hỏng/khôi phục ⇒ `skipped`; đã thành công với ĐÚNG image này ⇒ `unchanged`;
  thành công với cùng `repo:commit` mà digest khác ⇒ đi như một lần deploy webhook (tự deploy hay chờ duyệt theo
  `autoDeploy`), metadata ghi `kind: "rebase"`; commit khác ⇒ `skipped`. Hai trạng thái mới không ghi sự kiện nào (lịch
  chạy hằng ngày, không làm nhiễu lịch sử). Danh sách deployment có cờ `rebase`; Portal ghi "Vá image nền".
- **Lịch.** Giờ chạy hằng ngày tất định theo project (băm slug ⇒ 01:00–06:59 UTC, phút khác 0 — GitHub trễ lịch đầu
  giờ). GitHub Actions: `on.schedule` + `if` theo `github.event_name`; Jenkins: `triggers { cron }` chỉ ở nhánh `main`,
  `when { triggeredBy 'TimerTrigger' }`; GitLab (`CI_PIPELINE_SOURCE == "schedule"`), CircleCI
  (`pipeline.trigger_source == "scheduled_pipeline"`), Drone (sự kiện `cron`, tên `udp-rebase`): lịch khai trong giao
  diện của CI — mục Đóng gói chỉ đúng chỗ và giờ gợi ý. Tekton: Pipeline `udp-<slug>-rebase` khởi bằng `tkn` như lượt
  build (Tekton Triggers chưa có — §16, có từ trước plan này).
- Chiến lược ghim `dockerfile` ⇒ không sinh phần rebase. Image Dockerfile lấy bản vá bằng cách cập nhật `FROM` (Golden
  Path ghim digest, công cụ cập nhật phụ thuộc của repo đổi được).

`toolchain:check` (`@udp/config`): đọc mọi image ghim (`BUILD_TOOLCHAIN`, `TEST_IMAGES`, `STEP_IMAGES`, `FROM` của
Dockerfile Golden Path), `pack` và `actions/checkout`; báo tag đã bị đẩy lại (digest khác — thường là bản dựng lại có
bản vá), bản mới hơn cùng hậu tố (cùng major và mới nhất), SHA của action không khớp tag. Không tự sửa. Workflow riêng
chạy thứ Hai hằng tuần, đỏ khi có việc cần làm, ghi bảng vào tóm tắt của lượt chạy.

**QĐ-14 — Ký (61d-1).** Thay bản đầu (ký bằng danh tính của registry, Kyverno 1.12 kiểm). Rà lại, bản đầu có bốn điểm
yếu: định dạng cũ cần cờ cosign sắp bỏ; Kyverno 1.12 hết hỗ trợ và nằm ngoài ma trận Kubernetes 1.33+; project có registry
không thuộc cloud không ký được; đường deploy của UDP vẫn chỉ dựa vào secret tĩnh của webhook.

- **Danh tính ký ở cloud của CHÍNH project** (`CloudCredential.provider`) — project nào deploy được cũng có, nên project
  nào cũng ký được, bất kể registry. Một danh tính mỗi project (vai trò AWS / service account GCP / managed identity
  Azure) làm cả việc đẩy khi registry là của cloud đó; registry khác thì danh tính chỉ ký.
- **Khoá:** AWS KMS `ECC_NIST_P256` / `SIGN_VERIFY`, alias `alias/udp-sign-<slug>`; GCP Cloud KMS `EC_SIGN_P256_SHA256`,
  keyring `udp` ở region của project, khoá `udp-sign-<slug>`; Azure Key Vault (RBAC) khoá EC P-256 `udp-sign`. Quyền ký
  cấp cho ĐÚNG danh tính trên ĐÚNG khoá (`kms:Sign` + `kms:GetPublicKey`; `roles/cloudkms.signerVerifier`; "Key Vault
  Crypto User"). Script danh tính in thêm `signing: { key: <URI KMS>, publicKey: <PEM> }` — khoá công khai không bí mật.
- **Công cụ:** cosign 3.1.3 và oras, tải bản phát hành rồi kiểm sha256 (ghim ở `BUILD_TOOLCHAIN` như `pack`).
- **Không Rekor công khai, không cờ sắp bỏ:** tệp signing config không khai dịch vụ nào, đúng nội dung `cosign
signing-config create` sinh ra — `{"mediaType":"application/vnd.dev.sigstore.signingconfig.v0.2+json",
"rekorTlogConfig":{},"tsaConfig":{}}` (đã thử thật). Image riêng tư không lộ tên hay digest ra sổ công khai.
- **Hai chữ ký.** (1) Bundle Sigstore v0.3 (mặc định cosign v3): referrer OCI; registry thiếu API referrers (GHCR, Docker
  Hub) thì tag dự phòng `sha256-<hex>`. (2) Chữ ký tương thích simple signing cho podman/skopeo/bootc/CRI-O — thư viện của
  chúng chỉ đọc định dạng này (bản vá đọc bundle còn mở: container-libs#1153; #1111 chỉ đọc kiểu cũ qua referrers). UDP
  sinh nội dung simple signing, ký bằng `cosign sign-blob --key <KMS>` (lệnh ổn định; đã thử: chữ ký ECDSA trên SHA-256 của
  nội dung, `openssl` kiểm qua), gắn bằng `oras` vào tag `sha256-<hex>.sig`. Không dùng `--new-bundle-format=false` (sắp
  bỏ) hay `cosign attach` (bị xoá ở v4, cosign khuyên dùng oras). Cài đặt `signing.compat` bật sẵn.
- **Annotation ĐƯỢC KÝ** (đã thử: cosign v3 đặt `-a` vào subject của in-toto statement trong DSSE; sửa một annotation thì
  chữ ký trượt): `dev.udp.project`, `dev.udp.commit`, `dev.udp.ref`, `dev.udp.run`, `dev.udp.issued-at` (UTC).
- **Thứ tự:** build → bước sau build (quét lỗ hổng) → ký → báo UDP: chỉ image đã qua quét mới được ký. Rebase (QĐ-13) →
  ký lại digest mới → báo.
- **Thông tin đăng nhập KMS** là thông tin đăng nhập cloud ngắn hạn của chính lượt chạy (OIDC như bước đẩy): AWS
  `AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE`; GCP `GOOGLE_APPLICATION_CREDENTIALS` trỏ tệp `external_account`; Azure
  `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_FEDERATED_TOKEN_FILE`. Tệp JWT nằm ngoài thư mục build, xoá khi xong.
- **CircleCI + Azure** là tổ hợp duy nhất CI không federation trực tiếp được (`sub` của CircleCI chứa id người chạy;
  federated credential của Azure đòi khớp chính xác; bản "flexible" còn preview và chỉ nhận GitHub/GitLab/Terraform
  Cloud) ⇒ ký bằng bộ ký trong cụm (QĐ-17).

**QĐ-15 — Bản xem thử và tài liệu.** Bản xem thử: mục "Đóng gói" với dữ liệu mẫu đủ trạng thái (tự động/Dockerfile/
Buildpacks, có/thiếu danh tính, test tắt, Rust cần Dockerfile; lịch rebase theo từng CI; ký: chưa có khoá, đang chờ
lượt ký đầu, đã bắt buộc, CircleCI + Azure dùng bộ ký trong cụm; Trusted Deploy bật/chưa); lịch sử deployment có lượt
"Vá image nền", lần deploy đã kiểm chữ ký, lần bị từ chối vì chữ ký. Tài liệu: §5.5, §8.3, §11, §12.2, §16, D-P54;
sổ nợ.

**QĐ-16 — Cổng deploy của UDP (61d-1).**

- **Ràng buộc repo — mọi project:** webhook thành công phải mang image thuộc `<registryRef>/<slug>` (đúng `%IMAGE%` của
  pipeline). Sai ⇒ 422 và nhật ký `cicd.webhook.foreign-image`. Trước đây lộ secret webhook là deploy được image bất kỳ.
- **Kiểm chữ ký:** thân webhook thêm `signature` (bundle JSON). Service 1 kiểm bằng `@sigstore/verify` 4.1.2 với danh
  sách khoá công khai đã lưu (xoay khoá không gián đoạn), ngưỡng tlog/CT/timestamp = 0 — không cần Rekor, không gọi KMS
  (tránh đường lỗi sigstore#2409), không cần quyền đọc registry (đã thử: hợp lệ thì qua; sửa annotation hay khoá khác thì
  trượt). Đúng: predicate `https://sigstore.dev/cosign/sign/v1`; digest của subject = digest trong `imageRef`; `project` =
  slug; `commit` = `commitSha`; `ref` khớp nhánh của environment; `issued-at` không quá 24 giờ trước (lệch tương lai ≤ 5
  phút) và KHÔNG cũ hơn `issued-at` của lần deploy thành công hiện hành của environment. Quay về bản cũ chỉ qua Portal
  (có người, có nhật ký).
- **Chế độ bắt buộc** `signing.enforce`: tự bật khi nhận chữ ký hợp lệ đầu tiên (pipeline đã sinh lại có bước ký) — không
  làm gãy project đang chạy pipeline cũ, không phụ thuộc trí nhớ của người bảo trì. Đã bật: thiếu hay sai chữ ký ⇒ ghi
  `DEPLOY_FAILURE` có mã lý do, không gửi job, trả 422 cho CI (bước báo đỏ). Bật/tắt tay: `PUT
/projects/:id/build/signing-enforce` (MAINTAINER, nhật ký) — lưu cài đặt build không đổi được nó; tắt là tạm: chữ ký hợp
  lệ kế tiếp tự bật lại (muốn thôi ký hẳn thì gỡ khoá).
- Lần deploy ghi `signature: { keyId, issuedAt }`; danh sách deployment có trạng thái chữ ký (`VERIFIED`, mã từ chối hay
  không kiểm); Portal hiện "Đã kiểm chữ ký" hay lý do từ chối. Chi phí: UDP 0 đồng; khoá nằm ở KMS của khách (AWS KMS 1
  USD/khoá/tháng cộng 0,15 USD/10 000 lần ký, không thuộc gói miễn phí — đã đọc trang giá AWS 02/10/2026; GCP, Azure theo
  bảng giá của họ), Portal nói rõ.
- Phụ thuộc mới: `@sigstore/verify`, `@sigstore/bundle`, `@sigstore/core` (OpenSSF). Bản 4.x đòi Node `^22.22.2`: nâng
  `engines` của repo từ `>=22.12.0` lên `>=22.22.2` — cùng dòng LTS, bản vá bảo mật; máy ảo production chạy 22.23.3.

**QĐ-17 — Trusted Deploy (61d-2).** Mẫu tham khảo: PyPI Trusted Publishing (token OIDC ngắn hạn của CI thay secret tĩnh,
gắn claim với repo/workflow). UDP chặt hơn: token dùng MỘT lần.

- Webhook mang `Authorization: Bearer <JWT>` do chính lượt chạy xin, `aud` = địa chỉ webhook. Kiểm chữ ký JWT bằng JWKS
  của nơi phát (thư viện `jose`): GitHub `token.actions.githubusercontent.com`; GitLab (gitlab.com hay máy chủ tự host
  trong cấu hình); CircleCI `oidc.circleci.com/org/<orgId>`. CI trong cụm: token ServiceAccount `udp-builder`
  (TokenRequest, `aud` = webhook) kiểm bằng TokenReview trên cụm của project.
- Gắn claim với cấu hình project, KHÔNG lấy từ thân: GitHub `repository` + `workflow_ref` (`.github/workflows/udp.yml`)
  - `ref`; GitLab `project_path` + `ref`; CircleCI `oidc.circleci.com/project-id` + `vcs-ref`. Nhánh ⇒ environment theo
    luật của template; token của nhánh phụ không deploy được production.
- **Dùng một lần:** bảng `webhook_token_uses` (issuer, `jti` — CircleCI: job id) unique, ghi cùng transaction với sự kiện
  deploy; hàng hết hạn được dọn. `iat` không quá 10 phút trước.
- **Chế độ** `oidcRequired` (cấu hình domain CI/CD): tự bật khi nhận token hợp lệ đầu tiên; đã bật thì secret tĩnh một
  mình không đủ. Secret HMAC giữ để kiểm toàn vẹn thân.
- **Giới hạn còn lại, nói rõ:** token ServiceAccount của CI trong cụm chứng minh lời gọi đến từ cụm của project nhưng
  không mang nhánh — nhánh dựa vào cấu hình tin cậy của CI (Jenkins dùng Jenkinsfile của nhánh đích cho PR, Drone
  Trusted, Tekton không tự chạy PR); với Jenkins/Tekton/Drone, environment production mặc định chờ duyệt.
- **Bộ ký trong cụm** (CircleCI + Azure): sau khi Trusted Deploy xác minh lượt chạy, UDP chạy một Job ký ở namespace
  `udp-signing` của cụm AKS bằng ServiceAccount `udp-signer` (federated credential khớp chính xác). Chỉ control plane của
  UDP được tạo pod ở namespace đó — pod của CI không dùng được SA này. Job ký đúng digest với annotation lấy từ claim đã
  kiểm, trả bundle qua log; đẩy chữ ký vào ACR bằng danh tính workload (AcrPush), registry khác dùng Secret `udp-registry`
  ở `udp-signing` (Portal nhắc).

**QĐ-18 — Kyverno (61d-3).**

- Nâng adapter Kyverno lên chart 3.9.x (Kyverno 1.19.x, Kubernetes 1.33–1.35) và `kyverno-policies` cùng dòng; adapter
  2.0.0, project đang chạy nâng qua luồng §8.6 (validator → áp → kiểm sức khoẻ → tự hạ về bản cũ).
- `ImageValidatingPolicy` mỗi project (`udp-verify-<slug>`): image `<registryRef>/<slug>*` ở namespace environment của
  project; attestor cosign **khoá công khai tĩnh** (mọi khoá được chấp nhận) — Kyverno không cần quyền KMS, tránh
  sigstore#2409; `insecureIgnoreTlog`/`insecureIgnoreSCT` vì không dùng Rekor; quyền đọc registry theo loại (amazon/
  google/azure qua danh tính workload của Kyverno, Secret cho registry khác). Thông tin ký vào adapter bằng mở rộng bối
  cảnh `ctx.project.signing` (E1); đổi khoá ⇒ áp lại domain POLICY.
- **Không thành điểm chết** (bài học kyverno#16435: bộ kiểm sập ⇒ mọi pod bị chặn): Audit ⇒ `failurePolicy: Ignore`; Deny
  ⇒ `Fail` + miễn trừ namespace hệ thống + giới hạn thời gian chờ, và schema đòi ít nhất 2 bản sao.
- **Luồng cập nhật:** `toolchain:check` theo dõi cả chart Helm UDP ghim (Kyverno trước tiên); `--fix` mở pull request
  nâng ghim (người dùng gộp); pull request chạy E2E kiểm chữ ký trên kind. Bản vá tự áp theo lịch qua §8.6 (trả nợ "lịch
  nâng cấp" của §8.6); bản minor: Portal báo "có bản đã qua kiểm thử", MAINTAINER bấm nâng.
- Lớp 1 (QĐ-16) đứng độc lập: Kyverno trễ một bản không làm mất bảo đảm của đường deploy qua UDP.

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
- E2E ký (CI của UDP, GitHub Actions, 0 đồng): registry có API referrers (zot) và không có (distribution) — ký bằng ĐÚNG
  khối shell renderer sinh với khoá tệp ECDSA P-256 (cùng thuật toán với khoá KMS); kiểm bằng `cosign verify`, `skopeo` +
  `policy.json` `sigstoreSigned` (thư viện của podman/CRI-O/bootc) và bộ kiểm của Service 1; chữ ký sai, khoá khác,
  annotation bị sửa đều trượt. 61d-3 thêm cụm kind + Kyverno: image đã ký được tạo pod, chưa ký bị chặn (Deny) hay ghi
  nhận (Audit).
- Trusted Deploy: JWT ký bằng JWKS thử (GitHub/GitLab/CircleCI); sai `aud`, hết hạn, dùng lại, claim lệch cấu hình ⇒
  từ chối.
- Không chạy được ở đây (vào sổ nợ `cicd-webhook-real` mở rộng): GitLab, CircleCI, Jenkins, Tekton, Drone thật; OIDC
  thật với ba cloud; ký bằng KMS thật của ba cloud; quyền Kyverno đọc registry thật của cloud; bộ ký trong cụm AKS thật.

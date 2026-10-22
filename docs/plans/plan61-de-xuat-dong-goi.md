# Plan #61 — Đề xuất: đóng gói ứng dụng thành container (CHỜ DUYỆT, chưa sửa mã)

Người dùng (01/10/2026): "cái đóng gói ứng dụng thành container thì bạn có giải pháp nào mạnh và tối ưu không, không
làm hạ cấp dự án không để nợ kĩ thuật, bạn tự mình review check lại trước khi đề xuất cho tui nhá".

## 0. Cách làm

| Công cụ                     | Đóng góp                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `superpowers:brainstorming` | Quy trình của việc kiến trúc: khảo sát, các hướng, đề xuất, duyệt; chưa đụng mã                                                                           |
| Agent Explore               | Đọc trọn đường đi từ mã nguồn tới image tới cluster: Golden Path, quét repo, 6 adapter CI/CD, 9 adapter registry, job deploy, Portal                      |
| Agent nghiên cứu            | Khoảng 50 nguồn gốc (tài liệu chính thức, trang release trên GitHub, CNCF, nhà cung cấp); đo trực tiếp kiến trúc và dung lượng image qua API của registry |
| Tự kiểm lại trên nguồn gốc  | Bảy khẳng định quyết định hướng đi (mục 7)                                                                                                                |

## 1. Vì sao hôm nay "chưa đóng gói được" — đọc từ mã

Không chỉ thiếu ngôn ngữ: hai lỗi đầu khiến cả ứng dụng Node.js và Python cũng chưa đẩy được image khi chạy CI thật.
Chúng chưa lộ vì sáu template CI chưa từng chạy trên CI thật (sổ nợ `cicd-webhook-real`).

| #   | Hiện trạng                                                                                                                                                                                          | Hệ quả                                                                                                                                         | Chỗ trong mã                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| K1  | Sáu pipeline UDP sinh ra không có bước đăng nhập registry                                                                                                                                           | Đẩy image bị từ chối ở mọi registry riêng tư                                                                                                   | `cicd-adapter/github-actions/index.ts:111`, `gitlab-ci:146-152`, `circleci:103-115` |
| K2  | Ba CI chạy TRONG cluster (UDP cài bằng Helm): Jenkinsfile gọi `docker build` trên pod không có Docker; Tekton gọi Task `kaniko` không được cài và không có bước lấy mã; Drone dùng `plugins/kaniko` | Ba CI này không build được. kaniko đã bị Google lưu trữ (archived) ngày 03/06/2025                                                             | `jenkins/index.ts:175`, `tekton/index.ts:167-172`, `drone/index.ts:176-180`         |
| K3  | Chỉ hai Dockerfile mẫu (Node.js, Python); quét repo nhận Node.js, Python, Java, không nhận Go, .NET, Ruby, PHP, Rust                                                                                | Repo không có Dockerfile ở ngôn ngữ khác: không có đường nào                                                                                   | `packages/golden-path/src/render.ts:20`, `scan.ts:100-103`                          |
| K4  | Bước test chỉ có cho Node.js và Python; ngôn ngữ khác pipeline dừng (cố ý, đúng)                                                                                                                    | Không khai được lệnh test cho ngôn ngữ khác                                                                                                    | `adapter-base/pipeline-template.ts:31-49`                                           |
| K5  | Deploy theo tag (`:<commit>`), không theo digest; action ghim theo tag (`actions/checkout@v4`); image nền ghim theo tag; không SBOM, không provenance                                               | Tag đẩy đè được. Sự cố Trivy 03/2026 (CVE-2026-33634): 75/76 tag của `trivy-action` bị đẩy đè để lấy cắp secret CI                             | `pipeline-template.ts:68`, `cicd/workload.ts:166-195`, `templates/*/Dockerfile`     |
| K6  | Không tính kiến trúc CPU                                                                                                                                                                            | Đúng hôm nay (mọi node UDP dựng là x86: `t3`/`m5`, `e2`, `Dsv5`); khi cluster có node arm64 (Graviton, Ampere) thì pod kéo image sai kiến trúc | `packages/cloud-adapters/src/*/plan.ts`                                             |

Một phụ thuộc NGOÀI đóng gói (§16 đã ghi): ứng dụng Golden Path dùng `@udp/openfeature-provider` (npm) và
`udp-openfeature` (PyPI) chưa phát hành, nên `npm ci` / `pip install` trong Dockerfile hỏng khi repo nằm ngoài monorepo.
Xem mục 6.

## 2. Ba hướng

- **A. Thêm Dockerfile mẫu cho từng ngôn ngữ** (mở rộng cách hôm nay).
- **B. "Repo có Dockerfile thì dùng Dockerfile, không thì Buildpacks", build trong CI của khách** — đề xuất.
- **C. Build trong cluster của khách** (kpack hay Shipwright) làm mặc định.

|                         | A                                                                                           | B                                                                                                                                   | C                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Ngôn ngữ                | Mỗi ngôn ngữ một mẫu UDP tự viết, phải đoán framework (Spring hay Quarkus, Rails, Laravel…) | Paketo: Java (cả native image), Node.js, Python, Go, .NET, Ruby, PHP, web tĩnh (NGINX/HTTPD), Procfile; Dockerfile cho mọi thứ khác | Như B                                                               |
| Công UDP phải giữ       | N mẫu × image nền × framework: nợ tăng theo số ngôn ngữ                                     | Một builder ghim phiên bản; buildpack do dự án CNCF đã tốt nghiệp giữ                                                               | Controller và CRD trong MỌI cluster khách; một đường deploy thứ hai |
| Vá lỗ hổng hệ điều hành | Build lại mọi image                                                                         | `rebase`: thay lớp hệ điều hành mà không build lại (riêng của Buildpacks)                                                           | kpack tự rebase                                                     |
| arm64                   | Có                                                                                          | Có (builder Paketo Ubuntu 24.04 khai cả amd64 và arm64)                                                                             | Có                                                                  |
| SBOM                    | BuildKit sinh                                                                               | Có sẵn trong image (CycloneDX, SPDX, Syft); BuildKit sinh cho đường Dockerfile                                                      | Có                                                                  |
| Chi phí của UDP         | 0                                                                                           | 0 (phút CI miễn phí của khách)                                                                                                      | 0 cho UDP, nhưng ăn node của khách và phải nới Pod Security         |
| Rủi ro chính            | Mẫu đoán sai thì build hỏng                                                                 | Builder khoảng 1,4 GB tải mỗi lượt CI                                                                                               | Vận hành nặng, khó gỡ lỗi                                           |

Các nền tảng cùng loại làm theo B: Cloud Run (Dockerfile nếu có, không thì buildpacks), Azure Container Apps, GitLab
Auto Build, Heroku (chỉ Buildpacks), Northflank, Dokku; Railway cùng khuôn nhưng dùng Railpack thay Buildpacks.

## 3. Đề xuất: hướng B

### 3.1 Chọn cách build

- Thứ tự: (1) người dùng ghim trên Portal; (2) repo có Dockerfile (đường dẫn cấu hình được) ⇒ BuildKit; (3) không có ⇒
  Buildpacks, builder Paketo `ubuntu-noble-builder` ghim theo digest.
- Quyết định LÚC PIPELINE CHẠY, theo đúng commit đang build: thêm hay xoá Dockerfile không cần sinh lại pipeline. Trang
  "Mã nguồn" hiện điều UDP dự đoán (từ lần quét repo) và vì sao.
- Golden Path giữ Dockerfile Node.js/Python nên vẫn đi đường Dockerfile: không thứ gì đang có đổi hành vi.
- Mô hình: một `BuildPlan` thuần trong `@udp/adapter-core` (chiến lược, thư mục build cho monorepo, đường Dockerfile,
  builder, kiến trúc, bước test, cách đăng nhập registry). Sáu adapter CI chỉ VẼ nó; bộ hợp đồng CI/CD kiểm mọi ô CI ×
  chiến lược × kiểu đăng nhập.

### 3.2 Build chạy ở đâu (sửa K2)

| CI                                          | Có Dockerfile                                                                     | Không Dockerfile (Buildpacks)                            |
| ------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| GitHub Actions                              | `docker/build-push-action` (BuildKit)                                             | `pack build --publish` (action `setup-pack` chính thức)  |
| GitLab CI                                   | BuildKit qua `docker:dind` như hôm nay                                            | Ảnh builder + `/cnb/lifecycle/creator`, không cần Docker |
| CircleCI                                    | BuildKit trên máy `machine`                                                       | `pack build --publish`                                   |
| Jenkins, Tekton, Drone (chạy trong cluster) | `buildctl` gọi MỘT BuildKit dùng chung ở namespace `udp-build` (không root, mTLS) | Pod chạy ảnh builder + `creator`, không đặc quyền        |

Bỏ hẳn kaniko. BuildKit trong cluster theo đúng mẫu Kubernetes của dự án BuildKit: chỉ `buildkitd` ở namespace
`udp-build` được miễn Pod Security (seccomp và AppArmor `Unconfined`), chạy UID 1000, chỉ nhận client có chứng chỉ;
pod CI vẫn ở mức hạn chế. Ngoại lệ này ghi vào §12.2.

### 3.3 Đăng nhập registry (sửa K1), không khoá dài hạn khi tránh được

| CI                                  | ECR, Artifact Registry, ACR                                                                                                   | GHCR                                                                    | Docker Hub, Harbor, Nexus, Artifactory                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| GitHub Actions, GitLab CI, CircleCI | OIDC: UDP tạo trong tài khoản cloud của khách một vai trò chỉ được đẩy vào đúng repo image, chỉ tin đúng repo Git của project | `GITHUB_TOKEN` với `packages: write` (GitHub Actions); secret ở CI khác | Secret CI `UDP_REGISTRY_USERNAME` / `UDP_REGISTRY_PASSWORD`; Portal chỉ đúng tên |
| Jenkins, Tekton, Drone              | Danh tính workload của ServiceAccount build (IRSA, Workload Identity của GKE, Azure Workload Identity)                        | Secret                                                                  | Secret                                                                           |

Adapter registry khai `pushAuth` (một kiểu dữ liệu), adapter CI vẽ theo kiểu đó: thêm registry mới không sửa CI.

### 3.4 Bước test (K4)

- Lệnh mặc định chỉ khi không mơ hồ: Node.js, Python (như nay), Go (`go test ./...`), Maven, Gradle, .NET
  (`dotnet test`). Ruby, PHP và ngôn ngữ khác: khai lệnh và image test trên Portal; chưa khai thì pipeline dừng với lời
  nhắn như hôm nay. Không bao giờ có pipeline "xanh mà không test gì".
- Quét repo nhận thêm `go.mod`, `*.csproj` / `*.sln`, `Gemfile`, `composer.json`, `Cargo.toml` (Rust: Buildpacks không
  hỗ trợ, Portal nói cần Dockerfile), trang tĩnh.

### 3.5 Từ build tới deploy theo digest (K5, K6)

- Mỗi lượt build ra digest; pipeline báo UDP `repo:<commit>@sha256:<digest>`; Service 1 đặt đúng chuỗi đó vào workload,
  nên thứ chạy là đúng byte đã build kể cả khi tag bị đẩy đè. Nhãn phiên bản vẫn là commit. Dạng `repo:<tag>` cũ vẫn
  được nhận.
- Kiến trúc theo nhãn `kubernetes.io/arch` của node trong cluster mà environment dùng (mặc định amd64). Cluster arm64 thì
  build trên runner arm64 (GitHub cho dùng runner arm64 trong gói miễn phí ở cả repo riêng từ 29/01/2026). Hai loại lẫn
  nhau thì ra image đa kiến trúc.

### 3.6 Chuỗi cung ứng, mặc định và 0 đồng

- Ghim mọi action theo SHA đầy đủ, mọi image nền và builder theo digest, ở MỘT tệp phiên bản trong `@udp/config`. Test
  chặn mọi chỗ ghim theo tag; một job định kỳ trong CI của UDP báo khi có bản mới (không tự đổi).
- SBOM: đường Dockerfile dùng BuildKit `sbom` và provenance `mode=max` (lưu trong image index, chạy cả với registry
  thiếu API referrers như GHCR); đường Buildpacks có SBOM sẵn trong image.
- Bước Grype (adapter Security hiện có) quét đúng digest vừa build.
- Image Buildpacks có lượt `rebase` hằng tuần (pipeline theo lịch): thay lớp hệ điều hành đã vá rồi deploy qua đúng luồng
  webhook như mọi lần deploy khác.

### 3.7 Portal

Trang "Mã nguồn" thêm mục "Đóng gói":

- UDP sẽ build thế nào và vì sao;
- đổi được chiến lược, thư mục build, Dockerfile, lệnh test;
- kiểu đăng nhập registry và tên secret cần đặt;
- xem trước pipeline (đã có).

## 4. Ký image — CẦN BẠN CHỌN (đợt 4, tuỳ chọn)

Ký image ở CI, rồi cluster chặn image chưa ký (Kyverno `verifyImages`). Ba cách giữ khoá:

| Cách                                                      | Ưu                           | Nhược                                                                        |
| --------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| (a) Sigstore keyless                                      | 0 đồng, không giữ khoá       | Tên repo và workflow ghi vào sổ công khai Rekor: lộ thông tin của repo riêng |
| (b) Khoá KMS trong tài khoản cloud của khách              | Riêng tư, chuẩn doanh nghiệp | Khách trả phí KMS rất nhỏ (AWS khoảng 1 USD/khoá/tháng); UDP vẫn 0 đồng      |
| (c) Cặp khoá cosign do UDP sinh, khoá bí mật là secret CI | 0 đồng                       | Xoay khoá thủ công                                                           |

Đề xuất: (b) cho repo riêng, (a) cho repo công khai. GitHub artifact attestations chỉ miễn phí cho repo công khai (repo
riêng cần GitHub Enterprise Cloud) nên không làm nền.

## 5. Không đề xuất, và vì sao

- **Railpack** (phủ thêm Rust, Elixir, Deno): còn 0.x, cần BuildKit frontend riêng, action GitHub của bên thứ ba;
  Coolify vẫn gắn nhãn Beta. Ngôn ngữ ngoài Buildpacks đi đường Dockerfile.
- **Nixpacks**: chế độ bảo trì từ 09/2025. **kaniko**: Google lưu trữ ngày 03/06/2025; bản fork của Chainguard chỉ vá
  lỗi, không phát hành image.
- **Builder của Google**: chỉ amd64, chỉ được hỗ trợ chính thức trên Google Cloud. **Builder Heroku làm mặc định**:
  không khai SBOM; báo chí công nghệ 02/2026 nói Heroku chuyển sang chế độ chỉ duy trì (chưa thấy thông báo chính thức).
- **`docker init`**: thuộc Docker Desktop, trả phí với công ty từ 250 người.
- **Docker Hardened Images làm image nền của Golden Path**: miễn phí nhưng phải đăng nhập `dhi.io` ở mọi lượt kéo (CI và
  cluster), thêm ma sát cho bản free. Giữ image chính thức, ghim theo digest.
- **Hướng A, hướng C làm mặc định**: lý do ở mục 2. **Build trên máy của UDP**: trái chi phí 0 và D-P41.

## 6. Phụ thuộc cần bạn (ngoài đóng gói)

Phát hành provider: `@udp/openfeature-provider` lên npm và `udp-openfeature` lên PyPI (gói đã sẵn, §6.8). Chưa phát
hành thì ứng dụng Golden Path vẫn không build được ngoài monorepo, dù đóng gói đã đúng. Đề xuất làm thành plan riêng
ngay sau: phát hành bằng trusted publishing (OIDC từ GitHub Actions, không token dài hạn); bạn chỉ cần tạo tài khoản npm
và PyPI (miễn phí) và nối repo.

## 7. Tự review trước khi đề xuất

**Bảy khẳng định đã tự kiểm trên nguồn gốc (01/10/2026):**

1. kaniko: repo `GoogleContainerTools/kaniko` có `archived: true`, lần đẩy cuối 03/06/2025 (API GitHub).
2. Builder Paketo `ubuntu-noble-builder`: `builder.toml` khai .NET, Go, Java, Java Native Image, Node.js, PHP, Procfile,
   Python, Ruby, web-servers, đích `linux/amd64` và `linux/arm64`.
3. Buildpacks: CNCF ghi Accepted 03/10/2018, Incubating 18/11/2020, Graduated 17/07/2026. `pack` v0.40.9 (09/08/2026).
4. Trivy: GHSA-69fq-xp46-6x23, CVE-2026-33634, mức critical, công bố 21/03/2026.
5. BuildKit không root trong Kubernetes: tài liệu của dự án yêu cầu seccomp và AppArmor `Unconfined` cùng cờ
   `--oci-worker-no-process-sandbox`; mẫu `Deployment` + `Service` khuyên dùng mTLS.
6. Runner arm64 của GitHub: changelog 29/01/2026, dùng được trong gói miễn phí ở mọi repo.
7. Mọi node UDP dựng là x86 (`AWS_NODE_TYPES`, `GCP_MACHINE_TYPES`, `AZURE_VM_SIZES`).

**Không hạ cấp:**

- Golden Path Node.js/Python vẫn đi đường Dockerfile.
- `docker build` đổi sang BuildKit với CÙNG Dockerfile; BuildKit là builder mặc định của Docker từ bản 23.
- Webhook nhận thêm dạng `tag@digest`, dạng cũ vẫn nhận.

**Không nợ:**

- kaniko bỏ hẳn.
- Phiên bản ghim một chỗ, có test và job báo bản mới.
- Mọi ô CI × chiến lược × kiểu đăng nhập có test hợp đồng.
- Tài liệu cập nhật §5.5, §8.3, §11, §12.2, §16 và một quyết định D-P mới.

**Chi phí 0 cho UDP:** build ở CI hay cluster của khách; UDP chỉ sinh tệp và nhận webhook.

**Rủi ro đã biết và cách giảm:**

1. Builder Paketo khoảng 1,4 GB, tải mỗi lượt CI, nên lượt đầu chậm hơn. Lớp ứng dụng được cache bằng `--cache-image`
   trong registry của khách.
2. Docker Hub giới hạn 100 lượt kéo / 6 giờ / IP khi không đăng nhập, mà builder nằm trên Docker Hub. Giảm bằng đăng nhập
   Docker Hub tuỳ chọn (tài khoản miễn phí) hoặc pull-through cache của ECR / Artifact Registry / ACR do UDP bật.
3. BuildKit trong cluster cần một namespace miễn Pod Security. Đã cô lập trong `udp-build`, không root, mTLS, và ghi rõ
   ở §12.2.
4. OIDC cần biết repo Git của project (`repo_url`, đã có cột). Project chưa khai repo thì Portal yêu cầu khai trước khi
   tạo vai trò; GitLab tự host cần khai issuer riêng.
5. Buildpacks không cài được gói hệ điều hành tuỳ ý (cần extension còn thử nghiệm). Ứng dụng cần thư viện hệ thống lạ
   thì dùng Dockerfile; Portal nói rõ khi lần build Buildpacks hỏng ở bước này.
6. Service 1 cần quyền đọc `nodes` (cluster-scoped, chỉ `get`/`list`) để biết kiến trúc. Thêm vào RBAC chỉ-đọc và test
   ma trận quyền.

**Kiểm chứng 0 đồng:**

- Một job trong CI của UDP (repo công khai, runner miễn phí) build bộ ứng dụng mẫu mỗi ngôn ngữ × hai chiến lược bằng
  ĐÚNG lệnh UDP sinh ra, đẩy vào registry cục bộ, chạy image và gọi `/healthz`.
- Làn `kind` hiện có thêm BuildKit dùng chung và `creator` trong cluster.
- Phần còn lại cần CI và cloud thật (GitLab, CircleCI, OIDC với ba cloud) gộp vào mục `cicd-webhook-real` đã có.

## 8. Các đợt (sau khi duyệt; spec và plan theo quy trình như mọi plan)

| Đợt | Nội dung                                                                                                                                                          | Cổng chính                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Cho chạy được thật: đăng nhập registry mọi ô (K1); BuildKit dùng chung và `creator` cho Jenkins/Tekton/Drone, bỏ kaniko (K2); deploy theo digest; ghim SHA/digest | Hợp đồng CI/CD mọi ô; job CI build thật ứng dụng Node.js và Python           |
| 2   | Buildpacks và `BuildPlan`; quét thêm ngôn ngữ; bước test khai được; kiến trúc CPU; mục "Đóng gói" trên Portal (K3, K4, K6)                                        | Job CI build ứng dụng mẫu mỗi ngôn ngữ × hai chiến lược; Playwright năm lượt |
| 3   | SBOM, provenance, Grype trên digest, `rebase` hằng tuần, job báo phiên bản mới                                                                                    | Test và job CI                                                               |
| 4   | Tuỳ bạn chọn ở mục 4: ký image và chặn image chưa ký                                                                                                              | Test chính sách Kyverno                                                      |
| —   | Tài liệu, bản xem thử (mục "Đóng gói" với dữ liệu mẫu), bàn giao                                                                                                  | Như mọi plan                                                                 |

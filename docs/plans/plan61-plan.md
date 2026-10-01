# Plan #61 — Kế hoạch: đóng gói ứng dụng thành container

Spec: `docs/plans/plan61-spec.md`. Mỗi đợt: mã + test + cổng, rồi một commit (chỉ ở máy).

## 61a — Chạy được thật (AC-1, AC-3, AC-4, AC-5)

1. `@udp/config`: `build-toolchain.ts` — `BUILD_TOOLCHAIN` (image ghim digest, `pack` + sha256, SHA của
   `actions/checkout`), `NODE_ARCH`; test hình dạng (mọi image có `@sha256:` 64 hex, SHA 40 hex).
2. `@udp/adapter-core`: `BuildPlan`, `RegistryPush`, `BuildIdentity` (kiểu thuần) + `PipelineTemplateParams.build`.
3. Registry: chín adapter khai `pushAuth` (+ `region` cho ECR, `registryName` cho ACR) trong thuộc tính binding
   `registry.oci`; test hợp đồng của registry đòi có `pushAuth` hợp lệ.
4. `adapter-base/packaging/` (mới):
   - `build-script.ts` — đoạn shell dùng chung: chọn chiến lược, JWT theo CI (GitHub, GitLab, CircleCI, TokenRequest
     trong cluster) và `aud` theo cloud, đăng nhập theo `RegistryPush` cho hai môi trường, build Dockerfile (buildx /
     buildctl-daemonless) và Buildpacks (pack / creator), đọc digest, bước test.
   - `build-namespace.ts` — release `raw` đi kèm: namespace `udp-build`, SA `udp-builder`, Role tự xin token, LimitRange,
     NetworkPolicy chặn ingress.
   - Service 1: `modules/packaging/build-plan.ts` dựng `BuildPlan`.
5. Sáu adapter CI viết lại phần build: đăng nhập → build (theo chiến lược của 61a: `auto` chọn Dockerfile/Buildpacks đã có
   từ 61a ở máy có Docker; trong cluster đủ cả hai) → `IMAGE_REF` có digest → bước sau build → báo UDP. Jenkins: pod
   template, bước domain là container; Tekton: `git-clone`, task build, task `detect`; Drone: namespace và SA. Không
   kaniko.
6. Bước của domain khác (6 adapter) và Dockerfile Golden Path ghim digest; `assertSafe` đòi image bước có digest.
7. Service 1: dựng `BuildPlan` (mặc định khi chưa có cài đặt — chiến lược `auto`, test theo `languageRuntime`); webhook
   nhận `:tag@sha256:`; `tagOf`/`versionLabelOf` ưu tiên tag.
8. Kyverno miễn trừ `udp-build`.
9. Bộ hợp đồng CI/CD mở rộng (QĐ-6 ma trận, YAML parse, `bash -n`, thứ tự, không bí mật, ghim) + test đơn vị cho
   `build/*`.

Cổng: typecheck, eslint, prettier; core-backend (cicd, registry, golden path, webhook, deploy), adapter-core, config;
design-lint.

## 61b — Buildpacks, cài đặt build, bước test, Portal (AC-2, AC-6, AC-9)

1. Migration `projects.build_settings`; schema dây `buildSettingsSchema`, `buildViewWire` (shared-types).
2. Service 1: module `build` — `GET/PUT /projects/:id/build`, dựng `BuildPlan` từ cài đặt, dự đoán chiến lược (từ quét
   repo hay Golden Path), việc cần làm (secret theo CI, danh tính), script danh tính theo cloud (`identity-script.ts`);
   nhật ký; golden.
3. Quét repo (QĐ-10): ngôn ngữ mới, finding `packaging`.
4. Bước test: bảng lệnh mặc định (Node.js, Python, Go, Maven, Gradle, .NET), `custom`, `none`.
5. Portal: mục "Đóng gói" trên trang Mã nguồn (dự đoán + lý do, form cài đặt, việc cần làm, script danh tính có nút chép,
   ô dán kết quả); qk + i18n + test.
6. Bản xem thử: dữ liệu mẫu đủ trạng thái; `contract.check`; màn mới trong cổng năm lượt.
7. Job CI `build-smoke` + ứng dụng mẫu.

## 61c — SBOM, provenance, rebase, phiên bản (AC-7)

1. Cờ SBOM/provenance ở hai đường Dockerfile; Buildpacks giữ SBOM sẵn có.
2. Rebase theo lịch ở sáu CI (QĐ-13), test hợp đồng.
3. `toolchain:check` + job CI theo lịch tuần.

## 61d — Ký và kiểm chữ ký (AC-8)

1. `SigningPlan` (KMS theo cloud); script danh tính thêm khoá KMS và quyền ký; bước `cosign sign` sau build ở sáu CI.
2. Cài đặt build lưu khoá công khai; Kyverno: `ClusterPolicy` `verifyImages` khi có khoá công khai; Portal hiện trạng thái
   ký.

## Cuối

`UDP_design.md` (§5.5, §8.3, §11, §12.2, §16, D-P54), `DESIGN.md` nếu có thành phần mới, sổ nợ (`cicd-webhook-real` mở
rộng), bàn giao; Playwright năm lượt.

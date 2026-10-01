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

1. SBOM/provenance: đã có từ 61a ở hai đường Dockerfile (`--sbom=true --provenance=mode=max`, `attest:sbom`/
   `attest:provenance`); Buildpacks giữ SBOM sẵn có — test hợp đồng khẳng định cờ có mặt ở cả sáu CI.
2. `@udp/adapter-core`: `rebaseScheduleOf(plan, projectSlug)` — giờ chạy tất định (01:00–06:59 UTC, phút khác 0), `null`
   khi chiến lược ghim Dockerfile; `WebhookDeployEvent.kind?: "rebase"` (mở rộng, E1).
3. `adapter-base/packaging/rebase-script.ts`: `dockerHostRebaseLines` (`pack rebase --publish`), `inClusterRebaseContainers`
   (`/cnb/lifecycle/rebaser`); `build-script.ts` tách `packDownloadLines`, `digestFromReport`, `inClusterLoginContainers`
   để dùng chung. `notifyScript` mang `UDP_KIND`.
4. Sáu CI: GitHub `on.schedule` + `if` theo `github.event_name`; GitLab `CI_PIPELINE_SOURCE == "schedule"`; CircleCI
   `pipeline.trigger.type == "schedule"` (`trigger_source` đã ngừng hỗ trợ 01/08/2026); Jenkins `triggers { cron }` chỉ ở
   `main` + `triggeredBy 'TimerTrigger'` (chạy trong container sẵn có của pod, không thêm container); Drone pipeline thứ
   hai `event: [cron]`, `cron: [udp-rebase]`; Tekton Pipeline `udp-<slug>-rebase`. Lượt theo lịch không chạy job build.
5. Service 1: `deployBodySchema.kind`; `rebase-decision.ts` (`decideRebase`, `latestDeployment`); webhook trả thêm
   `unchanged` / `skipped` + lý do (wire: hợp của ba dạng); metadata `kind: "rebase"`; `deploymentWire.rebase`.
6. `buildViewWire.rebase` (giờ chạy + cách đặt lịch theo CI); Portal: dòng "Vá image nền" ở mục Đóng gói, nhãn ở lịch sử
   deployment; i18n; golden; bản xem thử (deployment rebase, lịch theo CI).
7. `toolchain:check` (`@udp/config`, phần thuần có test) + `pnpm toolchain:check` + workflow `toolchain.yml` thứ Hai.
8. Test: hợp đồng sáu CI (lịch, điều kiện, không chạy build ở lượt lịch, YAML hợp lệ, `bash -n`), `decideRebase`, webhook
   rebase (deploy/unchanged/skipped), wire golden, Portal.

## 61d-1 — Ký và cổng deploy (AC-8, AC-10)

1. `BUILD_TOOLCHAIN`: cosign 3.1.3 (sha256 tệp linux-amd64), oras (sha256); `SIGNING_CONFIG` không dịch vụ.
2. Cài đặt build `signing: { keys: [{ id, publicKey, kms, addedAt }], compat, enforce }` (schema chặn khoá bí mật; `id` =
   dấu vân tay SHA-256 của khoá công khai); `BuildPlan.signing` (URI KMS, cloud, compat) — mở rộng bối cảnh.
3. Script danh tính: danh tính ở cloud của project (không còn `NOT_CLOUD_REGISTRY`); tạo khoá KMS + quyền ký theo cloud;
   in `signing`. Portal: dán dòng kết quả ⇒ thêm khoá vào danh sách (xoay khoá giữ khoá cũ tới khi gỡ).
4. `adapter-base/packaging/sign-script.ts`: ký bundle (`cosign sign` + signing config + annotation + `--bundle`), chữ ký
   tương thích (`sign-blob` + `oras push` tag `.sig`), thông tin đăng nhập KMS theo cloud cho hai môi trường (máy có
   Docker, trong cụm). Sáu CI: bước ký sau bước sau-build, trước báo UDP; rebase ký lại; bundle đi kèm webhook.
5. Service 1 `cicd/signature-gate.ts`: ràng buộc repo (mọi project); kiểm bundle (`@sigstore/verify`), digest, project,
   commit, nhánh ⇒ environment, độ mới và đơn điệu; chế độ `enforce` tự bật; `DEPLOY_FAILURE` có mã lý do; nhật ký.
   `engines` lên `>=22.22.2`.
6. Wire/Portal: trạng thái ký trong mục Đóng gói (khoá, dấu vân tay, chế độ, tương thích), "Đã kiểm chữ ký" ở deployment;
   bản xem thử đủ trạng thái.
7. E2E `signing-e2e` (GitHub Actions): zot + distribution, ký bằng khối shell renderer sinh (khoá tệp), kiểm bằng `cosign
verify`, `skopeo` + `policy.json`, bộ kiểm Service 1; ca hỏng (khoá khác, sửa annotation, thiếu chữ ký).

## 61d-2 — Trusted Deploy (AC-11)

1. Migration `webhook_token_uses`; dọn hàng hết hạn theo lịch.
2. `cicd/trusted-deploy.ts`: kiểm JWT bằng JWKS (`jose`) cho GitHub/GitLab/CircleCI; TokenReview trên cụm của project cho
   CI trong cụm; gắn claim với cấu hình adapter CI; dùng một lần; chế độ `oidcRequired` tự bật.
3. Sáu CI: xin token `aud` = webhook, gửi `Authorization: Bearer`; production của Jenkins/Tekton/Drone mặc định chờ duyệt.
4. Bộ ký trong cụm (CircleCI + Azure): namespace `udp-signing`, SA `udp-signer`, Role; Job ký do Service 1 tạo sau khi xác
   minh; script danh tính Azure cấp federated credential cho `udp-signer`.
5. Portal: trạng thái Trusted Deploy; test (JWKS thử, sai `aud`, hết hạn, dùng lại, claim lệch); bản xem thử.

## 61d-3 — Kyverno (AC-12)

1. Adapter Kyverno 2.0.0: chart 3.9.x / `kyverno-policies` 3.9.x; nâng qua §8.6; replicas ≥ 2 khi Deny; `failurePolicy`
   theo chế độ.
2. `ctx.project.signing` (E1) ⇒ companion `ImageValidatingPolicy` mỗi project (khoá công khai tĩnh, quyền đọc registry
   theo loại); đổi khoá ⇒ áp lại domain POLICY.
3. Luồng cập nhật: `toolchain:check` theo dõi chart Helm ghim; `--fix` mở pull request; E2E kind + Kyverno (Audit/Deny,
   đã ký/chưa ký); lịch tự áp bản vá qua §8.6 (trả nợ §8.6).

## Cuối

`UDP_design.md` (§5.5, §8.3, §11, §12.2, §16, D-P54), `DESIGN.md` nếu có thành phần mới, sổ nợ (`cicd-webhook-real` mở
rộng), bàn giao; Playwright năm lượt.

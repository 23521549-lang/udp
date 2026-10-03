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

1. **Ghim:** `BUILD_TOOLCHAIN.cosign` 3.1.3 (sha256 tệp `cosign-linux-amd64`) và `BUILD_TOOLCHAIN.oras` 1.3.4 (sha256 tệp
   `oras_1.3.4_linux_amd64.tar.gz`); `SIGNING_CONFIG_JSON` không dịch vụ. Ghi chú ở chỗ ghim: nâng cosign thì bản mới phải
   kéo sigstore ≥ v1.10.10 (lỗi Azure KMS sigstore#2409 có từ v1.10.9; cosign 3.1.3 dùng v1.10.8). `toolchain:check` kiểm
   thêm cosign và oras như `pack` (bản phát hành + sha256 công bố).
2. **Cài đặt build** thêm `signing: { keys: [{ id, publicKey, kms, addedAt }], compat, enforce }` — mặc định `{ keys: [],
compat: true, enforce: false }`, không cần migration (cột JSONB đọc qua `settingsOf`). `publicKey` PEM EC P-256; `kms`
   khớp dạng URI của ba cloud (`awskms:///arn:aws:kms:…`, `gcpkms://projects/…/cryptoKeys/…/versions/<n>`,
   `azurekms://<vault>.vault.azure.net/<khoá>`); `id` = 16 ký tự hex đầu của SHA-256 trên DER khoá công khai, Service 1
   tính lúc lưu. Khoá MỚI NHẤT ký; mọi khoá trong danh sách được chấp nhận khi kiểm (xoay không gián đoạn).
3. **`BuildPlan.signing`** `{ kms, cloud, compat } | null` (mở rộng bối cảnh, E1) — `null` khi chưa có khoá hay CI không
   federation được tới cloud của project (CircleCI + Azure, chờ 61d-2). Danh tính dùng để ký là danh tính của project ở
   cloud của nó (`CloudCredential.provider`), không phụ thuộc registry.
4. **Script danh tính** (danh tính ở cloud của project, bỏ `NOT_CLOUD_REGISTRY`; đẩy registry chỉ khi registry của cloud):
   - AWS: khoá `ECC_NIST_P256`/`SIGN_VERIFY` + alias `alias/udp-sign-<slug>` (tạo nếu chưa có), chính sách inline
     `kms:Sign`, `kms:GetPublicKey`, `kms:DescribeKey` trên đúng khoá; khoá công khai qua `get-public-key` + `openssl`.
   - GCP: keyring `udp` ở region của project, khoá `udp-sign-<slug>` `ec-sign-p256-sha256`; `roles/cloudkms.signerVerifier`
     trên khoá cho service account; khoá công khai `versions get-public-key 1`.
   - Azure: Key Vault RBAC `udp<băm>` cùng resource group, khoá EC P-256 `udp-sign`; người chạy script tự nhận "Key Vault
     Crypto Officer" trên vault (data plane), managed identity nhận "Key Vault Crypto User" trên KHOÁ; chờ phân quyền lan
     (thử lại có giới hạn); khoá công khai `key download --encoding PEM`.
   - Dòng kết quả thêm `signing: { key, publicKey }`. Portal dán dòng ⇒ khoá vào đầu danh sách.
5. **`adapter-base/packaging/sign-script.ts`** (cùng luật ký tự với build-script):
   - Tải cosign, oras (kiểm sha256); ghi signing config; thông tin đăng nhập KMS theo cloud (AWS `AWS_ROLE_ARN` +
     `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_REGION`; GCP tệp `external_account` qua `GOOGLE_APPLICATION_CREDENTIALS`; Azure
     `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_FEDERATED_TOKEN_FILE`), JWT ghi ngoài thư mục build, xoá khi xong.
   - Bundle: `cosign sign --yes --key <kms> --signing-config <tệp> --bundle <tệp> -a dev.udp.project=… -a dev.udp.commit=…
-a dev.udp.ref=<nhánh> -a dev.udp.run=… -a dev.udp.issued-at=<UTC> <image>@<digest>`.
   - Tương thích (khi `compat`): nội dung simple signing (`docker-reference` = repository, `docker-manifest-digest`,
     `type: cosign container image signature`, `optional` mang annotation) ⇒ `cosign sign-blob --key <kms>` ⇒ chữ ký từ
     `messageSignature.signature` ⇒ `oras push <repo>:sha256-<hex>.sig --config <cấu hình>:application/vnd.oci.image.config.v1+json
--annotation-file <tệp> <nội dung>:application/vnd.dev.cosign.simplesigning.v1+json` (annotation
     `dev.cosignproject.cosign/signature`).
   - Ghi bundle (một dòng, base64) để bước báo UDP gửi kèm; tách `credentialLines` khỏi `signLines` để E2E dùng khoá tệp.
6. **Sáu CI:** bước ký SAU các bước sau build (chỉ image đã qua quét mới được ký), TRƯỚC bước báo; lượt rebase ký digest
   mới. GitHub: bước trong job (quyền `id-token: write` khi ký). GitLab: job `sign` ở stage `sign`, bundle sang job báo
   bằng artifact (tệp, không dotenv — giới hạn 5 KB). CircleCI: bước trong job. Jenkins: stage chạy trong container sẵn có
   (biến không bí mật đặt trong kịch bản), Tekton: task `sign` riêng sau mọi task sau build (task sau build chạy SAU task
   build, nên ký trong task build là ký trước bước quét) — đăng nhập registry lại, lấy ảnh có digest từ workspace, để chữ
   ký trong workspace cho task báo ở `finally`; Drone: bước — ba CI trong cụm ghi `/udp/out/signature.b64`.
   `notifyScript` gửi `signature` (bundle) khi có. **Phát hiện khi làm (sửa luôn):** runner của Drone thay mọi `${…}` của
   tệp bằng biến của lượt chạy TRƯỚC khi đọc YAML, biến lạ thành rỗng (`envsubst` của runner-go, đọc tại nguồn) — đã làm
   hỏng `${UDP_KIND:-}` của lượt rebase (61c) và `${UDP_REGISTRY_USERNAME:-}` của đăng nhập bằng mật khẩu (61b). Adapter
   Drone thoát mọi `${` thành `$${` (cách tài liệu của Drone chỉ); bộ hợp đồng có phép kiểm riêng.
7. **Service 1 `cicd/signature-gate.ts`** (gọi trong `receiveWebhook`, trước khi ghi sự kiện):
   - Mọi project: `imageRef` phải thuộc `<registryRef>/<slug>` ⇒ không thì 422 + nhật ký `cicd.webhook.foreign-image`.
   - Có khoá: `@sigstore/verify` với khoá công khai (ngưỡng 0) ⇒ DSSE đúng; predicate cosign sign v1; digest của subject =
     digest của `imageRef`; `project`, `commit` khớp; nhánh ⇒ environment theo luật của template; `issued-at` trong 24 giờ
     (lệch tương lai ≤ 5 phút) và không cũ hơn `issued-at` của lần deploy thành công hiện hành ở environment đó.
   - Chữ ký có mà sai ⇒ luôn `DEPLOY_FAILURE` (mã `SIGNATURE_INVALID` / `SIGNATURE_MISMATCH` / `SIGNATURE_STALE`); thiếu
     chữ ký ⇒ `DEPLOY_FAILURE` `SIGNATURE_MISSING` khi `enforce`, không thì deploy và ghi "chưa ký". Chữ ký hợp lệ đầu tiên
     ⇒ bật `enforce` cùng transaction, nhật ký `project.build.signing-enforced` (SYSTEM). Tắt `enforce`: MAINTAINER, nhật ký.
   - **Rà lại khi làm (đã khắc phục):** (a) bị từ chối ⇒ ghi `DEPLOY_FAILURE` rồi trả 422 — bước báo của CI đỏ, người đẩy
     code thấy lý do ngay (trả 200 thì CI xanh mà không deploy). (b) Bật/tắt bắt buộc là thao tác riêng `PUT
/projects/:id/build/signing-enforce`; `PUT /build` giữ giá trị đang lưu — Portal mở từ trước lúc cổng tự bật mà lưu cài
     đặt khác thì không vô tình tắt bắt buộc. Gỡ hết khoá ⇒ tắt theo; bật cần ít nhất một khoá (409). (c) Đọc cài đặt và tự
     bật dưới khoá dòng project `FOR NO KEY UPDATE` trong transaction của webhook — hai webhook đồng thời không lướt qua nhau,
     và không chặn bảng khác ghi khoá ngoại tới project. (d) Project chưa có cloud mà đẩy registry của cloud: script danh
     tính chỉ phần đẩy (như trước 61d), không mất việc "danh tính build".
   - Metadata của lần deploy ghi `signature: { keyId, issuedAt }` (từ chối: `{ code, detail }`); `deploymentWire.signature`
     = `VERIFIED` | mã từ chối | `null` (không kiểm).
   - Phụ thuộc `@sigstore/verify` 4.1.2 (+ `@sigstore/bundle`, `@sigstore/core`); `engines` `>=22.22.2`.
8. **Portal:** mục Đóng gói có phần Ký image (khoá với dấu vân tay, URI KMS, ngày thêm, gỡ khoá; chữ ký tương thích bật/tắt;
   chế độ bắt buộc và tắt có xác nhận); lịch sử deployment hiện "Đã kiểm chữ ký" và mã lý do khi bị từ chối; thuật ngữ;
   bản xem thử đủ trạng thái (chưa có khoá, chờ lượt ký đầu, đã bắt buộc, chữ ký bị từ chối).
9. **E2E `signing-e2e`** (GitHub Actions, 0 đồng): dịch vụ zot (có API referrers) và distribution (không có); image nhỏ đẩy
   vào cả hai; khoá tệp ECDSA P-256 (`cosign generate-key-pair`); ký bằng `signLines` renderer sinh; kiểm bằng `cosign
verify --key … --insecure-ignore-tlog`, `skopeo` + `policy.json` `sigstoreSigned` (bật `use-sigstore-attachments`), và
   bộ kiểm của Service 1 (script gọi chính hàm của cổng); ca hỏng: khoá khác, annotation bị sửa, image không chữ ký.
10. **Mốc giờ của chuỗi sự kiện deploy do DATABASE cấp** — thêm vào 61d-1 ở bước kiểm chứng, không có trong bản plan gốc;
    chi tiết và phép đo ở `docs/ban-giao/trang-thai-2026-10-02.md` §3.1. Bộ test đầy đủ của core-backend làm lộ ra rằng
    tiền đề của cả 61c lẫn 61d-1 là sai: `occurred_at` khai `@default(now())` nhưng **Prisma sinh giá trị đó ở MÁY**, nên
    thứ tự sự kiện phụ thuộc đồng hồ của từng tiến trình, trong khi `deployment_events` có hai writer ở hai tiến trình và
    bốn kết luận đọc đúng thứ tự đó — kể cả `issued-at` "không cũ hơn bản đang chạy" của chính AC-10 ở mục 7. Đã sửa:
    `schema.prisma` dùng `@default(dbgenerated("clock_timestamp()"))` và cột lên `TIMESTAMPTZ(6)`; migration
    `20261002040000_deploy_event_time_from_database` kèm một câu UPDATE kẹp các hàng cũ đang nằm ở tương lai; ba truy vấn
    quyết định và hai câu `DISTINCT ON` có khoá sắp toàn phần; một `describe` hồi quy canh cả catalog lẫn hình dạng câu
    INSERT; §2.2 của thiết kế có một đoạn nói ai điền các cột thời gian, kèm ba điều kiện để 22 cột còn lại còn an toàn.

## 61d-2 — Trusted Deploy (AC-11)

Bản này là bản **thứ ba**, sau một vòng ba agent QA soát chính plan (thiết kế / mã nguồn / bảo mật). Vòng đó tìm ra 22
BLOCKER và **ba dữ kiện bản plan trước nói SAI về mã nguồn**; mỗi khẳng định dưới đây đã được kiểm lại bằng mã hay bằng
một phép đo, và chỗ nào hai agent kết luận trái nhau thì ghi rõ cách phân xử.

### Phạm vi: 61d-2a làm ba CI SaaS, ba CI trong cụm sang 61d-2b

Bản đầu định cho cả sáu CI vào một đợt. Hai lối hiện thực cho đường CI-trong-cụm, và **cả hai đều chạm phía cụm**:

- **TokenReview.** Cần `authentication.k8s.io/tokenreviews: create` trong cụm khách. Chữ `tokenreviews` xuất hiện **0
  lần** trong `docs/UDP_design.md`, và `cluster/bootstrap.ts` tạo đúng ba ServiceAccount không SA nào có verb đó ⇒ phải
  thêm ClusterRole, **bootstrap lại mọi cụm đang chạy**, sửa §1.2/§12.2 và danh sách mong đợi của I25. Thêm nữa
  `ClusterAccess.write()` khai `Promise<void>` (`packages/cluster-access/src/direct.ts:220-231`) nên **không có đường
  nào đọc `status`** của một TokenReview, và `read` chỉ nhận `K8sReadVerb` ⇒ phải nới một interface hạng nhất (ADR-06,
  §4.6), việc mà `cluster-identity.test.ts` canh.
- **JWKS của chính cụm** (kiểm token SA như một JWT thường, một bộ kiểm cho cả sáu CI — hấp dẫn hơn hẳn). Nhưng
  `identity-script.ts:186` lấy issuer bằng `aws eks describe-cluster … cluster.identity.oidc.issuer` **lúc chạy script,
  trong cloud của khách**: Service 1 **không lưu** URL issuer đó ở đâu. Và chú thích `identity-script.ts:22-24` nói rõ
  **mọi cụm đều có CÙNG một chủ thể** `system:serviceaccount:udp-build:udp-builder` (đó là lý do GCP tách pool theo
  project) ⇒ chủ thể không nhận diện được project, **chỉ issuer làm được** ⇒ UDP phải học và lưu issuer lúc provision,
  cộng một lượt vá cho cụm đã có ⇒ cũng chạm đường provisioning.

Vì vậy: **61d-2a** = ba nhà cung cấp SaaS (GitHub Actions, GitLab CI, CircleCI), **không chạm cụm một dòng nào**.
**61d-2b** = bộ ký trong cụm cho CircleCI + Azure **và** Trusted Deploy cho ba CI trong cụm, nơi việc chọn giữa hai lối
trên được quyết với "mọi cụm cùng một chủ thể" làm đầu vào — vì nó có nghĩa toàn bộ bảo mật của lối JWKS nằm ở chỗ
issuer được lưu đúng. Tới hết 61d-2a, ba CI trong cụm giữ nguyên hành vi hôm nay (HMAC) và Portal nói rõ "chưa khả
dụng" kèm lý do.

**Một dữ kiện phải mang sang 61d-2b, kẻo làm lại sai:** KHÔNG dùng projected ServiceAccount token volume. Token của
projected volume do kubelet cấp và dùng lại suốt vòng đời của nó (chỉ xoay quanh 80% TTL), nên hai lượt build trong
cùng một giờ đọc ra **cùng một JWT, cùng một `jti`** ⇒ đập vào unique `(issuer, tokenId)` ⇒ CI trong cụm chỉ deploy
được một lần mỗi giờ. Repo đã có hàm đúng: `adapter-base/packaging/build-script.ts:558` `tokenRequestLines(audience,
file)` gọi `TokenRequest` bằng chính token của pod, mỗi lời gọi một token mới, và Role `udp-builder-token`
(`build-namespace.ts:46-63`) đã cho phép đúng việc đó — nên không cần chạm pod spec, và nó là cách DUY NHẤT chạy được
với Tekton (UDP không điều khiển pod của Tekton). Đây cũng là chữ của QĐ-17 ("TokenRequest"), bản plan trước đọc lệch
thành projected volume.

### Dữ kiện ngoài đã xác minh (R7)

Đọc tại tài liệu và tại chính OIDC discovery document ngày 02/10/2026; `jose` đo bằng một script chạy thật.

| Nhà cung cấp | `iss` (suy từ CẤU HÌNH, không từ token)           | Đường lấy khoá công khai                                       | Alg   | Mã một lần                                                  | Claim gắn với cấu hình                                      |
| ------------ | ------------------------------------------------- | -------------------------------------------------------------- | ----- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| GitHub       | `https://token.actions.githubusercontent.com`     | `https://token.actions.githubusercontent.com/.well-known/jwks` | RS256 | `jti` (có trong `claims_supported`)                         | `repository`, `workflow_ref`, `ref`                         |
| GitLab       | `config.gitlabUrl` đã chuẩn hoá                   | `${gitlabUrl}/oauth/discovery/keys`                            | RS256 | `jti`                                                       | `project_path`, `ref`, `ref_type`                           |
| CircleCI     | `https://oidc.circleci.com/org/${organizationId}` | discovery trên ĐÚNG issuer đó, `jwks_uri` phải CÙNG ORIGIN     | RS256 | **KHÔNG có `jti`** — dùng `oidc.circleci.com/job-id` (UUID) | `oidc.circleci.com/project-id`, `oidc.circleci.com/vcs-ref` |

`claims_supported` của GitHub lấy nguyên văn từ discovery document và CÓ cả `jti` lẫn `workflow_ref`. CircleCI mặc định
`aud = ORGANIZATION_ID` nên `aud` = địa chỉ webhook phải khai tường minh — **nhưng việc CircleCI cho nội suy biến vào
`aud` là một giả định CHƯA KIỂM**, và renderer chỉ có biến `$UDP_WEBHOOK_URL` chứ không có chuỗi thật. Phải kiểm trước
khi code mục 5; đường lùi đã có sẵn trường để làm: dùng `aud` mặc định rồi so với `tool_config.organizationId`.

**`jose` 6.2.12, đo bằng script** (fetch toàn cục bị thay bằng một hàm ném, nên mọi kết quả dưới đây là không gọi mạng):

| Câu hỏi                             | Kết quả                                                 |
| ----------------------------------- | ------------------------------------------------------- |
| Tiêm `fetch` riêng được không       | **Được** — `jose.customFetch` là một symbol được export |
| Thiếu `iat` khi có `maxTokenAge`    | Từ chối, `missing required "iat" claim`                 |
| `exp` đã qua nhưng `iat` còn mới    | Từ chối `ERR_JWT_EXPIRED`                               |
| JWKS hai khoá, token không `kid`    | Từ chối `ERR_JWKS_MULTIPLE_MATCHING_KEYS`               |
| ES256 khi ghim `algorithms:[RS256]` | Từ chối `ERR_JOSE_ALG_NOT_ALLOWED`                      |
| `aud` sai                           | Từ chối `ERR_JWT_CLAIM_VALIDATION_FAILED`               |

Nghĩa là `jose` tự fail-closed đúng năm chỗ, và `createEgressFetch` của repo đưa được vào nó ⇒ **không** phải tự lấy
JWKS bằng tay. Ghim **chính xác** `"jose": "6.2.12"` (nhà style của `services/core-backend/package.json`: thư viện nhạy
về bảo mật ghim chính xác — `@sigstore/verify 4.1.2`, `undici 7.30.0`).

**Phải đo một lần lúc hiện thực:** `exp − iat` thật của mỗi nhà cung cấp (quyết định lề của hàm dọn, mục 1).

### 61d-2a — các mục

1. **Bảng `webhook_token_uses` + hàm dọn.**
   - _Làm gì:_ `WebhookTokenUse(id, projectId, issuer, tokenId, pipelineId, environmentId, bodyDigest, deploymentId, usedAt, expiresAt)`, unique `(issuer, tokenId)` **có `map:` đặt tên tường minh** (hai chỗ trong repo bắt lỗi unique bằng cách so TÊN INDEX với một hằng — `rollout.repository.ts`, `environment-job.ts` — nên dựa vào tên Prisma tự sinh là rủi ro đổi-tên-im-lặng). `id` là UUIDv7 như `DeploymentEvent`/`AuditLog` (§2.4: bảng append-heavy). `bodyDigest` là **chính chuỗi HMAC hex** đã kiểm.
   - _Ai điền cột thời gian:_ `expiresAt` **không phải** một `DEFAULT` nào — nó là DỮ LIỆU lấy từ `exp` của token đã xác minh, và không được NHỎ hơn `exp`, nếu không lượt dọn xoá hàng trong lúc token còn sống và cửa sổ replay mở lại. `usedAt` dùng `@default(dbgenerated("clock_timestamp()"))`: theo đúng chữ của đoạn "Ai điền các cột thời gian" ở đầu §2.2 thì đồng hồ writer là đủ (một writer, không quyết định nào đọc thứ tự), **nhưng** hàng này là bằng chứng cho một lần cho phép deploy và sẽ bị đối chiếu với `deployment_events.occurred_at` — cột duy nhất do database cấp — nên với độ lệch đã đo 1 567 ms, `usedAt` theo đồng hồ máy có thể nằm SAU sự kiện nó cho phép. Giá bằng 0, chọn đồng hồ database.
   - _Không có `created_at`:_ hàng chỉ sinh đúng lúc dùng nên `used_at` thay vai nó. Viết câu đó vào §2.2, vì §2.2 là đặc tả chạy được và mọi bảng khác đều có `created_at`.
   - _Hàm dọn:_ `udp_prune_webhook_token_uses(integer)`, `SECURITY DEFINER`, so `expires_at < clock_timestamp() - interval` **bên trong thân hàm** (đồng hồ database, bên gọi không truyền được mốc), lề an toàn 1 giờ. Consumer (R6): gọi từ lịch đã có của Service 1 trong chính đợt này.
   - _Ở đâu:_ `packages/db/prisma/schema.prisma`; migration `<ts>_webhook_token_uses/migration.sql` với khối `-- Đường lùi:` dạng SQL dán chạy được (quy ước của mọi migration gần đây).
   - _Ảnh hưởng lan sang, năm chỗ:_ (i) `packages/db/tests/invariants/i22-writer-matrix.test.ts` — khai `udp_s1: APPEND_ONLY`, **không** một quyền nào cho `udp_s2`/`udp_s3` (tiền lệ `refresh_sessions`, `invitations`, `password_reset_tokens`: bảng chứa vật liệu định danh thì hai role kia không có cả SELECT), thêm bảng vào danh sách viết cứng của ô "không ai UPDATE/DELETE được bảng append-only", và khai hàm vào `DEFINER_FUNCTIONS` với **chữ ký `regprocedure` đầy đủ** (test khẳng định tập hàm `prosecdef` BẰNG danh sách khai, và EXECUTE đúng role, không `PUBLIC`, không `anon`/`authenticated`/`service_role` ⇒ migration phải `REVOKE ALL … FROM PUBLIC` trước khi cấp); (ii) `packages/design-lint/tests/writer-matrix.test.ts` đọc THẲNG bảng markdown §1.2 ⇒ thêm `` `WebhookTokenUse` `` vào hàng Service 1; (iii) §2.1 ERD phải có entity mới với ĐỦ cột — `schema-conformance.test.ts` khẳng định tập entity ERD **bằng** tập model và ERD với §2.2 liệt kê **cùng** tập cột; (iv) §2.2 bảng mới + khối index ngay dưới; (v) §2.3 Cascade Delete Policy một dòng.
   - _Sửa một khẳng định SAI của bản plan trước:_ tôi đã viết `retention.test.ts` "đòi mọi bảng có `expires_at` phải có hàm prune". Kiểm lại: tệp đó có **đúng một** test, tìm migration mới nhất định nghĩa `udp_prune_config_change_log`, bóc `interval 'N days'` và so với `CHANGE_FEED.retentionDays`. Không có luật chung nào — và repo có **bốn** bảng `expires_at` không hàm prune nào (`idempotency_keys`, `invitations`, `password_reset_tokens`, `refresh_sessions`). Nên hàm mới **không được chốt gì cả**: muốn cùng mức bảo đảm thì thêm `CICD_WEBHOOK.tokenUseRetentionDays` vào `packages/config/src/constants.ts` và một `it` chị em trong chính `retention.test.ts`. Làm việc đó trong đợt này.
2. **Phân biệt retry với replay — mục nặng nhất.**
   - _Làm gì:_ repo ĐÃ có chống trùng theo `pipelineId` (`pg_advisory_xact_lock` theo `(environmentId, pipelineId)`, thấy sự kiện cũ ⇒ `duplicate` 200), và `pipeline-template.ts:57-61` ghi rõ "`PIPELINE_ID` phải khác nhau giữa hai lượt chạy lại". Thứ tự bắt buộc:

     ```
     (ngoài tx)  HMAC đúng -> xác minh token (mọi I/O ở đây, hạn tổng 5 giây)
     (trong tx)  pg_advisory_xact_lock(envId:pipelineId)
                 dedup theo pipelineId -> duplicate ? trả duplicate 200, KHÔNG chạm bảng token
                 INSERT ... ON CONFLICT (issuer, token_id) DO NOTHING RETURNING id
                   1 hàng -> lần dùng đầu, đi tiếp
                   0 hàng -> đọc hàng cũ: bodyDigest TRÙNG -> retry thật, trả outcome cũ (200)
                                          bodyDigest LỆCH  -> từ chối, audit ở câu RIÊNG ngoài tx
     ```

   - _Vì sao `ON CONFLICT DO NOTHING` chứ không bắt unique violation:_ `23505` **abort cả transaction** nên sau đó không đọc được hàng cũ để phân biệt retry với replay, và mọi thứ ghi cùng tx mất theo. Repo đã có tiền lệ viết thành chữ ở `provisioning/prisma-ledger.ts:200-215` (`skipDuplicates` thay vì bắt `P2002`: "cùng một câu SQL, cùng một bảo đảm, nhưng KHÔNG sinh một dòng `prisma:error` cho một đường đi bình thường"), và `errors.ts:118-140` ghi rằng lỗi phát sinh **lúc COMMIT** tới dưới dạng `DriverAdapterError` với `code === undefined` nên `uniqueViolationIndexOf` **không nhận ra**.
   - _Vì sao `bodyDigest` chứ không `pipelineId`:_ phép dedup sẵn có tính cả `environmentId`, nên kẻ có secret HMAC gửi lại CÙNG `pipelineId` và CÙNG token nhưng `environment: production` sẽ KHÔNG rơi vào `duplicate`. Chuỗi HMAC chỉ bằng nhau khi thân không đổi một byte.
   - _Bảng "lối ra × token tiêu hay không"_ (mỗi dòng một ô test): `duplicate` ⇒ không tiêu; `started`/`pending` ⇒ tiêu; `rejected` của cổng chữ ký 61d-1 ⇒ **tiêu** (vì nó ghi `DEPLOY_FAILURE` và tx commit) — một quyết định có chủ ý, nghĩa là lượt sửa phải xin token mới; `unchanged`/`skipped` của rebase ⇒ không tiêu, vì không có sự kiện nào được ghi. Luật một câu: **token bị tiêu đúng khi một `deployment_events` được commit**.
3. **`cicd/trusted-deploy.ts` — xác minh, NGOÀI transaction và SAU HMAC.**
   - _Làm gì:_ `verifyTrustedDeploy({ expected, authorization, egressFetch, now })` thuần + I/O, **không nhận `tx`**; `recordTokenUse(tx, …)` chỉ INSERT. Hai luật vị trí: (a) gọi **sau** `verified()` — §8.3 quy định bốn tình huống "project không có / chưa bật CI/CD / chưa sinh secret / chữ ký sai" là CÙNG một 401 để không thành oracle dò project, nên không được làm việc đắt tiền hay trả mã phân biệt trước khi HMAC đúng; (b) **ngoài** `$transaction` — transaction của webhook giữ `pg_advisory_xact_lock` và `FOR NO KEY UPDATE` trên hàng project, giữ chúng xuyên qua một lời gọi HTTP ra ngoài là cách làm đứng cả control plane.
   - _Issuer allowlist tính TRƯỚC mọi lời gọi mạng,_ từ `(selectedTool, tool_config)` trong database; `iss` của token phải **bằng** nó theo so sánh chuỗi. Lấy discovery theo `iss` của token là **bypass toàn phần**: kẻ có secret HMAC tự dựng issuer của mình, tự ký, và chữ ký sẽ đúng. GitHub: JWKS viết cứng ⇒ **không gọi discovery lần nào**. CircleCI: discovery chỉ trên issuer mong đợi, `jwks_uri` phải cùng origin.
   - _CircleCI fail-closed:_ `circleci/index.ts:51-52` khai `organizationId` và `projectId` là `.optional()`; thiếu thì không có issuer mong đợi ⇒ Trusted Deploy không khả dụng và **không cho bật** `oidcRequired`; Portal nói rõ cần điền gì.
   - _Mọi lời gọi mạng đi `createEgressFetch`:_ `cluster-access/src/transport.ts:8-9` ghi thành luật rằng S1 gọi URL do người dùng nhập nên phải đi `createEgressFetch` có chặn SSRF **ngay trong `lookup`** (§12.1 T11). `gitlabUrl` là cấu hình MAINTAINER lưu được và regex hiện tại nhận cả `https://169.254.169.254`. **`egressFetch` hôm nay chỉ nối vào worker (`index.ts:86`), KHÔNG có trong `AppDeps`** ⇒ thêm vào `AppDeps` theo khuôn `repoSource` (tồn tại đúng để "test tiêm nguồn trong bộ nhớ, không bao giờ gọi mạng thật"), rồi đưa cho `jose` qua `[jose.customFetch]` (đã đo là chạy).
   - _Cache JWKS:_ theo issuer đã được cấu hình xác nhận, single-flight; `kid` chưa biết ⇒ refetch **có cooldown** (không cooldown thì một kẻ có secret HMAC gửi `kid` ngẫu nhiên liên tục biến UDP thành bộ khuếch đại DoS); fetch lỗi ⇒ phục vụ bản last-known-good trong trần 24 giờ; không có cả bản cũ ⇒ **503**, tuyệt đối KHÔNG rơi về HMAC (rơi về HMAC là chính thoái cấp mà `oidcRequired` sinh ra để chặn, và nó biến một sự cố của nhà cung cấp thành đường tắt).
   - _Luật thời gian:_ `jwtVerify(token, jwks, { issuer, audience, algorithms: ["RS256"], maxTokenAge: "10 minutes", clockTolerance: 60 })` — đã đo rằng `jose` tự đòi `iat`, tự kiểm `exp` độc lập, và tự ghim thuật toán. Trần 10 phút là trần CHÍNH SÁCH, chỉ làm NGẮN hơn `exp`. Chiều nguy hiểm là S1 chạy CHẬM hơn nhà cung cấp.
   - _Nhánh lấy từ CLAIM, không từ thân:_ QĐ-17 đòi "token của nhánh phụ không deploy được production". `ref`/`vcs-ref` trong token là thứ duy nhất không giả mạo được khi secret HMAC đã lộ, nên environment được quyết từ claim; claim lệch luật nhánh của template ⇒ từ chối. Đây là phần đáng tiền nhất của AC-11 và bản plan trước chỉ có một cụm chung chung.
4. **Mặt từ chối: 401 đồng nhất trước HMAC, mã chi tiết sau HMAC, và audit mọi lần.**
   - _Làm gì:_ union mới `TRUSTED_DEPLOY_REJECTIONS` ở `packages/shared-types/src/build.ts`, đúng khuôn `SIGNATURE_REJECTIONS` của 61d-1 và **cố ý KHÔNG vào `ERROR_CATALOG`**: catalog có đúng 25 mã, **không mã 401 hay 403 nào**, và `problem.ts:323` có `EXPECTED_ERROR_CODES = 25` kiểm **lúc nạp module** nên thêm một mã là sửa năm chỗ và làm service sập nếu quên. Trên dây là một trường **RIÊNG** `trustedDeploy`, không nhồi vào enum `signature` — hai cổng độc lập, nhồi chung là lặng lẽ đổi ngữ nghĩa của DORA và danh sách deployment.
   - _Audit:_ §8.3 đòi "chữ ký sai ghi `AuditLog cicd.webhook.rejected` (không ghi thân hay header)". Mỗi lần từ chối ở tầng token cũng ghi đúng action đó, ở **câu riêng ngoài transaction**, kèm lý do và `aud` nhận được (không có nó thì một lệch chuỗi là bế tắc không chẩn đoán được). Bearer token **không bao giờ** vào audit, log, hay `metadata` — I24 và §12 T3; luật "không ghi thân hay header" phủ cả header này, nói rõ ra.
   - _Mã hạ tầng vs mã token:_ JWKS/discovery/timeout ⇒ **503** (retryable, để `curl --retry` tự lành); token hay claim sai ⇒ **401** (terminal). Bản plan trước gộp tất cả vào "401/422", và 401 cho một lỗi mạng là một lỗi không tự lành.
   - _Ảnh hưởng lan sang:_ `wire.ts` (trường mới), `apps/portal/src/features/deployment/deployment.messages.ts` **cả `vi` và `en`** (`satisfies Record<…>` làm thiếu câu thành lỗi biên dịch), `deployment.dora.ts` đọc mã từ metadata, fixture vàng của danh sách deployment và của webhook.
5. **`aud` — một nguồn sự thật, và hôm nay nó KHÔNG tồn tại.**
   - _Dữ kiện sửa lại:_ bản plan trước viết "cùng chuỗi mà renderer sinh ra". **Sai.** `pipeline-template.ts:57-58` nói `UDP_WEBHOOK_URL` là "địa chỉ ĐẦY ĐỦ mà Portal hiện" — tức biến CI do **người dùng dán vào**; `cicd.service.ts:31` chỉ trả một **đường dẫn**; và `apps/portal/src/features/domain/CicdPanel.tsx:41` ghép `${window.location.origin}${cicd.webhookPath}` **ở trình duyệt**. Backend không có URL tuyệt đối ở đâu cả.
   - _Làm gì, ba việc chứ không một:_ (i) base công khai lấy từ `CORS_ORIGIN` đã có (tiền lệ ghép URL công khai: callback GitHub ở `auth.controller.ts`) — **không thêm biến thứ hai cho cùng việc** (R8); chuẩn hoá bằng cách dùng lại validator `oidcIssuerUrl` của `env-schema.ts:112-118`, validator DUY NHẤT trong repo chặn `/` cuối + query + fragment; (ii) một hàm ở `cicd.service.ts` ghép `base + API_PREFIX + webhookPathOf(...)`, `cicdStatusWire` trả thêm `webhookUrl` tuyệt đối — **giữ `API_PREFIX` ở nơi duy nhất của nó** (`core/http/api-prefix.ts`, chú thích giải thích vì sao chỉ được tồn tại một bản), không nhét vào env; (iii) `CicdPanel.tsx:41` **bỏ `window.location.origin`**, in `webhookUrl` của backend — thiếu bước này thì R8 vẫn hỏng.
   - _Không bao giờ dựng `aud` từ request:_ `TRUST_PROXY_HOPS` mặc định **0** (`env-schema.ts:353`) nên `req.hostname` LÀ header `Host` do bên gọi đặt; dựng `aud` từ đó thì phép kiểm thành "chuỗi của kẻ tấn công bằng chuỗi của kẻ tấn công". Và lowercase `projectId` khi dựng, vì regex UUID của webhook là case-insensitive và Postgres chuẩn hoá kiểu `uuid` nên URL viết hoa vẫn tra ra đúng project mà sinh chuỗi `aud` khác.
   - _Nói rõ `aud` chặn được gì:_ `aud` do workflow tự khai nên nó KHÔNG phải danh tính; nó chỉ chặn dùng chéo dịch vụ và dùng chéo project. Thứ chặn "một repo khác trong cùng org" là claim `repository`/`project_path`/`project-id` so với `tool_config` — ca này không giả định, vì `UDP_WEBHOOK_SECRET` rất hay được đặt làm org-level secret nên repo khác trong org đọc được secret HMAC. **Bỏ tham số `repo`** khỏi chữ ký: nếu nó lấy từ thân webhook thì "claim khớp cấu hình" thành "claim khớp thân do bên gọi gửi", tức không kiểm gì cả; `event.repo` khớp cấu hình là một phép kiểm nhất quán RIÊNG.
   - _Ba renderer:_ GitHub `permissions: id-token: write`; GitLab `id_tokens:` với `aud`; CircleCI `$CIRCLE_OIDC_TOKEN_V2` (kèm việc kiểm giả định `aud` ở trên). Token xin **trong CÙNG một step với `curl`**, không ghi ra tệp/artifact/job output: một job chờ duyệt environment 40 phút sẽ mang token 40 phút tuổi và bị trần 10 phút đánh chết. `notifyScript` (`pipeline-template.ts:65-84`) là **một** chỗ duy nhất phải thêm dòng `-H "Authorization: Bearer …"` cho cả sáu CI; bộ hợp đồng thêm một needle và một ô "token không vượt ranh giới job".
6. **`oidcRequired` — CỘT RIÊNG trên `domain_configs`.**
   - _Làm gì:_ `ALTER TABLE domain_configs ADD COLUMN oidc_required BOOLEAN NOT NULL DEFAULT false;`
   - _Vì sao không nằm trong `tool_config`:_ `tool_config` chỉ có một đường ghi, `replaceDomains` (`domain-config.store.ts:201-210`), và nó `upsert` với `toolConfig: t.config` — **ghi đè toàn phần** ⇒ cờ bị xoá sạch mỗi lần người dùng lưu cấu hình domain (tệ hơn bệnh "PUT /build tắt enforce" của 61d-1: mất im lặng). Thêm nữa khoá lạc quan của nó đòi `status IN EDITABLE_STATUSES` nên project đang chạy **không ghi được** ⇒ "tự bật ở token hợp lệ đầu tiên" bất khả thi. Tiền lệ đúng có sẵn và lý lẽ đã viết thành chữ: `webhook_secret` là cột riêng vì "UDP SINH nó, không phải người dùng chọn, nên nó không nằm trong `tool_config` (thứ `configSchema` của adapter kiểm)" (`20260926090000_cicd_webhook/migration.sql:3-6`). Phần thưởng: để ở cột riêng thì `replaceDomains` không chạm tới nó ⇒ lỗi "lưu cấu hình tắt mất cờ" **biến mất về mặt cấu trúc**, không cần một dòng mã nào.
   - _Khuôn `signing-enforce` phải lặp lại đủ:_ route riêng `PUT /projects/:id/domains/CICD/oidc-required` (MAINTAINER, `validateBody`, qua `requireProjectRole` — I10 và `project-route-guard.test.ts`); tự bật bằng `UPDATE … WHERE id = $1 AND oidc_required = false` rồi kiểm số hàng đổi, để nhật ký SYSTEM ghi đúng MỘT lần; khoá hàng `domain_configs` bằng `FOR NO KEY UPDATE` **trong** transaction (hàng đó được đọc NGOÀI transaction ở `cicd-webhook.service.ts:86-95`, dùng lại giá trị đó là TOCTOU — đúng thứ `signing-enforce` đã tránh); tiền điều kiện khi bật tay: không cho bật nếu UDP không kiểm được token của provider đó (CircleCI thiếu `organizationId`, hay provider là CI trong cụm cho tới 61d-2b) — tiền lệ `setSigningEnforce` từ chối bật khi chưa có khoá; tắt tay có xác nhận và nhật ký, và thông điệp 401 trỏ thẳng tới nó.
   - _Đổi tool thì reset:_ cờ sống trên hàng CICD nên đổi `selectedTool` phải đưa nó về `false` kèm audit SYSTEM và banner Portal — một project bật cờ từ GitHub rồi đổi sang Jenkins-trong-cụm sẽ **chắc chắn** tắc nếu cờ còn.
   - _Luật còn thiếu ở bản trước:_ "Authorization CÓ mặt mà không xác minh được ⇒ **luôn** từ chối, bất kể `oidcRequired`", mirror đúng luật cổng chữ ký 61d-1. Không có nó thì kẻ có secret HMAC chỉ cần BỎ header là xong, trên mọi project chưa flip.
   - _Ngưỡng bật thấp, phải nói ra:_ một DEVELOPER có quyền ghi một nhánh phụ thêm workflow và bật được cờ. Không phải lỗ hổng (người đó ở trong repo thật) nhưng là một đổi chế độ khó đảo do actor ít quyền nhất kích hoạt ⇒ van xả thủ công ở trên là bắt buộc. Chiều ngược lại an toàn: PR từ fork không được cấp `id-token: write`.
   - _Portal:_ cờ thuộc domain CI/CD nên hiện ở `features/domain/CicdPanel.tsx` (cùng nơi dữ liệu đến), **không** xé sang mục Đóng gói.
7. **Giới hạn phải công bố.** §16 thêm hai dòng đúng khuôn ba cột: (a) Trusted Deploy của ba CI trong cụm chưa khả dụng tới 61d-2b, kèm lý do RBAC/issuer ở trên; (b) discovery/JWKS thật của ba nhà cung cấp là **nợ kiểm chứng** (bộ test cố ý dựng JWKS giả trong tiến trình, không gọi mạng) ⇒ một mục mới trong `docs/measurements/kiem-chung-con-no.md` với **sáu trường** và bump "Số mục hiện tại" (`debt-ledger.test.ts` khẳng định con số đó bằng số mục đếm được, và §16 trích `Sổ nợ: <mã>` phải tồn tại). Sửa ô "Hướng mở rộng" của dòng CircleCI-trên-Azure từ "(61d-2)" thành "(61d-2b)", vì 61d-2a không đóng giới hạn đó — để nguyên là tài liệu nói dối sau khi commit. Portal nói: `aud` không phải phép cấp quyền; lớp OIDC không chứng minh nhánh của ba CI trong cụm; CircleCI dùng job-id nên một job chỉ báo được một lần với một thân duy nhất.
8. **Bất biến mới I41 và hai bản chép của bảng dữ kiện.**
   - _Làm gì:_ I41 "một token của một lượt chạy không dùng được lần thứ hai, và điều đó do database cưỡng chế" — đúng tiêu chí mở đầu §13.3 ("vỡ thì hệ thống sai một cách âm thầm": replay được nhận thì deploy vẫn xanh, không ai thấy gì), cùng họ I22/I39. Hai nửa: (a) gửi lại cùng token với thân ĐỔI ⇒ từ chối, không sự kiện deploy mới, kiểm bằng HTTP thật; (b) `iss` không thuộc cấu hình ⇒ từ chối và **0 lời gọi mạng**. Bump "Tổng cuối: **42 bất biến**" (`docs/UDP_design.md:8454`) thành 43 — `references.test.ts` khẳng định con số đó.
   - _Fitness function:_ một test `design-lint` khẳng định map `provider → (issuer, đường JWKS, alg, claim một-lần, claim cấu hình)` trong mã **bằng** bảng đã xác minh ở plan và §16, đúng khuôn `cluster-identity.test.ts`. Một lỗi chính tả trong chuỗi issuer khi đó thành một test đỏ, chứ không thành "từ chối mọi thứ" bí ẩn ở production.
9. **Kiểm chứng (R9) — mọi phép khẳng định TẤT ĐỊNH, không phụ thuộc đồng hồ hay độ trễ của máy chạy test.**
   - Spy `egressFetch` tiêm vào, so bằng `toEqual` chứ không `toContain`: GitHub ⇒ đúng một lời gọi tới JWKS viết cứng và **không** lời gọi discovery nào; GitLab ⇒ đúng `${gitlabUrl}/oauth/discovery/keys`; CircleCI ⇒ discovery rồi `jwks_uri`. So tuyệt đối làm một lời gọi THỪA thành đỏ.
   - Issuer thù địch: token ký hoàn hảo bằng khoá của kẻ tấn công, claim khác đều đúng ⇒ từ chối **và** `expect(spy.mock.calls).toEqual([])`.
   - Sentinel `vi.stubGlobal("fetch", …)` ném trong cả tệp test OIDC, để `jose` dùng fetch toàn cục thì mọi ô đỏ ngay thay vì lặng lẽ ra Internet trong CI.
   - Egress guard thật trong đường đi: `gitlabUrl = "https://169.254.169.254"` với `createEgressFetch` THẬT và `lookup` tiêm ⇒ lỗi phải là chặn egress, không phải timeout.
   - Đồng hồ tiêm vào, cả hai chiều: `now` trước `iat`; `exp` đã qua nhưng `iat` còn mới; `exp = iat + 2 phút` trình ở `iat + 5 phút`.
   - Cặp retry/replay: cùng token + thân y nguyên ⇒ **200 `duplicate`**, đúng MỘT `deployment_events`, KHÔNG hàng token thứ hai; cùng token + thân đổi `environment` sang production ⇒ **từ chối**, không sự kiện mới. Cộng bảng "lối ra × token tiêu" ở mục 2, mỗi dòng một ô.
   - Thứ tự: HMAC sai + Bearer hợp lệ ⇒ 401 đồng nhất **và 0 lời gọi mạng**.
   - Nhánh: token mang `ref` nhánh phụ xin deploy production ⇒ từ chối (đúng câu của QĐ-17).
   - `aud`: chuỗi Portal hiện **bằng** chuỗi bộ kiểm mong đợi; URL viết hoa vẫn khớp.
   - Cộng: `pnpm typecheck`, `pnpm format:check`, `db:verify-chain`, `prisma migrate diff` không khác biệt, bộ hợp đồng CI/CD, design-lint, Portal, và bộ test đầy đủ của core-backend chia hai chặng như lần 61d-1.
10. **Đường lùi (R10):** mốc là commit của 61d-1 (chưa commit thì bản chụp `git diff` ở scratchpad). Migration chỉ THÊM một bảng, một cột và một hàm ⇒ lùi bằng `DROP TABLE` + `DROP FUNCTION` + `DROP COLUMN`; `oidcRequired` mặc định `false` nên pipeline cũ không đổi hành vi cho tới khi có token hợp lệ đầu tiên.
11. **Kiểm thoái cấp (R11) — trả bằng ô test, không bằng lập luận:** HMAC có bị làm yếu đi không; `signing-enforce` và `oidcRequired` có vô hiệu hoá nhau không; lượt retry hợp lệ của CI có bị đánh chết oan không; một sự cố JWKS của nhà cung cấp có mở được đường tắt nào không; cờ bật rồi có cách nào làm project tắc vĩnh viễn không; và luật "401 đồng nhất" của §8.3 có còn nguyên cho bốn tình huống trước HMAC không.

**Cũng phải sửa spec:** QĐ-1 của `plan61-spec.md` nói "61d chia ba". Việc chia 61d-2 thành 61d-2a/61d-2b là một quyết
định mới, nên thêm một dòng vào QĐ-1 để spec vẫn là bản đã duyệt chứ không phải plan tự mở rộng.

### 61d-2a — đã làm, và những chỗ CHỆCH plan (R5)

Ghi ra vì plan và mã không được trôi khỏi nhau, và vì mỗi chỗ chệch dưới đây đều do một dữ kiện đo được, không do tiện tay.

1. **`aud` của CircleCI là `organizationId`, không phải địa chỉ webhook.** Plan viết `aud` = địa chỉ webhook cho cả ba
   nhà cung cấp và tự đánh dấu "việc CircleCI cho nội suy biến vào `aud` là giả định CHƯA KIỂM". Đã kiểm tại tài liệu
   CircleCI: `aud` mặc định LÀ `ORGANIZATION_ID` và đổi nó cần một tính năng riêng ở mức tổ chức chứ không đặt được
   trong `config.yml`. Nên dùng đúng đường lùi đã đăng ký trước trong plan, và công bố cái giá ở §16: với CircleCI,
   `aud` không buộc token vào đúng project nên việc buộc đó dựa hoàn toàn vào claim `project-id`.
2. **Renderer in THẲNG địa chỉ tuyệt đối, qua một mở rộng bối cảnh `PipelineTemplateParams.webhookUrl`.** Plan định
   dựa vào biến `$UDP_WEBHOOK_URL`; nhưng biến đó là giá trị NGƯỜI DÙNG dán vào, nên `aud` sẽ suy từ trình duyệt họ
   đang mở. In chuỗi của máy chủ xoá hẳn chế độ hỏng "lệch một dấu `/` là 401 vĩnh viễn". **E1 không đổi**: nó đếm số
   lần phải NỚI LỎNG bộ hợp đồng (§13.2), còn đây không nới lỏng phép kiểm nào — cùng lý do mà `build` của 61b không
   làm E1 tăng.
3. **Cờ `oidcRequired` là CỘT RIÊNG trên `domain_configs`, và reset bằng TRIGGER.** Plan để ngỏ chỗ lưu. Đường ghi duy
   nhất của `tool_config` là `replaceDomains`, vốn ghi đè toàn phần và chỉ chạy khi project còn sửa được ⇒ cờ nằm
   trong đó sẽ bị xoá im lặng và không bao giờ tự bật được. Reset khi đổi tool làm ở tầng database vì `tool_config`
   không phải đường ghi duy nhất của hàng CICD.
4. **Trường `trustedDeploy` trên dây thu hẹp còn `VERIFIED | null`.** Plan định mang cả tập mã từ chối. Nhưng một lần
   từ chối là lỗi XÁC THỰC nên không sinh bản ghi deployment nào — ghi `DEPLOY_FAILURE` cho nó sẽ để ai có secret HMAC
   bơm sự kiện hỏng vô hạn và làm bẩn Change Failure Rate. Mã từ chối đi đường `AuditLog`, nên enum trên dây chỉ khai
   những giá trị thật sự xảy ra.
5. **Dòng xin token đi QUA `notifyScript`, không ghép ở adapter.** Bộ hợp đồng CI/CD bắt được: ở hai trong sáu chỗ,
   phép thụt lề chỉ áp cho kết quả của `notifyScript` nên dòng ghép bên ngoài rơi sai cột và sinh YAML không hợp lệ.
6. **Đường CI-trong-cụm dời sang 61d-2b** (đã ghi ở đầu mục này và ở QĐ-1 của spec). Dữ kiện mang sang: KHÔNG dùng
   projected ServiceAccount token volume — token của nó dùng lại suốt vòng đời nên hai lượt build trong cùng một giờ
   có cùng một `jti` và đập vào chính bảng "dùng một lần"; `tokenRequestLines` đã có sẵn và cấp token mới mỗi lần.

7. **Route `PUT /oidc-required` phải có mẫu golden và test HTTP riêng — phát hiện bởi chính bộ hợp đồng dây.**
   Plan không nói gì về việc này, và tôi làm thiếu: route mới đi `sendJson` nhưng không được khai trong `ROUTES` của
   `tests/wire-golden.test.ts` và không ô test nào gọi nó qua HTTP (sáu ô Trusted Deploy cũ sửa cờ thẳng ở database).
   `wire-golden` đỏ đúng chỗ đó: "không route sendJson nào thiếu dòng trong ROUTES". Cách sửa KHÔNG phải khai thêm một
   dòng vào `NO_GOLDEN_YET` — đó là nới lỏng một cổng để che một lỗ test — mà là viết sáu ô HTTP thật cho route
   (bậc quyền MAINTAINER, thân `strict`, idempotent không ghi nhật ký lần hai, tiền điều kiện 409, **van xả tắt được
   kể cả khi `available` đã false**, và trigger database hạ cờ khi đổi CI). Mẫu golden sinh ra từ chính lượt chạy đó.
   Bài học ghi lại: một route mới KHÔNG được coi là xong khi service của nó có test — tầng route có ba tính chất
   riêng mà chỉ đường HTTP đo được.

**Cổng đã qua:** typecheck và prettier toàn repo; `prisma migrate diff` không khác biệt; `db:verify-chain` xanh;
design-lint 162/162 (thêm luật sổ kép cho bảng nhà cung cấp và luật retention cho bảng token); bộ hợp đồng sáu CI
324/324; `trusted-deploy` 22/22 (tất định, không gọi mạng); `cicd-webhook` 37/37 (gồm 7 ô Trusted Deploy qua HTTP và
database thật, và 6 ô cho route bật/tắt); `wire-golden` 124/124; `@udp/db` 358/358; Portal 365 + 17.

**Còn nợ kiểm chứng:** `trusted-deploy-real` — chưa chạy với token do nhà cung cấp THẬT phát (cần UDP có địa chỉ công
khai; không tốn tiền). Chi tiết và dấu hiệu đạt ở `docs/measurements/kiem-chung-con-no.md`.

## 61d-2b — chia ba đợt, và vì sao

Chữ cũ của 61d-2b (`plan61-plan.md:171`) gồm hai việc: bộ ký trong cụm cho CircleCI + Azure, **và** Trusted Deploy
cho ba CI trong cụm. Vòng kiểm dữ kiện ngoài của đợt này (R7, bảng dưới) làm đổi cả phạm vi lẫn thứ tự:

- Dữ kiện 5 phát hiện **một lỗi đang sống**: `sub` của GitHub Actions đã đổi hình từ 15/07/2026, mà script danh tính
  của UDP so theo hình cũ ở AWS và Azure ⇒ mọi repo GitHub tạo (hay đổi tên, hay chuyển chủ) sau mốc đó **không đẩy
  và không ký được**. Vòng QA của plan này tìm thêm ba lỗ cùng họ "UDP tin nhiều hơn cần" trong chính tệp đó. Đó là
  sửa lỗi, không phải tính năng mới, nên nó đi **trước**.
- Dữ kiện 1 làm Trusted Deploy cho ba CI trong cụm rẻ đi hẳn một bậc: không quyền mới, không bootstrap lại cụm đang
  chạy, không lưu issuer. Nó vô hiệu hoá chính lý do mà §16:8398 đang nêu.
- Dữ kiện 4 xác nhận bộ ký trong cụm vẫn là lối duy nhất cho CircleCI + Azure, và nó là việc **duy nhất** trong ba
  việc phải GHI vào cụm khách (namespace/SA/Role mới, Job, image cosign ghim digest, quyền đẩy chữ ký).

Vậy: **61d-2b-0** = chủ thể tin cậy của script danh tính (sửa lỗi). **61d-2b-1** = Trusted Deploy cho Jenkins,
Tekton, Drone (chỉ ĐỌC khoá công khai của cụm). **61d-2b-2** = bộ ký trong cụm (plan chi tiết viết khi bắt đầu, R1),
với đầu vào đã chốt: chữ ký do UDP đặt **sau** cổng deploy không chứng minh nguồn gốc build, chỉ chứng minh "UDP đã
cho phép byte này" — giá trị thật là để Kyverno (61d-3) có chữ ký mà kiểm lúc admission; câu đó phải vào §8.3 và §16
bằng đúng chữ đó.

### Dữ kiện ngoài đã xác minh (R7) — đọc ngày 03/10/2026 tại nguồn

| #   | Câu hỏi quyết định thiết kế                                           | Kết quả, và nguồn                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | UDP đọc được khoá công khai của cụm mà **không** cần quyền mới không? | **Được, không cần quyền nào.** Kubernetes `plugin/pkg/auth/authorizer/rbac/bootstrappolicy/policy.go`: ClusterRole `system:service-account-issuer-discovery` cho `get` trên `/.well-known/openid-configuration` và `/openid/v1/jwks`; ClusterRoleBinding mặc định là `NewClusterBinding("system:service-account-issuer-discovery").Groups(serviceaccount.AllServiceAccountsGroup)` — **mọi ServiceAccount trong cụm**, kể cả `udp-system/udp-tooling`. |
| 2   | Token của `TokenRequest` có `jti` không?                              | **Có, ổn định từ 1.32.** KEP-4193: `ServiceAccountTokenJTI` alpha 1.29, beta 1.30, stable **v1.32**; nội dung là "generates a UUID which can be later used to trace the requests that a specific issued token has made to the apiserver". UDP chạy Kubernetes 1.33–1.35 (ma trận Kyverno của 61d-3).                                                                                                                                                   |
| 3   | Ghim RS256 cho token SA được không?                                   | **Không.** `pkg/serviceaccount/openidmetadata.go`: `id_token_signing_alg_values_supported` **suy từ khoá đang hoạt động** — `RS256` (RSA) hay `ES256`/`ES384`/`ES512` (ECDSA P-256/384/521); `response_types_supported` cố định `["id_token"]`. `HS*` và `none` không bao giờ xuất hiện.                                                                                                                                                               |
| 4   | Azure đã nhận CircleCI chưa?                                          | **Chưa.** Microsoft Learn "Flexible federated identity credentials (preview)", `ms.date` 18/09/2026: "Flexible federated identity credentials support is currently provided for matching against GitHub, GitLab, and Terraform Cloud issued tokens." Cùng trang: FIC cổ điển trần **20** mỗi identity, và FIC linh hoạt **chưa dùng được qua Azure CLI/PowerShell/Terraform**.                                                                         |
| 5   | `sub` của GitHub Actions có đổi hình không?                           | **Đã đổi và đã hiệu lực.** GitHub Changelog 23/04/2026: hình cũ `repo:octocat/my-repo:ref:refs/heads/main`, hình mới `repo:octocat@123456/my-repo@456789:ref:refs/heads/main`; **từ 15/07/2026 áp tự động** cho repo mới tạo, đổi tên, hay chuyển chủ. Claim `repository` **không đổi** — đó là lý do Trusted Deploy của 61d-2a (đọc `repository`/`ref`, không đọc `sub`) miễn nhiễm.                                                                  |

**`jose` 6.2.12 — đo bằng script, khoá sinh trong tiến trình, không một lời gọi mạng nào:**

| Câu hỏi                                                        | Kết quả                                                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ES256` với `algorithms: ["ES256"]`                            | **Nhận**                                                                                              |
| `ES256` với `algorithms: ["RS256"]` (ghim cứng như ba CI SaaS) | Từ chối `ERR_JOSE_ALG_NOT_ALLOWED` ⇒ ghim RS256 sẽ chặn một cụm dùng khoá EC                          |
| `RS256` và `ES256` với `algorithms: ["RS256","ES256"]`         | Nhận cả hai ⇒ cụm đang xoay khoá vẫn chạy                                                             |
| `algorithms: []` (giao với allowlist ra rỗng)                  | Từ chối `ERR_JOSE_ALG_NOT_ALLOWED` ⇒ danh sách rỗng **fail-closed**, là lớp thứ hai dưới phép trả 503 |
| `sub` là một ServiceAccount khác                               | **`jose` NHẬN** ⇒ phép kiểm chủ thể phải do mã của UDP làm, không có sẵn                              |
| Token ký bằng khoá cụm khác, cùng `kid`                        | Từ chối `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`                                                       |

## 61d-2b-0 — chủ thể tin cậy của script danh tính (sửa lỗi)

Bốn lỗ, cùng một họ: script tin một chủ thể rộng hơn chủ thể nó muốn tin. Cả bốn nằm trong
`services/core-backend/src/modules/packaging/identity-script.ts`.

### Mục 0.1 — ghim hai số id bất biến của GitHub

- _Làm gì:_ mọi chỗ so `sub` của GitHub nhận **hai chủ thể KHỚP ĐÚNG**, không ký tự đại diện: hình cũ
  `repo:<owner>/<name>:ref:refs/heads/<b>` và hình bất biến
  `repo:<owner>@<ownerId>/<name>@<repoId>:ref:refs/heads/<b>`. AWS: thêm vào mảng của `StringLike`
  (`identity-script.ts:202` đã nhận mảng). Azure: FIC thứ hai cho mỗi nhánh.
- _Vì sao KHÔNG dùng `repo:<owner>@*/<name>@*`:_ `*` của `StringLike` khớp **zero hoặc nhiều** ký tự nên nó bỏ luôn
  hai số id — đúng hai số mà hình bất biến sinh ra để chặn. Kịch bản thật: repo `acme/web` đổi tên ⇒ tên cũ trống ⇒
  ai tạo được repo trong org đó tạo lại `acme/web` ⇒ token repo MỚI khớp trust policy ⇒ đẩy image vào
  `<registryRef>/<slug>` (qua `assertOwnImage`) **và ký bằng khoá KMS của project** ⇒ qua luôn cổng chữ ký 61d-1.
  Chiều owner bị chiếm tên cũng vậy. Một hình lỏng hơn (`repo:acme*/web*`) còn khớp cả `acme-khac/web`.
- _Vì sao GIỮ hình cũ lại an toàn — lý lẽ duy nhất biện minh cho nó:_ từ 15/07/2026 GitHub áp hình bất biến cho mọi
  repo **mới tạo, đổi tên, hay chuyển chủ** (dữ kiện 5). Nên một `sub` hình CŨ chỉ có thể đến từ một repo đã tồn tại
  trước mốc đó và **chưa bao giờ** đổi tên hay chuyển chủ — tức đúng repo của project. Repo của kẻ tấn công (luôn là
  repo mới) phát hình bất biến, không khớp hình cũ; mà hình bất biến thì đã ghim id. Hai hình khớp đúng ⇒ đóng lỗ
  squat **và** không làm chết project có repo cũ. Câu này phải nằm trong chú thích mã, không chỉ trong plan.
- _Hai số id lấy ở đâu:_ **trong script**, `curl https://api.github.com/repos/<owner>/<name>` lấy `.id` và
  `.owner.id`; repo riêng tư cần `GH_TOKEN`. UDP **không** lưu được credential GitHub: `repo-source.ts:9-15` ghi rõ
  token của lượt quét "chỉ sống trong lượt quét: không log, không lưu", nên backend không có đường tự đọc hai số đó
  lúc sinh script. Không đọc được ⇒ **script dừng** với câu nói đúng việc cần làm (`export GH_TOKEN=… rồi chạy lại`):
  một script chạy nửa vời để lại danh tính chạy được hôm nay và chết đúng ngày repo đổi tên — lỗi không ai truy được.
- _GCP: ràng theo id, không theo tên._ `gcpCondition:430` đang ràng `assertion.repository` (TÊN) — cùng lỗ squat, chỉ
  chưa ai gọi tên. Đổi: mapping thêm `attribute.repository_id=assertion.repository_id`, điều kiện CEL ràng
  `assertion.repository_id` + `assertion.repository_owner_id` + `assertion.ref`.
- _Ở đâu:_ `identity-script.ts` (`awsSubjects`, `azureScript`, `gcpMapping`, `gcpCondition`, một hàm chung sinh dòng
  đọc id), `apps/portal/demo/mock/build.ts:297-299` (chuỗi chủ thể minh hoạ của bản xem thử), §16 một dòng, và mục
  Đóng gói của Portal: project đã chạy script trước đợt này **phải chạy lại** — câu đó hiện ở "việc cần làm".
- _Ảnh hưởng lan sang:_ `tests/identity-script.test.ts` (bộ 3 cloud × 4 CI × 2 registry; `:155` chạy `bash -n` nên
  lệnh `curl` mới phải đúng cú pháp; `:177` khẳng định không có `refs/heads/*`), `tests/packaging.integration.test.ts:206-208`
  (đang `toContain("repo:acme/web:ref:refs/heads/main")` — giữ, và thêm khẳng định hình bất biến).

### Mục 0.2 — federated credential của Azure phải HỘI TỤ

- _Làm gì:_ `federate()` hiện là `show || create` (`identity-script.ts:483-486`) — không `update`, không xoá. Sửa:
  so chủ thể hiện có, khác thì `delete` rồi `create`; và **xoá** FIC `github-*`/`gitlab-*` không còn trong `branches`.
- _Vì sao:_ header của chính script khai "Chạy lại an toàn: chỉ tạo thứ chưa có và **đưa quyền về đúng mô tả**"
  (`:122`), mà AWS làm đúng thế (`update-assume-role-policy`, `:204-208`) còn Azure thì không ⇒ chủ thể của một
  environment đã xoá vẫn được tin mãi. Sau mục 0.1 mỗi nhánh tốn **2** FIC nên trần 20 của Azure (dữ kiện 4) thành
  10 nhánh: script kiểm trước và dừng với câu nói rõ, thay vì để `az` trả lỗi hạn mức ở nhánh thứ 11.
- _Ảnh hưởng lan sang:_ `tests/identity-script.test.ts` thêm ô "có lệnh xoá FIC lạc" và ô trần nhánh.

### Mục 0.3 — pool Workload Identity của GCP: thu hẹp từ cả pool xuống một attribute

- _Làm gì:_ `identity-script.ts:364` bind `principalSet://…/workloadIdentityPools/$POOL/*` ⇒ **mọi** provider từng
  tạo trong pool mạo danh được service account, mà provider đặt tên theo loại CI (`:301`) nên đổi CI vẫn để provider
  cũ sống: project chuyển từ GitHub sang Jenkins-trong-cụm vẫn cho repo GitHub cũ đẩy và ký. Sửa: bind theo
  **attribute** — GitHub `attribute.repository_id/<id>`, GitLab `attribute.project_path/<path>`, CircleCI
  `attribute.project_id/<id>`, in-cluster `subject/system:serviceaccount:udp-build:udp-builder`. **Tiền tố là một
  phần của giá trị:** `subject/` đi với `principal://` (một danh tính), `attribute.<tên>/` đi với `principalSet://`
  (một tập) — dùng lẫn thì IAM từ chối member.
- _Vì sao bind theo attribute mà không theo provider:_ tra tài liệu GCP (Principal identifiers), `principalSet` chỉ
  có ba hình — `attribute.<tên>/<giá trị>`, `subject/<chủ thể>`, và `/*` cho cả pool. **Không có** hình theo provider.
- _Hội tụ:_ tập loại CI là hữu hạn và UDP biết hết, nên script **xoá** member của các loại CI khác và member `/*` cũ,
  rồi thêm member của loại đang bật ⇒ chạy lại sau khi đổi CI là hội tụ thật.
- _Ảnh hưởng lan sang:_ `tests/identity-script.test.ts` (ô "không còn member cả-pool", ô "có lệnh xoá member của loại
  CI khác").

### Kiểm chứng của 61d-2b-0 (R9) — so chuỗi, không gọi mạng, không cần cloud

1. AWS: trust policy có **đúng hai** chủ thể mỗi nhánh, cả hai khớp đúng; và `not.toContain("@*")` — ô này chốt đúng
   lỗ P1 để không ai "tiện tay" đưa ký tự đại diện trở lại.
2. Một ô lập luận-thành-test: chuỗi `sub` của một repo cùng tên khác id **không** khớp bất kỳ chủ thể nào script sinh
   (so chuỗi thuần, không cần IAM).
3. Azure: hai FIC mỗi nhánh, có lệnh xoá FIC lạc, có kiểm trần 20.
4. GCP: điều kiện CEL ràng `repository_id` + `repository_owner_id`; member là `attribute.repository_id/<id>`; không
   còn member `/*`; có lệnh xoá member của ba loại CI còn lại.
5. `bash -n` xanh cho cả 24 tổ hợp (3 cloud × 4 CI × 2 registry) — bộ test đã có, chỉ cần không làm đỏ.
6. Thiếu `GH_TOKEN` với repo riêng tư: script dừng, và câu nhắn chứa đúng chữ `GH_TOKEN`.
7. Bản xem thử: chuỗi chủ thể minh hoạ bằng chuỗi script thật sinh (một hàm dùng chung, không hai bản chép).

### Đường lùi (R10) và kiểm thoái cấp (R11) của 61d-2b-0

Không migration, không đổi dữ liệu, không đổi dây ⇒ `git revert` một commit. Script chỉ **thêm** chủ thể tin cậy và
**xoá** chủ thể lạc; project đã chạy script cũ không hỏng thêm, và chạy lại script mới đưa về đúng mô tả.

Kiểm thoái cấp: (a) có chủ thể nào ngoài repo/project của chính project trở nên tin cậy không; (b) project có repo
GitHub **cũ** (hình `sub` cũ) có còn đẩy và ký được không; (c) việc xoá member/FIC lạc có xoá thứ UDP không tạo ra
không (chỉ xoá theo đúng tên UDP sinh); (d) `bash -n` và 24 tổ hợp có còn xanh không; (e) ba cloud × bốn CI có cloud
nào mất đường đẩy registry không.

### 61d-2b-0 — đã làm, và những chỗ CHỆCH plan (R5)

1. **Cảnh báo "chạy lại script" là một CÂU dưới script, không phải một mã việc cần làm.** Plan viết "câu đó hiện ở
   việc cần làm". Làm xong mới thấy không làm được đúng thế: `buildTodoWire` là danh sách việc UDP **biết chắc** còn
   thiếu, mà `settings.identity` chỉ lưu ARN/clientId — **không có dấu thời gian**, nên UDP không phân biệt được danh
   tính tạo bằng script cũ với danh tính tạo bằng script mới. Một mã việc cần làm hiện ra cho mọi project GitHub
   (kể cả project vừa chạy script mới) là một việc cần làm nói sai sự thật. Nên: một câu ở mục Danh tính build, chỉ
   khi `ci === "github-actions"`, nói rõ mốc 03/10/2026 — người đọc tự biết mình thuộc bên nào. Không thêm giá trị
   nào vào dây.
2. **Thêm một dòng đe doạ T14, plan không dự kiến.** Lỗ của mục 0.1 không phải "sai định dạng" mà là một đường tấn
   công có tên: lấy lại một cái TÊN đã trống (repo-jacking). §12.1 là chỗ của nó, và viết nó ở đó mới giải thích được
   vì sao hai lỗ còn lại (pool cả-POOL của GCP, FIC không hội tụ của Azure) là **cùng một họ** chứ không phải ba việc
   rời. Bảng §16 giữ hai dòng giới hạn còn lại sau khi sửa (phải chạy lại script; trần 10 nhánh của GitHub + Azure).
3. **Sửa một chú thích SAI mà chính 61d-2a viết ra.** `cicd-webhook.service.ts` nói 503 là "để `curl --retry` của
   bước báo tự lành", nhưng `pipeline-template.ts:92` sinh `curl -sS --fail` **không có** `--retry`. Không gộp
   `--retry` vào đợt này (nó đổi template của cả sáu CI nên thuộc 61d-2b-1, nơi 503 thành lối ra thường gặp), nhưng
   để nguyên một câu sai trong mã là nợ ⇒ chú thích giờ nói đúng hiện trạng và trỏ sang đợt sẽ sửa.
4. **GCP: mapping thêm cả `attribute.repository_owner_id`,** không chỉ `repository_id`. Điều kiện CEL ràng cả hai số
   (một id repo là duy nhất toàn cục nên về lý chỉ cần nó, nhưng ràng cả hai là điều mà chính Microsoft đòi ở FIC
   linh hoạt của họ — "must match `sub` and one or both of the following immutable claims" — và nó làm điều kiện đọc
   được bằng mắt).
5. **Một lỗi của chính tôi, bắt được bằng cách tra tài liệu trước khi tin mã mình vừa viết.** Bản đầu dùng
   `principalSet://…/subject/system:serviceaccount:udp-build:udp-builder` cho CI trong cụm. Tài liệu "Principal
   identifiers" của GCP chỉ có `principal://…/subject/<chủ thể>` cho một danh tính, còn `principalSet://` dành cho
   `attribute.<tên>/<giá trị>`, `group/<id>` và `*`. Dùng lẫn thì IAM từ chối member và project CI-trong-cụm không
   đẩy được — mà không ô test nào bắt được, vì test chỉ so chuỗi. Giờ `gcpPrincipal` trả về **cả tiền tố**, và ô test
   khẳng định đúng tiền tố cho từng loại CI.
6. **Dọn member/credential lạc làm bằng cách LIỆT KÊ rồi lọc theo tiền tố của chính UDP,** không bằng cách dựng lại
   danh sách cho từng loại CI. Lý do đo được: script chỉ biết cấu hình của loại CI **đang bật**, nên nó không dựng
   nổi chuỗi member của loại khác (ví dụ `projectPath` của GitLab khi project đang dùng GitHub). Liệt kê rồi lọc
   `"$POOL_PREFIX"*` (GCP) và `github-*|gitlab-*|udp-builder` (Azure) hội tụ được mà vẫn không chạm thứ UDP không tạo.

**Cổng đã qua:** `pnpm typecheck` (backend + Portal) 0 lỗi; `prettier --check` sạch; `identity-script` **38/38** (29
cũ + 9 mới, gồm `bash -n` cho cả 24 tổ hợp cloud × CI × registry); `packaging` tích hợp 8/8; design-lint 162/162;
Portal 365; bản xem thử 17/17.

**Kiểm thoái cấp (R11) — trả bằng ô test:** (a) không chủ thể nào ngoài repo của project trở nên tin cậy —
`not.toContain("@*")`, `not.toContain("acme*")`, và một ô dựng đúng chuỗi `sub` của repo cùng tên khác id rồi khẳng
định nó **không** nằm trong tập chủ thể được tin; (b) project có repo GitHub cũ vẫn đẩy và ký được — cả hai hình chủ
thể đều có mặt, khẳng định bằng `toEqual` trên tập 4 chuỗi; (c) phép dọn chỉ xoá tên UDP đặt — khẳng định đúng hai
mẫu lọc; (d) `bash -n` xanh cho 24 tổ hợp, kể cả nhánh vượt trần 20 FIC; (e) ba cloud × bốn CI không cloud nào mất
đường đẩy registry — vòng test cũ vẫn xanh nguyên.

## 61d-2b-1 — Trusted Deploy cho Jenkins, Tekton, Drone

### Mục 1.1 — `ClusterAccess.issuerKeys()`

- _Làm gì:_ thêm đúng một phương thức vào `ClusterAccess` (`packages/adapter-core/src/cluster.ts`):
  `issuerKeys(): Promise<{ issuer: string; algorithms: readonly string[]; jwks: unknown }>`; hiện thực ở
  `cluster-access/src/direct.ts` bằng `tokenFor("tooling")` + `transport.request` tới
  `${apiEndpoint}/.well-known/openid-configuration` rồi `${apiEndpoint}/openid/v1/jwks`.
- _Vì sao đặt trên `ClusterAccess` mà KHÔNG trên `ReadOnlyClusterAccess`:_ nửa chỉ-đọc là kiểu mà đường quét drift
  nhận, và nó không cần đọc khoá. Đặt ở nửa đầy đủ được ba thứ: `readOnlyAccess()` (`cluster.ts:155-172`) **không
  phải sửa một dòng** nên không ai phải nhớ chuyển tiếp, đường quét drift **không gọi được**, và Service 3 (tự dựng
  `ClusterAccess` từ token) không nhận thêm năng lực nào qua nửa chỉ-đọc.
- _Vì sao là phương thức MỚI chứ không nới `read`:_ `read` nhận `ObjectRef` (apiVersion/kind/namespace/name); hai
  đường dẫn trên không phải tài nguyên, không có GVK. Khuôn đã có: `proxyService` cũng là một phương thức riêng vì
  cùng lý do. §4.6 nói `proxyService` là "cách duy nhất gọi **service** trong cluster" — `/openid/v1/jwks` là đường
  của API server, không phải một Service, nên không rơi vào câu đó.
- _E1 không tăng, nhưng phải nói đúng lý do:_ §13.2 định nghĩa E1 là **số lần nới lỏng bộ hợp đồng** (0, chốt bằng
  `E1-relaxations.json`); chiều "số lần phá vỡ interface" ở §14. Số E1 thật không tăng vì `packages/experiments/scripts/e1.ts:47-48,112-113`
  chỉ đọc `adapter-core/src/domain.ts` và `cloud.ts`, và `adapter-interface-freeze.test.ts` chỉ phủ ba interface
  adapter ⇒ `cluster.ts` nằm **ngoài phạm vi đo**. Đó là một lỗ của phép đo, **không phải giấy phép** — nên ghi thành
  chữ ở §4.6 rằng bề mặt này cũng đáng đóng băng, và để nó làm ứng viên cho một plan sau.
- _Ở đâu (QA đếm đủ, plan trước thiếu 5 chỗ):_ `adapter-core/src/cluster.ts` (interface `ClusterAccess`),
  `cluster-access/src/direct.ts` (hiện thực), `adapter-core/src/testing/fake-cluster.ts`,
  `cluster-access/src/testing.ts`, `services/core-backend/tests/provision-job.integration.test.ts:102`
  (object literal `fakeAccess`), `services/core-backend/tests/day2-upgrade.test.ts:140` và `:435` (hai object `k8s`),
  **và `docs/UDP_design.md:2858`** — §4.6 trích nguyên văn khối `interface ClusterAccess extends …`, mà
  `design-lint/tests/drift-readonly.test.ts:42-48` đọc đúng khối đó. Ba chỗ ép `as unknown as ClusterAccess`
  (`cost.integration.test.ts:44`, `metrics-source.integration.test.ts:234`, `cluster-access-cache.test.ts:124`)
  **không** phải sửa; `pd-controller/src/cluster-access/provider.ts` uỷ quyền `createDirectClusterAccess` nên tự theo.
- _Consumer trong cùng đợt (R6):_ mục 1.2.
- _Chốt mới:_ một ô khẳng định `readOnlyAccess()` phơi **đúng ba** thành viên (`mode`, `clusterId`, `getClient`) —
  nếu ai đó sau này dời `issuerKeys` xuống nửa chỉ-đọc mà quên chuyển tiếp thì đỏ ngay. (`drift-readonly.test.ts:82`
  đang khẳng định thân `readOnlyAccess` không chứa chuỗi `write`; mục này không chạm nó.)

### Mục 1.2 — đường xác minh cho ba CI trong cụm

- _Làm gì, một câu:_ lời báo mang **bound SA token** xin bằng `TokenRequest` ngay trong bước báo với `aud` = đúng địa
  chỉ webhook tuyệt đối; Service 1 kiểm bằng khoá công khai đọc từ **chính cụm của project đó**.
- _Hai nửa buộc token vào project, cần cả hai:_ (a) `aud` chặn dùng chéo project — nhưng `aud` do pod tự khai, nên
  một pod trong cụm của project X **xin được** token mang `aud` của project Y; (b) khoá kiểm lấy từ cụm của ĐÚNG
  project đang nhận webhook (`job-kit.ts:288-305` lấy cụm từ lượt PROVISION xong gần nhất của project — mỗi project
  một cụm, tên cụm tất định theo `projectId`), nên token của cụm X không qua được phép kiểm ở project Y. **Chủ thể
  không làm được việc này:** mọi cụm đều có cùng `system:serviceaccount:udp-build:udp-builder`.
- _Chủ thể vẫn phải kiểm, vì một lý do khác:_ nó phải bằng đúng chuỗi trên. Thiếu phép kiểm đó thì **mọi pod trong
  cụm** — kể cả chính ứng dụng đang được deploy — xin được token với `aud` của webhook và tự deploy image bất kỳ.
  Và `jose` **không** kiểm `sub` (đã đo), nên phép kiểm này phải do mã của UDP làm.
- _Bảo đảm đạt được, phát biểu đúng bậc:_ lớp này chứng minh **"lời báo đến từ một pod build trong namespace
  `udp-build` của đúng cụm của project này"** — **không** chứng minh commit, **không** chứng minh nhánh. Hai lý do,
  cả hai đo được: token SA không có claim repo hay ref; và quyền **tạo pod** trong `udp-build` đến từ RBAC của chart
  CI (`build-namespace.ts:15-16`), còn nội dung pipeline là **tệp trong repo của khách**. Hệ quả phải công bố: với ba
  CI trong cụm, kẻ kiểm soát repo vượt được **cả** cổng chữ ký 61d-1, vì khoá KMS cũng chỉ ràng theo
  `assertion.sub=='…udp-builder'` (`identity-script.ts:437`). Đây là một BẬC yếu hơn ba CI SaaS và không được viết
  chung một câu với chúng.
- _Thuật toán đọc từ cụm, không ghim cứng:_ `verifyTrustedDeploy` đang ghim `algorithms: ["RS256"]`
  (`trusted-deploy.ts:463`) ⇒ tham số hoá. Nhánh cụm lấy `id_token_signing_alg_values_supported` của chính cụm, giao
  với allowlist `["RS256","ES256","ES384","ES512"]`; giao rỗng ⇒ **503**, không rơi về HMAC (và `jose` với danh sách
  rỗng cũng fail-closed — lớp thứ hai, đã đo).
- _Cache: HAI cache, và cache ÂM._ Plan trước lẫn hai thứ. `createClusterAccessCache`
  (`cluster/cluster-access-cache.ts:27-61`) cache **ClusterAccess theo `projectId`**, hết hạn theo token quản trị,
  **không** stale, **không** cooldown — dùng lại nguyên vẹn cho việc lấy `ClusterAccess`. `KEY_CACHE` của
  `trusted-deploy.ts` khoá theo `expected.issuer`; nhánh cụm khoá theo `clusterId`. Và phải thêm **cache âm**:
  `trusted-deploy.ts:354-376` chỉ `cache.set` trên đường thành công, nên khi chưa có hàng cũ thì mọi request hỏng
  đều fetch lại ngay — với nhánh cụm, mỗi lượt là một lần lấy credential cloud + `getClusterStatus` +
  `getKubeAuthToken` + hai lời gọi API server, tức một kẻ có secret HMAC biến webhook thành máy bơm vào cloud của
  khách. Ghi `attemptedAt` cả khi hỏng và tôn trọng `cooldownMs`. Việc này **lợi cho cả ba CI SaaS**.
- _`staleMs` của nhánh cụm = 0._ Lý lẽ "giữ bản cũ khi nhà cung cấp hỏng" là lý lẽ của SaaS. Cụm không với tới được
  thì job deploy cũng không áp được gì ⇒ giữ khoá cũ 24 giờ không mua tính khả dụng nào, chỉ mở cửa sổ 24 giờ cho
  khoá đã bị cụm xoay.
- _Công tắc, và chỗ tính được nó:_ giá trị enum `"IN_CLUSTER_CI"` của `TrustedDeployUnavailable` **chết**; hằng
  `IN_CLUSTER_CI = ["jenkins","tekton","drone"]` (`trusted-deploy.ts:104`) **giữ nguyên cả cú pháp** (design-lint
  ghim nguyên văn dòng đó). Giá trị mới là **`CLUSTER_NOT_READY`** — không dùng `NO_CLUSTER` vì
  `IdentityScriptProblem` (`identity-script.ts:72`) đã có chuỗi đó với nghĩa khác và hai union cùng hiện trên một
  panel Portal. **`trustedDeployStateOf` (`cicd.service.ts:63-86`) là hàm thuần trên một hàng `domain_configs` nên
  không ai tính được trạng thái cụm** (lỗi R6 của plan trước): thêm một đầu vào `clusterReady: boolean` và tính nó ở
  hai chỗ gọi (`cicd.service.ts:97` của `status()`, `:145` của `setOidcRequired`) bằng một truy vấn sổ tài nguyên;
  `expectationOf` **giữ nguyên tính thuần**.
- _Ba renderer, năm chỗ gọi `notifyScript`:_ jenkins `:145` (dùng cho cả success và failure), tekton `:384` (rebase)
  và `:479` (build), drone `:166` (build) và `:281` (rebase). Dòng token đi qua tham số `tokenLines` — mọi chỗ đều
  áp thụt lề cho cả `tokenLines` nên an toàn.
- _Biến thể `tokenRequestLines` cho bước báo (ba sửa, mỗi sửa một lý do đo được):_ (i) **không ghi tệp** — bản hiện
  tại ghi token ra tệp rồi `chmod 0644` trong `/udp-auth`, volume chia cho mọi container của pod build, tức đặt một
  token deploy được ở nơi mã của khách chạm tới; bước báo đọc **biến** `$UDP_OIDC_TOKEN` nên để nguyên trong biến là
  đủ; (ii) `expirationSeconds: 600` thay vì 3600 — trần chính sách là `CICD_WEBHOOK.tokenMaxAgeSeconds = 600`, cấp
  token sống gấp 6 lần trần là vô ích và là rủi ro thuần; (iii) **không được giết lời báo** — dòng đầu của bản hiện
  tại là `set -eu`, nên ở nhánh `failure` của Jenkins/Drone, xin token hỏng sẽ giết luôn lời báo thất bại: biến thể
  phải `|| true` và để trống biến, và `notifyScript:97` vốn chỉ gửi header khi biến khác rỗng ⇒ thiếu token thì
  hành vi đúng là 401 khi chế độ bắt buộc đang bật (fail-closed), không phải mất hẳn lời báo.
- _`curl` sinh ra phải có `--retry`:_ `pipeline-template.ts:92` sinh `curl -sS --fail` **không** `--retry`, nên câu
  "503 để `curl --retry` tự lành" trong chú thích 61d-2a là **sai**. Với nhánh cụm, 503 thành lối ra thường gặp
  (credential cloud chậm, cụm chập chờn) ⇒ thêm `--retry 5 --retry-delay 5`. Lượt gửi lại mang **cùng thân** nên rơi
  đúng nhánh `duplicate` của I41 — tính chất đó đã có ô test từ 61d-2a.
- _Tekton không bảo đảm được chủ thể, và phải nói ra:_ `Pipeline`/`taskSpec` của Tekton **không khai ServiceAccount**
  (`tekton/index.ts:408-412`, `:456-481`); SA chỉ nằm trong **chú thích hướng dẫn** `tkn pipeline start …
--serviceaccount udp-builder` (`:399-406`) vì Tekton Triggers chưa có (§16). Ai chạy thiếu cờ đó thì pod dùng SA
  `default` ⇒ `sub` = `system:serviceaccount:udp-build:default` ⇒ `TOKEN_CLAIM_MISMATCH` (fail-closed, nhưng là một
  lần đỏ khó truy). Nên: hàng audit của lần từ chối ghi **chủ thể nhận được** (claim, không phải token — cùng lý lẽ
  với việc 61d-2a ghi `aud` nhận được), và §16 + Portal nói rõ Tekton phải chạy bằng đúng SA đó.
- _Ảnh hưởng lan sang (QA đếm đủ):_ `trusted-deploy.ts` (`TrustedDeployUnavailable:50`, `TrustedDeployExpectation:111`
  — thêm discriminant `kind` vào kiểu **chưa có** discriminant, `KeySource:107`, `expectationOf:188`, `fetchKeys:311`,
  `keysFor:334`, `verifyTrustedDeploy:398` ở bốn chỗ đọc claim), `cicd-webhook.service.ts:507,524`,
  `cicd.service.ts:63,97,145`, `app-deps.ts` (cổng mới), `index.ts` (nối bản thật),
  `tests/helpers/inert-deps.ts` (sentinel), `wire.ts:1809`, `CicdPanel.tsx:34`, `domain.messages.tsx:132` (vi) +
  `:283` (en), `tests/cicd-webhook.integration.test.ts:1202`, `tests/trusted-deploy.test.ts:172`. **Fixture vàng và
  seed KHÔNG phải sửa** — cả ba chỗ đang là `"unavailableReason": null` (plan trước nói sai).

### Bất biến mới I42 (R1), và vì sao I41 không phủ

I41 ô (d) khai "Lấy JWKS đi qua `createEgressFetch`" — đường CI-trong-cụm đi `ClusterAccess`, không đi
`createEgressFetch`, nên **không được** tuyên bố I41 đã phủ. Thêm:

> **I42** — **Khoá kiểm token của một CI chạy trong cụm luôn lấy từ CHÍNH cụm của project đang nhận webhook, không
> bao giờ từ một địa chỉ ngoài.** Cùng họ I41: vỡ thì hệ thống sai ÂM THẦM — một pod build trong cụm của project X
> deploy được vào project Y mà lượt deploy vẫn xanh. Bốn nửa: (a) token ký bằng khoá của một cụm KHÁC ⇒ từ chối, và
> phép khẳng định cho thấy UDP chỉ hỏi khoá của cụm của đúng project đó; (b) `sub` là một ServiceAccount khác trong
> CÙNG cụm ⇒ từ chối `TOKEN_CLAIM_MISMATCH`; (c) khoá lấy tại `/openid/v1/jwks` TRÊN kết nối API server, không bao
> giờ theo `jwks_uri` của discovery; (d) danh sách alg của cụm giao rỗng với allowlist ⇒ 503, KHÔNG rơi về HMAC.

`docs/UDP_design.md:8551` "Tổng cuối: **43 bất biến**" ⇒ **44** (`design-lint/tests/references.test.ts:120-124`
khẳng định con số đó bằng số hàng `I<số>` đếm được).

### Fitness function (R9, phần design-lint)

- `trusted-deploy-providers.test.ts`: (i) giữ hằng `IN_CLUSTER_CI` **nguyên dạng cú pháp**; (ii) **không** nhồi ba CI
  trong cụm vào `TRUSTED_DEPLOY_PROVIDERS` (test `:116-121` khẳng định chúng không chồng nhau); (iii) bảng thứ hai
  trong §8.3 có **4 cột** (tool, chủ thể, nguồn `aud`, điều KHÔNG chứng minh được) ⇒ 5 ô, khác 8 ô của bảng cũ, nên
  `tableInDesign()` (`:79` chỉ nhận hàng có đúng `FIELDS.length + 1` ô) không hút lẫn; thêm hằng
  `IN_CLUSTER_TRUSTED_DEPLOY` + parser riêng + khẳng định riêng cho bảng đó.
- `enum-mirrors.test.ts`: ghim `TrustedDeployUnavailable` ↔ zod `wire.ts:1809` ↔ nhánh `CicdPanel.tsx` — hôm nay
  không gì giữ ba bên, mà đợt này đổi đúng enum đó.
- Chốt "bootstrap không cấp quyền issuer-discovery": `cluster/bootstrap.ts` không có `nonResourceURLs` và không nhắc
  `openid`/`issuer-discovery`, **và** §12.2 có ghi chú ClusterRole mặc định. Đây là câu chịu lực của cả mục 1.1 (nó
  là lý do lối này rẻ, và là lý do §12.2 còn đúng sự thật) — biến nó thành test thì một ngày ai đó "tiện tay" cấp
  quyền trong bootstrap sẽ đỏ.
- §12.2 thêm bằng **câu văn xuôi** dưới bảng, **không thêm hàng**: `cluster-identity.test.ts` khẳng định bảng có đúng
  ba hàng SA. Câu đó phải nói: quyền này đến từ ClusterRoleBinding **mặc định** của Kubernetes, UDP không cấp và
  **không thu hồi được**.

### Kiểm chứng của 61d-2b-1 (R9) — tất định, không gọi mạng, không cần cụm thật

1. `issuerKeys` với transport giả: **đúng hai** URL, đúng thứ tự, Bearer của `udp-system/udp-tooling`, so bằng
   `toEqual` (một lời gọi thừa là đỏ).
2. Cụm khai `["ES256"]` ⇒ token ES256 nhận; cụm khai `["RS256"]` mà token ES256 ⇒ từ chối; cụm khai `["HS256"]` ⇒
   giao rỗng ⇒ **503**, không phải 401.
3. `sub` là `system:serviceaccount:default:app` ⇒ từ chối `TOKEN_CLAIM_MISMATCH` (ô chặn leo thang nội cụm).
4. Token ký bằng khoá **cụm khác** (hai cặp khoá sinh trong tiến trình, cùng `kid`) ⇒ từ chối ở chữ ký.
5. `aud` của project khác ⇒ từ chối; và cùng token gửi tới webhook của project khác ⇒ từ chối.
6. Cổng lấy khoá rỗng (tiến trình không có đường ra cụm) ⇒ **503** `TOKEN_KEYS_UNAVAILABLE`, không sự kiện deploy nào.
7. **Cache âm:** cụm hỏng, hai request liên tiếp ⇒ **đúng MỘT** lượt gọi (so bằng `toEqual` trên danh sách lời gọi).
8. **I24:** nội dung cache không chứa chuỗi JWT nào (cache giữ khoá CÔNG KHAI, không giữ token).
9. HMAC sai + Bearer hợp lệ của CI trong cụm ⇒ 401 đồng nhất **và** `expect(calls).toEqual([])` — không một lời gọi
   cụm nào trước khi HMAC đúng.
10. Dùng một lần với `jti` của token SA, qua HTTP thật: thân y nguyên ⇒ 200 `duplicate` một hàng token; thân đổi ⇒ 401.
11. Bước báo: `bash -n` xanh; token nằm trong **biến**, không có `chmod` nào trên nó; `expirationSeconds: 600`; nhánh
    `failure` vẫn gửi được lời báo khi xin token hỏng; `curl` có `--retry`.
12. `readOnlyAccess()` phơi đúng ba thành viên.
13. Cộng: `pnpm typecheck`, `format:check`, `prisma migrate diff` không khác biệt (**không migration**), bộ hợp đồng
    sáu CI, design-lint, `@udp/db`, Portal, và bộ test core-backend chia hai chặng.

### Đường lùi (R10)

Không migration, không đổi dữ liệu ⇒ `git revert` một commit. `oidcRequired` của ba CI trong cụm mặc định `false` và
chỉ tự bật ở token hợp lệ đầu tiên ⇒ pipeline chưa sinh lại vẫn chạy như cũ (HMAC).

Cửa sổ lệch phiên bản của dây: Portal là **image riêng** (`deploy/docker/portal.Dockerfile`) nên một tab Portal cũ
hay một lượt roll chưa xong sẽ lỗi parse ở giá trị enum mới. Cửa sổ đó **đã có từ trước và không do đợt này tạo ra**:
chính 61d-2a thêm hai khoá (`webhookUrl`, `trustedDeploy`) vào cùng object `.strict()` này, mà `.strict()` thì Portal
cũ từ chối khoá lạ. Giữ enum strict (nới `.catch(null)` sẽ làm bộ hợp đồng golden nhận cả chuỗi rác từ backend — mua
tương thích bằng chính tính chất golden sinh ra để giữ); sửa bằng một lượt tải lại. "Dung sai lệch phiên bản của hợp
đồng dây" ghi vào danh sách ứng viên plan sau.

### Kiểm thoái cấp (R11)

(a) Ba CI SaaS có bị đổi hành vi gì không (bảng nhà cung cấp, thứ tự tầng, tập mã từ chối)? (b) `aud` của ba CI trong
cụm có bị nhận lỏng hơn ba CI SaaS không? (c) Một cụm không với tới được có mở đường tắt nào về HMAC, và có chặn
deploy của project **chưa** bật cờ không? (d) `issuerKeys` có mở đường nào cho Service 3 hay cho đường quét drift
không? (e) Lời gọi hỏi khoá có bao giờ chạy TRƯỚC khi HMAC đúng không? (f) Bước báo **thất bại** có còn tới được
không khi xin token hỏng? (g) `--retry` mới có làm một lượt từ chối 401 bị gửi lại nhiều lần không (401 là terminal,
`curl --retry` chỉ thử lại 5xx)?

## Chỗ CHỆCH so với lập luận cũ, phải ghi (R5)

1. `plan61-plan.md:158-161` tính "phải nới một interface hạng nhất (ADR-06, §4.6)" là cái giá của lối TokenReview và
   nói "việc mà `cluster-identity.test.ts` canh" — **câu đó sai**: tệp đó chỉ canh `IDENTITY_SERVICE_ACCOUNTS` đối
   chiếu §12.2. Hôm nay **không** test nào ghim bề mặt `ClusterAccess` vào §4.6 (chỉ `drift-readonly.test.ts` đọc
   khối trích trong §4.6 để kiểm chuyện khác). Cái giá thật của lối TokenReview vẫn còn nguyên và lớn hơn: verb mới
   trên cụm khách + bootstrap lại + `write()` phải đổi kiểu trả về.
2. §16:8398 nêu lý do "Service 1 chưa lưu URL issuer, mà mọi cụm lại cùng một chủ thể". 61d-2b-1 **vô hiệu hoá** lý
   do đó, nhưng không bằng cách lưu issuer: nó buộc theo **khoá của cụm** chứ không theo chuỗi issuer. Đó là một
   quyết định, không phải một dòng xoá im lặng.
3. §16:8400 khai "Lõi xác minh có 22 ô tất định và đường webhook có 7 ô" — hai con số đó lệch sau mỗi đợt thêm ô và
   **không test nào canh**, nên phải tự cập nhật ở cuối mỗi đợt.
4. `plan61-spec.md` QĐ-1 nói 61d-2b gồm cả hai việc ⇒ thêm một dòng cho việc chia ba (tiền lệ: `plan61-plan.md:288`).

### 61d-2b-1 — đã làm, và những chỗ CHỆCH plan (R5)

1. **`IN_CLUSTER_CI` dời sang `@udp/shared-types`, plan không nói.** Plan chỉ nói "giữ nguyên cả cú pháp" cái hằng
   đó trong `trusted-deploy.ts`. Làm xong mới thấy Portal cũng cần đúng tập đó (để in câu "không chứng minh nhánh"
   cho đúng ba tool), và một bản chép trong Portal là bản chép thứ ba — nó sẽ trôi đúng vào ngày thêm CI thứ bảy.
   Nên hằng về `shared-types`, backend `export { IN_CLUSTER_CI }` lại cho hai chỗ đang import từ nó, và phép kiểm
   ghi sổ kép của design-lint trỏ sang tệp mới. Bản chép trong mock của bản xem thử giữ nguyên: mock LÀ một hiện
   thực độc lập của backend, đó là lý do nó tồn tại.
2. **Cổng đọc khoá nhận `cacheKey` do bên gọi truyền, không tự suy.** Plan viết "cache theo `clusterId`". Không làm
   được như thế: `clusterId` chỉ biết được SAU khi đã dựng `ClusterAccess`, tức sau khi đã trả giá một lần lấy
   credential cloud — đúng cái mà cache sinh ra để tránh. Cổng nhận `cacheKey = projectId`, và điều đó đúng vì mỗi
   project một cụm (tên cụm tất định theo `projectId`, `clusterOf` đọc hàng `cluster` READY của chính project).
3. **Dùng CHUNG bộ nhớ đệm `ClusterAccess` với đường đo metrics,** thay vì dựng bộ thứ hai. Một lượt dựng
   `ClusterAccess` kéo theo một lần lấy credential cloud và một token quản trị, nên hai bộ đệm là gấp đôi việc đó
   cho cùng một project trong cùng một hạn token. `index.ts` giờ dựng một bộ và đưa cho cả hai.
4. **`notifyTokenLines` là một hàm MỚI, không phải tham số thêm của `tokenRequestLines`.** Plan viết "biến thể". Ba
   điểm khác nhau (không ghi tệp, 600 giây, không `set -eu`/`exit`) đều nằm ở THÂN hàm, nên một tham số `mode` sẽ
   biến một hàm 20 dòng thành hai nhánh song song trong một thân — khó đọc hơn hai hàm, và dễ gọi sai hơn.
   `tokenRequestLines` cũ không đổi một dòng: nó vẫn là đường đăng nhập registry của bước build.
5. **Bộ hợp đồng CI/CD được một phép kiểm MẠNH hơn plan đòi.** Plan chỉ nói "thêm needle". Needle
   `UDP_OIDC_TOKEN` có từ 61d-2a đã được thoả bởi chính dòng header có điều kiện, nên một mình nó không phân biệt
   "có xin token" với "chỉ gửi nếu có sẵn" — ba CI trong cụm sẽ xanh mà không bao giờ xin token. Giờ với đúng ba
   tool đó, bộ hợp đồng đòi thấy lời gọi `TokenRequest`, đòi `audiences` bằng đúng `webhookUrl`, và khẳng định
   **không** có dấu chuyển hướng nào sau `UDP_OIDC_TOKEN` (I24: token không xuống tệp). Đã kiểm rằng phép kiểm
   mới THẬT SỰ chạy: cố ý làm sai một needle ⇒ đúng ba tệp đỏ (jenkins, tekton, drone), sửa lại ⇒ 324/324.
6. **Thêm một chốt design-lint plan không nghĩ tới: `cluster-bootstrap.test.ts`.** Câu chịu lực của cả mục này là
   "bootstrap không đổi một dòng". Nó giờ là một test: `bootstrap.ts` không nhắc `nonResourceURLs`, `openid`,
   `issuer-discovery` hay `tokenreviews`; §12.2 có câu nói quyền đó là quyền mặc định của Kubernetes và UDP không
   thu hồi được; và `issuerKeys` dùng đúng identity `tooling`, không đi theo `jwks_uri`.
7. **Một em-dash trong chữ giao diện làm `tests/design-lint.test.ts` của Portal đỏ.** Luật của repo (không em-dash
   trong chữ người dùng đọc) bắt đúng hai câu mới. Sửa bằng cách viết lại câu, không bằng cách nới luật.

**Cổng đã qua:** `pnpm typecheck` (core-backend, Portal, pd-controller) 0 lỗi; `prettier --check` toàn repo sạch;
`trusted-deploy` **34/34** (22 cũ + 12 ô mới của nhánh cụm, gồm cache âm và cooldown); `cicd-webhook` tích hợp
**42/42** (thêm 5 ô HTTP thật cho nhánh cụm); bộ hợp đồng sáu CI **324/324**; `cluster-access` **31/31** (thêm 4 ô
cho `issuerKeys`); design-lint **172/172** (28 tệp, thêm `cluster-bootstrap` và hai chốt enum); `@udp/adapter-core`
422; `@udp/shared-types` 130; `@udp/config` 46; Portal 365; bản xem thử 17. **Không migration** (không tệp nào
trong `packages/db` thay đổi).

**Kiểm thoái cấp (R11) — trả bằng ô test, không bằng lập luận:**
(a) ba CI SaaS không đổi hành vi: 22 ô cũ của `trusted-deploy` và 7 ô Trusted Deploy của 61d-2a vẫn xanh nguyên,
và `algorithms` của chúng vẫn là `[spec.alg]` lấy từ bảng khai báo;
(b) `aud` của ba CI trong cụm không lỏng hơn: một ô gửi token mang `aud` của project khác ⇒ 401;
(c) cụm không với tới được KHÔNG mở đường tắt: hai ô (`clusterKeys: null` và cụm ném) đều ra **503**, và một ô
khẳng định không sự kiện deploy nào, không hàng token nào;
(d) `issuerKeys` KHÔNG mở gì cho đường quét drift hay Service 3: nó nằm ở `ClusterAccess` chứ không ở nửa chỉ-đọc,
và một ô design-lint khẳng định `readOnlyAccess()` phơi đúng ba thành viên;
(e) lời gọi hỏi khoá không bao giờ chạy trước khi HMAC đúng: ô HTTP "HMAC sai + Bearer hợp lệ" khẳng định
`reads === 0`;
(f) bước báo **thất bại** vẫn tới được khi xin token hỏng: `notifyTokenLines` kết thúc bằng `|| true` và không có
`exit`, và bộ hợp đồng chạy `bash -n` cho cả sáu CI ở mọi ô;
(g) `--retry` không làm một lượt 401 bị gửi lại: `curl --retry` chỉ thử lại lỗi tạm (5xx, lỗi mạng), và lượt gửi
lại mang CÙNG thân nên rơi đúng nhánh `duplicate` của I41 — ô "gửi lại cùng token thân y nguyên" đã chốt điều đó.

## 61d-2b-2 — bộ ký trong cụm: phân tích, và quyết định HOÃN lại sau 61d-3

Vòng lập kế hoạch chi tiết (R1) của mục này lật một dữ kiện làm đổi cái giá của nó, nên phần này ghi lại phân tích
đầy đủ thay vì một plan thi công. Quyết định: **làm 61d-3 (Kyverno, AC-12) trước**, và 61d-2b-2 giữ nguyên dòng
giới hạn đã công bố ở §16 cho tới khi làm. Lý do ở cuối.

### Dữ kiện đã xác minh (R7)

| #   | Câu hỏi                                                       | Kết quả, tại mã                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | AKS của UDP có bật OIDC issuer và workload identity chưa?     | **Rồi, cả hai.** `cloud-adapters/src/azure/resources/cluster.ts:53-54`: `oidcIssuerProfile: { enabled: true }`, `securityProfile: { workloadIdentity: { enabled: true } }`. Nên lối ký trong cụm **không** cần đổi đường provisioning.        |
| 2   | Có sẵn mảnh nào để ký trong cụm?                              | Gần đủ: image `azureCli` ghim digest (`build-toolchain.ts`), cosign ghim version + sha256, `kmsCredentialLines` + `signLines` của `sign-script.ts` (dùng lại nguyên), và lệnh đăng nhập ACR bằng federated token (`build-script.ts:151-156`). |
| 3   | `udp-tooling` tạo được `Job` trong cụm khách chưa?            | **Chưa.** `cluster/bootstrap.ts`: ba nhóm rule của `tooling` chỉ có `helmreleases`, `helmrepositories`, `configmaps`, `secrets` (trong `udp-system`), một Secret tên cố định ở namespace environment, và CRD. **Không** `batch/jobs`.         |
| 4   | Namespace `udp-build` có sẵn cho project dùng CircleCI không? | **Không.** Nó do `buildNamespaceCompanion` tạo, mà companion đó chỉ đi kèm release của **ba CI trong cụm**. Project dùng CircleCI không có namespace đó.                                                                                      |
| 5   | Bootstrap chạy lại được không?                                | Được, nhưng không tự động: `clusters.bootstrap` gọi từ `provision.job.ts` (lượt provision) và `environment-apply.job.ts` khi **THÊM** environment. Nên một cụm đang chạy chỉ nhận quyền mới ở lần thêm environment kế tiếp.                   |

### Ba thiết kế, và vì sao chọn lối ký trong cụm nếu làm

- **(A) Job ký trong cụm của project** — dùng lại toàn bộ đoạn shell ký đã viết và đã được bộ hợp đồng kiểm. Giá:
  một Role mới (`batch/jobs: create, get`) cho `udp-tooling`, một namespace mới (không dùng được `udp-build`, dữ kiện
  4; và không nên dùng `udp-system` vì pod ký giữ token ký được bằng khoá KMS của project), **sửa `bootstrap.ts` ⇒
  mọi cụm đang chạy phải bootstrap lại** (dữ kiện 5), cộng §12.2, I25 và bộ test của bootstrap.
- **(B) Service 1 tự ký, gọi REST của Key Vault** — không chạm cụm. Giá: viết một bộ ký OCI/cosign bằng TypeScript
  (DSSE + simple signing + đẩy referrer), tức một bản hiện thực thứ hai của định dạng mà `@sigstore/verify` và
  Kyverno phải đọc được. Đó là nợ kỹ thuật dài hạn và là chỗ sai âm thầm (chữ ký đúng hình nhưng Kyverno từ chối).
- **(C) UDP cấp token Azure ngắn hạn cho lượt chạy CircleCI đã xác minh** — mạnh nhất về nguồn gốc (chữ ký do CHÍNH
  lượt chạy tạo, khác (A) và (B) đều là chữ ký của UDP), và dùng lại được bộ xác minh Trusted Deploy của 61d-2a.
  Nhưng nó đổi một nguyên tắc khai sinh: QĐ-6 nói UDP chỉ lưu **mã định danh không bí mật** và không bao giờ giữ hay
  phát credential cloud cho lượt build. (C) biến UDP thành một **bộ phát credential cloud** — một hướng tin cậy mới,
  và bán kính thiệt hại của một lỗi trong bộ xác minh lúc đó là "ký được bằng khoá KMS của khách", không còn là
  "deploy được một image". Đổi nguyên tắc đó là việc của **spec**, không phải của một mục trong plan.

Chọn **(A)** nếu làm. Và một điều phải viết vào §8.3 cùng §16 ngay khi làm: chữ ký do UDP đặt **sau** cổng deploy
KHÔNG chứng minh nguồn gốc build — nó chỉ chứng minh "UDP đã cho phép byte này". Giá trị thật của nó là để Kyverno
(61d-3) có chữ ký mà kiểm lúc admission.

### Vì sao HOÃN, và vì sao hoãn không phải thoái cấp

1. **Cái giá là đúng cái giá mà 61d-2b-1 vừa tránh được.** Lối TokenReview bị loại ở QĐ-1 vì "quyền mới trên cụm
   khách + bootstrap lại mọi cụm đang chạy". (A) đòi đúng hai thứ đó. Nhận nó cho **một** tổ hợp CI × cloud
   (CircleCI + Azure) là một trao đổi tệ hơn hẳn trao đổi mà 61d-2b-1 đã từ chối cho **ba** CI.
2. **AC-12 là tiêu chí nghiệm thu, 61d-2b-2 thì không.** 61d-3 (Kyverno) đóng một AC của khoá luận; 61d-2b-2 đóng một
   dòng §16 đã công bố và đã thoái cấp **có kiểm soát** (không chữ ký, image vẫn deploy, chế độ bắt buộc không bật
   được — người dùng thấy đúng lý do ở mục Ký image).
3. **Làm 61d-3 trước còn làm giá trị của (A) ĐO ĐƯỢC.** Sau khi Kyverno kiểm chữ ký lúc admission, câu "project
   CircleCI + Azure không bật được kiểm chữ ký của Kyverno" trở thành một hệ quả cụ thể, chứ không phải một suy đoán.
4. **Không để lại nợ:** dòng §16 vẫn đúng và vẫn trỏ `(61d-2b-2)`; phân tích ba thiết kế nằm ở đây; không mã nào bị
   bỏ nửa vời. Thứ duy nhất đổi là **thứ tự**, và R5 đòi ghi lại đúng việc đó — đây là chỗ ghi.

**Nếu quay lại làm (A), ba việc phải quyết trước dòng mã đầu:** (i) namespace riêng (`udp-sign`) hay mở `udp-build`
cho mọi project; (ii) `udp-tooling` chờ Job bằng `get` trên `batch/jobs` hay đọc một ConfigMap do Job ghi (chênh nhau
một verb); (iii) cụm chưa bootstrap lại thì bước ký trả mã gì — phải là một mã **nói rõ cần bootstrap lại**, không
phải một 403 chung.

## 61d-3 — Kyverno kiểm chữ ký lúc admission (AC-12): chia ba, và vì sao

Vòng QA ba agent trên bản nháp tìm ra **hai lỗi chí tử** làm policy không bao giờ xác minh được một image thật, cộng
bảy lỗ phạm vi và sáu khẳng định sai về mã của chính dự án. Bản nháp **không thi công được**. Dưới đây là bản đã sửa,
chia ba đợt để mỗi đợt kiểm chứng được độc lập.

### Hai lỗi chí tử của bản nháp (xác nhận tại nguồn, 03/10/2026)

**CT-1. Thiếu `cosign.ctlog.insecureIgnoreTlog` ⇒ MỌI image UDP ký đều verify THẤT BẠI.** CRD
`policies.kyverno.io_imagevalidatingpolicies.yaml` dòng 166-169: `insecureIgnoreTlog` là `boolean` **không có
`default`**, nên nó là `false` và Kyverno đi xác minh sổ minh bạch (Rekor) cùng SCT. Mà UDP ký với signing config
**rỗng có chủ đích** — `packages/config/src/build-toolchain.ts:107-108`:
`{"mediaType":…,"rekorTlogConfig":{},"tsaConfig":{}}`, kèm chú thích "KHÔNG khai dịch vụ nào: không Fulcio, không
Rekor, không TSA — ký bằng khoá KMS, image riêng tư không lộ tên hay digest ra sổ minh bạch công khai" (QĐ-14). Cổng
deploy của 61d-1 cũng cố ý bỏ tlog. Nên bundle của UDP **không có** tlog entry và **không có** RFC3161 timestamp.
Hệ quả: `verifyImageSignatures` trả 0 ⇒ `[Deny]` chặn **mọi pod của mọi project**; `[Audit]` thì 100% vi phạm giả.
Và Kyverno sẽ gọi TUF ra Internet, nên cụm không có đường ra còn lỗi cứng. ⇒ Phải khai
`cosign.ctlog: { insecureIgnoreTlog: true, insecureIgnoreSCT: true }`.

**CT-2. `credentials.secrets` phải nằm ở namespace của KYVERNO, không phải namespace environment.** CRD dòng
479-482 nguyên văn: _"Secrets specifies a list of secrets that are provided for credentials. **Secrets must live in
the Kyverno namespace.**"_ Mà `cluster/bootstrap.ts` tạo `udp-registry-pull` **chỉ trong vòng lặp environment** và
tạo **RỖNG** (`EMPTY_DOCKER_CONFIG`). Kyverno cài ở `udp-system`. Nên trỏ vào tên đó là sai cả chỗ lẫn nội dung:
registry riêng tư ⇒ Kyverno không đọc được image ⇒ RuleError ⇒ với `[Deny]` + `failurePolicy: Fail` là chặn.

**Bài học chung của hai lỗi:** một ô test "Deny chặn image CHƯA ký" **không** bắt được cả hai — nó xanh vì chặn
đúng, chỉ là chặn vì lý do khác. Thứ bắt được chúng là ô "image ĐÃ KÝ phải ĐƯỢC NHẬN **trên cụm thật có Kyverno**".
Vì vậy đợt nào sinh `ImageValidatingPolicy` thì đợt đó **phải mang theo E2E kind + Kyverno**, không được hoãn.

### Sáu khẳng định SAI về mã trong bản nháp (QA B, đã kiểm lại)

| Bản nháp nói                                                 | Mã thật                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "`toolchain:check` `--fix` mở pull request như các mục khác" | **Không có cờ `--fix` nào**, và `.github/workflows/toolchain.yml` khai `permissions: contents: read` kèm chú thích "Chỉ ĐỌC registry và GitHub, không sửa gì". Không mục nào "như thế".                                                  |
| "`toolchain:check` đã có khuôn cho chart Helm"               | Nó theo **image ghim digest** và **bản phát hành GitHub**. Không có đường đọc `index.yaml` của repo Helm.                                                                                                                                |
| "dùng lại `buildSigningOf`/`signingOf`"                      | `signingOf` **không tồn tại** trong mã sản phẩm. `buildSigningOf` trả `{ key: key.kms, identity, compat }` — chỉ khoá ĐẦU danh sách và **không có PEM công khai**. Khoá công khai ở `settings.signing.keys[].publicKey` (tối đa 5 khoá). |
| "7 tệp dựng bối cảnh"                                        | **6 tệp / 7 điểm** (`day2-upgrade.test.ts` có hai điểm). Và `ReadOnlyAdapterContext = Omit<…,"k8s">` nên trường mới chảy sang mọi hàm suy diễn.                                                                                          |
| "ném rồi hạ về bản cũ"                                       | `domain-apply.job.ts:615-621` cắm cứng `rollback: () => ({ status: "FAILED" })` ⇒ luôn `ROLLBACK_FAILED`, **không hạ gì**.                                                                                                               |
| "`deploy/e2e` có khuôn cài adapter / áp pod"                 | `deploy/e2e` chỉ có `smoke.e2e.test.ts` (Portal, SDK, PromQL). Grep `domain                                                                                                                                                              | adapter | pod | kubectl | helm`: **0**. Khuôn gần nhất là job `signing-e2e` — không Kyverno, không kind. |

Và bốn tệp phải sửa mà bản nháp không nhắc: `domain/domain-apply.service.ts:309` (`requestReapply` **từ chối** khi
`adapterVersion !== adapter.version` ⇒ bước "áp lại domain POLICY" chết đúng ở đó sau khi bump version);
`cicd/cicd-webhook.service.ts:395-403` (đường ghi `build_settings` **thứ ba**, SQL thô tự bật `enforce`);
`adapter-base/saas.ts:263-272` **và** `descriptor.ts:146-155` (CÙNG một guard nâng cấp, hai lớp nền khác — sửa riêng
`helm.ts` làm lời khai "mở đường nâng cấp" chỉ đúng 1/3); `packages/experiments/scripts/e1.ts:54` (đo bề mặt
`DomainAdapterContext`, nên thêm trường **làm số E1 đổi** — phải ghi một dòng mở rộng bối cảnh, đúng tiền lệ QĐ-2).

### 61d-3a — nâng Kyverno lên 3.9.1 và MỞ đường nâng cấp của §8.6

Đợt này **không** sinh policy mới, nên nó kiểm chứng được hết bằng test đơn vị + hợp đồng, không cần cụm.

1. **Mở đường nâng cấp ở CẢ BA lớp nền.**
   - _Làm gì:_ `createHelmBasedAdapter`, `createSaasAdapter`, `createDescriptorAdapter` nhận
     `upgradesFrom?: readonly UpgradeOrigin[]` với `UpgradeOrigin = { version: string; chart?: ChartRef; companions?: … }`
     — tức **toạ độ cũ**, không chỉ số version. `upgrade` nhận `fromVersion` khi nó thuộc
     `upgradesFrom ∪ {spec.version}`; ngoài ra **vẫn ném** như hôm nay (giữ d11 của bộ hợp đồng:
     `upgrade(…, "0.0.0-khong-ton-tai")` phải thất bại).
   - _Vì sao ba lớp nền chứ không một:_ `helm.ts:583`, `saas.ts:265`, `descriptor.ts:146` là **cùng một guard chép
     ba lần**. Sửa một chỗ làm câu "lớp nền mở đường nâng cấp" đúng 1/3, và adapter thứ hai cần nâng sẽ lại tắc.
   - _Áp bản mới hỏng ⇒ TỰ áp lại toạ độ cũ,_ rồi trả `FAILED` kèm thông điệp nói rõ đã hạ về. Đây là nửa mà §8.6
     đòi ("không để trạng thái lửng lơ") và là nửa mà cổng `rollback` cắm cứng `FAILED` hôm nay **không** làm.
   - _Cổng `rollback` của `UpgradePorts` thành TUỲ CHỌN:_ vắng nó nghĩa là "đích tự bảo đảm trạng thái", và
     `upgradeDomain` trả `UPGRADE_FAILED` thay vì `ROLLBACK_FAILED`. Bỏ cái stub nói dối ở `domain-apply.job.ts`.
     `AdapterOperationStatus` chỉ có bốn giá trị nên không thêm trạng thái mới — đây là cách không chạm kiểu dùng
     khắp nơi.
   - _Ở đâu:_ `adapter-base/{helm,saas,descriptor}.ts`, `day2/domain-upgrade.ts`, `jobs/domain-apply.job.ts`,
     `docs/UDP_design.md` §8.6.
2. **Kyverno 2.0.0 + chart 3.9.1, và cái bẫy `policyType`.**
   - _Làm gì:_ chart `kyverno` và `kyverno-policies` lên **3.9.1** (app v1.19.1), `version: "2.0.0"`,
     `upgradesFrom: [{ version: "1.0.0", chart 3.2.7, companion 3.2.6 }]`. **Giữ** `provides:
policy.admission@1.0.0` — bump version capability sẽ làm mọi consumer `^1` vỡ 422 ngay trong
     `validateAndOrder` trước khi chạm cụm.
   - _Bẫy phải đóng:_ `kyverno-policies` 3.9.1 mặc định `policyType: ValidatingPolicy`, và khoá `policyExclude` mà
     adapter đang truyền **chỉ áp dụng cho `ClusterPolicy`**. Nâng chart mà không đổi gì khác thì `udp-system`,
     `kube-system`, `udp-build` **mất quyền miễn trừ trong im lặng** — với `Enforce` thì pod nền tảng và pod build
     BuildKit (cần seccomp `Unconfined`) bị chặn. Sửa: ghim `policyType: "ValidatingPolicy"` **tường minh** (không
     dựa vào mặc định của chart) và đổi sang `vpolExclude: { excludeNamespaces: exempt(ctx) }`.
   - _`Enforce` ⇒ `replicas >= 2`:_ ràng trong `configSchema` bằng `superRefine` — từ chối lúc LƯU, không phải lúc áp.
   - _`requestReapply` phải cho áp lại sau khi bump:_ `domain-apply.service.ts:309` từ chối khi version lệch. Sau khi
     Kyverno lên 2.0.0, mọi project còn 1.0.0 **không áp lại được** — đó là một bế tắc do chính đợt này tạo ra. Sửa:
     khi version lệch mà adapter khai `upgradesFrom` chứa version đang lưu thì **đổi lời đề nghị thành NÂNG CẤP**
     (đường §8.6 nhánh B đã có), chứ không trả 409 mù.
   - _Ở đâu:_ `policy-adapter/kyverno/index.ts`, `domain/domain-apply.service.ts`, §5.5 dòng 3769 (câu "miễn trừ ở
     tầng webhook (không phải từng policy)" **thành sai** — phải viết lại), §8.6.
   - _KHÔNG ghi version chart vào §5.5:_ `grep "3.2.7" docs/UDP_design.md` ⇒ **0**; §5.5 chưa bao giờ ghi version
     chart của tool nào. Thêm một bản khai thứ hai không có chốt nào giữ là đúng hình dạng nợ mà `references.test.ts`
     sinh ra để chống.
3. **Kiểm chứng (R9):** hợp đồng Kyverno (version, hai chart, `upgradesFrom`); `upgrade` từ `1.0.0` đi qua và từ
   `0.9.0` vẫn ném (hai chiều một ô); áp bản mới hỏng ⇒ có lời gọi áp lại toạ độ cũ (transport giả đếm);
   `configSchema` từ chối `Enforce` + `replicas: 1`; values sinh ra có `vpolExclude.excludeNamespaces` đủ ba
   namespace và **không** còn `policyExclude`; `policyType` ghim tường minh; `provides` vẫn `policy.admission@1.0.0`;
   `requestReapply` của project 1.0.0 trả về lời đề nghị NÂNG CẤP. Cộng typecheck, format, bộ hợp đồng domain,
   design-lint, Portal, bộ test core-backend.
4. **Đường lùi (R10):** `git revert`. Project đã lên `adapter_version = 2.0.0` thì cột đó ở lại — kèm câu SQL hạ về
   `1.0.0` cho đúng hàng POLICY/kyverno, viết sẵn trong plan như khối "Đường lùi" của mọi migration.
5. **Kiểm thoái cấp (R11):** ba lớp nền có còn từ chối `fromVersion` lạ không (d11)? Project đang chạy 1.0.0 có bị
   chặn deploy trong lúc nâng không? Ba namespace nền tảng có còn miễn trừ không (ô `vpolExclude`)? `Audit` có còn
   là mặc định không? Một lượt nâng hỏng có để cụm ở trạng thái xác định không (và test chứng minh)?

### 61d-3b — `ImageValidatingPolicy` + E2E kind có Kyverno (đi CÙNG nhau)

Hình policy sau khi sửa theo QA: `validationActions` theo `enforce`; `spec.failurePolicy` **của chính policy** theo
chế độ (`Audit` ⇒ `Ignore`) — trường riêng của policy, không phải giá trị của chart;
`cosign.ctlog.insecureIgnoreTlog: true` + `insecureIgnoreSCT: true` (CT-1); `cosign.annotations` đòi tối thiểu
`dev.udp.project` để admission không lỏng hơn cổng 61d-1 (cổng đó còn kiểm nhánh, độ mới và replay — phải ghi vào
§8.3 rằng admission **không thay** nó); hai glob chặt `"<ref>/<slug>:*"` và `"<ref>/<slug>@*"` thay vì một glob
`*` (gobwas/glob ăn cả `/` và `:`); biểu thức CEL phủ **cả ba** danh sách `containers + initContainers +
ephemeralContainers`; `validationConfigurations: { required: true, verifyDigest: true, mutateDigest: false }` khai
tường minh (mặc định `mutateDigest: true` sẽ SỬA image thành digest ngay ở chế độ Audit ⇒ trôi vĩnh viễn với
Flux/Argo); `resourceRules` thêm `pods/ephemeralcontainers` (UPDATE) để `kubectl debug` không là đường lách;
`namespaceSelector` theo nhãn dương `udp.environment`; và **secret pull của Kyverno** phải ở namespace của Kyverno,
điền thật (CT-2) — hoặc policy chỉ dùng `credentials.providers` khi registry công khai.

Và một quyết định phải ghi: image **không khớp** glob bị loại khỏi `images.*` nên policy **cho qua** — ngược với cổng
61d-1 vốn **từ chối** image lạ. Muốn AC-12 chặn image lạ thì cần một policy thứ hai (catch-all). Đó là một quyết định
thiết kế, không phải một chi tiết.

E2E kind + Kyverno **không hoãn được**: nó là thứ duy nhất bắt được CT-1 và CT-2. Khuôn gần nhất là job
`signing-e2e` (có image đã ký / chưa ký) nhưng không chạy trên kind và không có Kyverno; `deploy/e2e` thì không có
đường cài adapter. Nên 61d-3b gồm cả việc dựng khuôn đó. Ô bắt buộc: image **đã ký** được NHẬN; chưa ký bị chặn ở
`Deny`; chưa ký ở **initContainer** cũng bị chặn; image của project khác cùng registry **không** bị chặn oan;
`Audit` không đổi `spec` của Deployment.

### 61d-3c — "tự áp bản vá" của AC-12, trong ranh giới của §8.6

AC-12 (`plan61-spec.md:24`) đòi "luồng cập nhật có E2E và **tự áp bản vá**". Mục 3 của bản nháp chỉ có
`toolchain:check` mở PR — mà PR là việc của người, và `toolchain:check` **chưa có** `--fix` lẫn khuôn chart Helm.
Ranh giới phải ghi rõ: "tự áp" = **tự áp bản vá PATCH cùng dòng minor** (3.9.1 ⇒ 3.9.2), vì nó **không** đổi
`adapter_version` nên không đi qua nhánh B của §8.6 (nâng cấp do MAINTAINER bấm, production xác nhận hai bước); nâng
minor hay major vẫn do người bấm. Đợt này: `toolchain:check` thêm đường đọc `index.yaml` của repo Helm, và một lịch
áp bản vá patch qua đúng hàng đợi DOMAIN_APPLY.

### Thứ tự, và vì sao chia ba

61d-3a đứng một mình được và trả luôn một món nợ của chính dự án (đường §8.6 chưa adapter nào đi qua). 61d-3b phải đi
cùng E2E nên nó là đợt nặng nhất và nó **phụ thuộc** 61d-3a (CRD của họ policy mới do chart 3.9.1 cài). 61d-3c là
chính sách cập nhật, nhẹ nhất, và nó cần 61d-3a đã chốt số version chart.

## Cuối

`UDP_design.md` (§5.5, §8.3, §11, §12.2, §16, D-P54), `DESIGN.md` nếu có thành phần mới, sổ nợ (`cicd-webhook-real` mở
rộng), bàn giao; Playwright năm lượt.

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

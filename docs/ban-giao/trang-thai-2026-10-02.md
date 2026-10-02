# Bàn giao — UDP, 02/10/2026

Tài liệu này đọc được mà không cần phiên làm việc nào. Nó thay `trang-thai-2026-10-01.md` ở vai "điểm bắt đầu cho
người tiếp theo"; tệp đó giữ nguyên các mục không đổi (Plan #58…#60). Nguồn sự thật của thiết kế là
`docs/UDP_design.md`; của phép đo là `docs/measurements/` (nợ trong `kiem-chung-con-no.md`); của từng plan là
`docs/plans/`.

**Trạng thái một câu:** Plan #61 (đóng gói ứng dụng thành container) đã xong 61a, 61b, 61c và 61d-1 — pipeline của sáu
CI tự build, đẩy theo digest, vá image nền theo lịch, ký image bằng khoá KMS ở cloud của project, và Service 1 chỉ
deploy image của đúng repository, có chữ ký đúng. Còn 61d-2 (Trusted Deploy), 61d-3 (Kyverno) rồi Plan #62 (phát hành
SDK). 48 mục nợ kiểm chứng. Hạ tầng của dự án tốn đúng 0 đồng và không chạy trên máy người dùng.

**Sửa thêm trong 61d-1, sau khi chạy hết bộ test (02/10/2026):** mốc giờ của chuỗi sự kiện deploy giờ do DATABASE cấp
(`clock_timestamp()`), không phải đồng hồ của tiến trình ghi — xem §3.1. Đây là khiếm khuyết của chính 61c và 61d-1,
làm hai bảo đảm của chúng (QĐ-13 "rebase không đè rollback" và AC-10 "chữ ký không cũ hơn bản đang chạy") không thành
lập khi hai service lệch đồng hồ.

## 1. Plan #61 tới giờ

| Commit               | Nội dung                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `2229154`, `14ba571` | Đề xuất (người dùng chọn hướng B, ký cách b, duyệt Plan #62), spec và kế hoạch                               |
| `1863af2`            | 61a: đăng nhập registry ở sáu CI, build trong cluster (namespace `udp-build`), deploy theo digest, ghim      |
| `16790b3`, `7b9c2d7` | 61b: Buildpacks, cài đặt build, bước test theo ngôn ngữ, mục Đóng gói; image bước của sáu domain ghim digest |
| `058131a`            | Spec 61c–61d sau khi rà lại: phương án C, khắc phục bốn điểm yếu người dùng nêu                              |
| `1e9645c`, `ae7e3dc` | Test job-queue kín; 61c: vá image nền theo lịch, UDP quyết lần deploy, `toolchain:check`                     |
| (commit này)         | 61d-1: ký image và cổng deploy                                                                               |

## 2. 61d-1 — đã làm

- **Ký ở sáu CI**, SAU bước quét, TRƯỚC bước báo; lượt rebase ký lại digest mới. cosign 3.1.3 và oras 1.3.4 tải bản phát
  hành rồi kiểm sha256 (`BUILD_TOOLCHAIN`, `toolchain:check` theo dõi). Hai chữ ký: bundle Sigstore (referrer OCI, tag dự
  phòng khi registry không có API referrers) và chữ ký tương thích simple signing ở tag `sha256-<hex>.sig` cho podman,
  skopeo, CRI-O, bootc. Không Rekor công khai. Annotation được ký: project, commit, nhánh, lượt chạy, giờ ký.
  GitHub/CircleCI: bước trong job; GitLab: job `sign` (artifact sang job báo); Jenkins: stage trong container sẵn có
  của pod; Tekton: task `sign` riêng; Drone: bước.
- **Khoá:** script danh tính tạo khoá trong KMS của cloud của project (AWS KMS, GCP Cloud KMS, Azure Key Vault) và chỉ
  cấp quyền ký đúng khoá đó; dòng kết quả mang URI KMS và khoá CÔNG KHAI. Project chưa có cloud mà đẩy registry của
  cloud: script chỉ phần đẩy (như trước). CircleCI + Azure chưa ký được (chờ bộ ký trong cụm, 61d-2) — Portal nói lý do.
- **Cổng deploy** (`services/core-backend/src/modules/cicd/signature-gate.ts`, gọi trong `receiveWebhook`): image phải
  thuộc `<registryRef>/<slug>` (mọi project, 422 + `cicd.webhook.foreign-image`); có khoá ⇒ kiểm bundle bằng khoá công
  khai đã lưu (`@sigstore/verify` 4.1.2, không gọi KMS): digest, project, commit, nhánh của environment, ký trong 24
  giờ, không cũ hơn bản đang chạy. Từ chối ⇒ `DEPLOY_FAILURE` có mã (`SIGNATURE_MISSING/INVALID/MISMATCH/STALE`) và 422. Bắt buộc tự bật ở chữ ký hợp lệ đầu tiên; bật/tắt tay là `PUT /projects/:id/build/signing-enforce`.
- **Portal:** phần Ký image trong mục Đóng gói (khoá, dấu vân tay, URI KMS, gỡ khoá, chữ ký tương thích, bắt buộc có
  xác nhận, chi phí KMS ở cloud của khách); nhãn "Đã kiểm chữ ký" hay lý do từ chối ở lịch sử deployment; thuật ngữ
  "Ký image". Bản xem thử đủ trạng thái: đã bắt buộc với hai khoá và hai lần bị từ chối, chờ chữ ký đầu, danh tính cũ
  chưa có khoá, chưa có cloud, CircleCI trên Azure.
- **CI của UDP:** job `signing-e2e` (zot có API referrers, distribution không có) ký bằng ĐÚNG đoạn shell renderer sinh,
  kiểm bằng cosign, skopeo với policy `sigstoreSigned` và cổng deploy, cả ca hỏng. **Chưa có lượt chạy** — chạy lần đầu
  khi người dùng đẩy commit này.

**Cổng đã qua trước khi commit (02/10/2026):** `pnpm typecheck` và `pnpm format:check` toàn repo sạch;
`prisma migrate diff` báo "No difference detected" giữa `schema.prisma` và database (chốt rằng biểu thức
`dbgenerated("clock_timestamp()")` round-trip đúng với `pg_get_expr`); `pnpm db:verify-chain` dựng lại được chuỗi
migration từ database trống. Test: core-backend **123 tệp unit / 4030 test** và **31/31 tệp tích hợp** (chạy từng tệp một,
0 đỏ); pd-controller **18 tệp / 127 test**; design-lint **158**; Portal **365 + 17**; shared-types 130, adapter-core 422,
config 46, deploy 65.

Hai lần đỏ gặp trong lúc chạy (`provision-job`, `rollout-service-level`) là **rớt kết nối tới Supabase**
(`Connection terminated due to connection timeout` và
`Client network socket disconnected before secure TLS connection was established`), không phải lỗi mã: cả hai xanh ở lượt
chạy lại. Máy đo lúc đó chỉ còn 0,4 GB trống trên 7,7 GB.

## 3. Phát hiện khi làm

### 3.1 Mốc giờ của sự kiện deploy do database cấp (khiếm khuyết của 61c + 61d-1, đã sửa)

**Lộ ra thế nào:** chạy hết bộ test core-backend thì `tests/cicd-webhook.integration.test.ts` đỏ 1/23 — lượt rebase trả
`skipped NOT_SETTLED` thay vì `unchanged`.

**Nguyên nhân gốc, đo được chứ không suy luận** (một transaction rồi rollback, không ghi gì vào database):

```
js_now          : 2026-10-02T03:16:39.408Z
db_now_txn      : 2026-10-02T03:16:37.854Z
stored_occurred : 2026-10-02T03:16:39.421Z
stored - db_now : 1567 ms      stored - js_now : 13 ms
```

Prisma Client sinh giá trị của `@default(now())` ở **MÁY**, không ở database — trái với tiền đề mà cả 61c lẫn 61d-1
dựa vào. Máy dev chạy nhanh hơn Supabase 1,5 giây.

**Vì sao là khiếm khuyết sản phẩm, không chỉ chuyện của test:** `deployment_events` có HAI writer ở HAI tiến trình —
Service 1 (webhook, duyệt deploy, rollout, hai job) và Service 3 (`ROLLBACK` của pd-controller,
`services/pd-controller/src/rollout-session/event.repository.ts`). **Bốn** kết luận đọc thứ tự `occurred_at`:

1. `latestDeployment` (QĐ-13) — lệch đồng hồ ⇒ **lượt rebase đè lên một lần rollback có chủ đích**;
2. `currentIssuedAt` (QĐ-16/AC-10) — lệch đồng hồ ⇒ **nhận một chữ ký cũ hơn bản đang chạy**;
3. `lastSuccessfulImage` (`jobs/deploy.job.ts`) — chọn image để **hoàn tác về** khi deploy hỏng ⇒ hoàn tác về một bản
   khác bản đang chạy. Vòng rà đầu của tôi bỏ sót chỗ này, agent QA đối chiếu mã nguồn tìm ra;
4. DORA _Failed Deployment Recovery Time_ = `occurred_at(ROLLBACK) − occurred_at(DEPLOY_SUCCESS)`, tức hiệu của hai
   mốc do HAI tiến trình ghi, và `deployment.dora.ts` không kẹp âm ⇒ một lần khôi phục nhanh hơn độ lệch đồng hồ cho
   ra **thời gian khôi phục ÂM** lọt ra tới API. Đây là lập luận mạnh nhất cho bản sửa và nó không có trong vòng rà
   đầu.

Thiết kế đã có sẵn nguyên tắc này cho lease, và đây là lần **thứ hai** dự án áp nó: Plan #28 QĐ-2 đã đổi `claim()` của
lease từ đồng hồ ứng dụng sang đồng hồ database vì cùng một lý do.

**Đã sửa:** `schema.prisma` đổi `occurredAt` của `DeploymentEvent` sang `@default(dbgenerated("clock_timestamp()"))`
(Prisma bỏ cột khỏi câu INSERT, Postgres tự điền; trường vẫn đặt tay được), kèm migration
`20261002040000_deploy_event_time_from_database`. Dùng `clock_timestamp()` chứ **không** `CURRENT_TIMESTAMP`: đã đo
thấy `CURRENT_TIMESTAMP` (`= transaction_timestamp()`) cho hai sự kiện ghi trong cùng một transaction **cùng một mốc**,
và thứ tự lại thành bất định. Ba truy vấn quyết định thêm khoá phụ `id`, cộng hai câu `DISTINCT ON` chỉ để hiển thị
(`architecture.service.ts`, `home.service.ts`) cho khoá sắp thành TOÀN PHẦN. Khoá phụ đó KHÔNG phải một đồng hồ —
uuid7 sinh ở client và thiên vị có hệ thống về tiến trình chạy nhanh — nên thứ chặn cặp nguy hiểm (`ROLLBACK` của
Service 3 trùng mốc với `DEPLOY_SUCCESS` của Service 1) là độ phân giải micro giây của cột, không phải khoá phụ.
Helper `deployed()` của test bỏ hẳn việc tự đặt mốc, đi đúng con đường production.

**Độ chính xác lên micro giây, cùng migration:** cột đang là `TIMESTAMPTZ(3)` nên hai sự kiện cách nhau dưới 1 ms
BẰNG nhau, và thứ tự phải nhờ khoá phụ `id`. Nhưng `id` là `uuid(7)` do Prisma sinh ở MÁY của writer, tức đúng cái
đồng hồ vừa bị loại — khi hai sự kiện đến từ hai tiến trình thì khoá phụ đó thiên vị tiến trình chạy nhanh. `(6)` làm
cửa sổ trùng gần như không xảy ra, và cũng khớp lại với §2.2 của thiết kế (mọi cột thời gian ghi `TIMESTAMPTZ` trần,
mà `TIMESTAMPTZ` của Postgres LÀ micro giây).

**Phạm vi — vì sao chỉ đổi một cột, và điều kiện để phần còn lại còn an toàn.** Schema có 23 cột `@default(now())`.
Rà từng cái (ba điều kiện, không phải một; ghi đầy đủ ở đầu §2.2 của `UDP_design.md`):

1. `audit_logs.occurred_at` **có nhiều writer** — Service 1 và Service 2 (`flag-service/src/core/audit.ts`), thiết kế
   cho phép cả Service 3. An toàn vì KHÔNG quyết định nghiệp vụ nào đọc thứ tự của nhật ký: chỉ hiển thị, và phân
   trang OFFSET không lặp/sót nhờ khoá sắp hai cột bất biến.
2. `rollout_sessions.created_at` và `rollout_events.created_at` **CÓ quyết định đọc thứ tự** — Service 3 xếp hàng đợi
   vòng quét theo `created_at ASC` (`pd-controller/src/rollout-session/session.repository.ts`) và chọn intent theo
   `created_at ASC` (`event.repository.ts`, luật "bấm trước làm trước"). An toàn vì cả hai tập hàng được xếp đều do
   MỘT tiến trình ghi (Service 1, worker nằm trong tiến trình API). **Điều kiện:** thêm thực thể core-backend thứ hai
   thì phải đổi hai cột này sang `clock_timestamp()` TRƯỚC.
3. 19 cột `created_at`/`updated_at` còn lại: một writer, chỉ hiển thị, phân trang, dọn dẹp.

**Một nguy cơ MỘT LẦN ở đúng mốc migration:** hàng ghi trước mang đồng hồ máy (nhanh hơn database 1,5 giây), hàng đầu
tiên sau mang đồng hồ database, nên trong một cửa sổ rộng bằng độ lệch, một sự kiện MỚI có thể xếp TRƯỚC một sự kiện
CŨ của cùng workload. Hệ quả tối đa là một lượt vá image nền bị BỎ QUA, tức hướng an toàn. Ghi trong chú thích của
migration.

**Lỗi rà soát của chính lượt này, giữ lại để không lặp:** vòng rà đầu kết luận "các cột còn lại chỉ có một writer và
không quyết định gì" — SAI cả hai nửa, vì tôi grep `createdAt: "desc"` nên bỏ sót hai truy vấn SQL thô xếp
`created_at ASC` của Service 3, và cắt kết quả grep bằng `head` nên bỏ sót flag-service cũng ghi audit. Agent QA đối
chiếu thiết kế tìm ra. Bài học: grep một chiều sắp xếp là grep nửa vấn đề, và `head` trên một phép kiểm phạm vi là
che mất chính thứ đang tìm.

### 3.1.1 Hai đề xuất của QA mà tôi CHƯA làm, và vì sao

Ghi ra để người tiếp theo không phải tìm lại, và để người dùng quyết.

- **`currentIssuedAt` nên là `MAX(issuedAt)` thay vì "chữ ký của lần SUCCESS mới nhất".** Agent QA kỹ thuật đánh giá
  đây là đề xuất mạnh nhất của nó: đơn điệu theo định nghĩa nên miễn nhiễm với mọi đồng hồ và mọi thứ tự, một vòng đi
  về thay vì hai, và chặn thêm một ca bản hiện tại để lọt (lần deploy mới nhất mang chữ ký CŨ hơn một lần trước nó thì
  mốc `notBefore` bị kéo TỤT xuống). **Chưa làm vì nó đổi ngữ nghĩa của một tiêu chí đã duyệt:** AC-8/AC-10 viết
  "không cũ hơn **bản đang chạy**", còn `MAX` là "không cũ hơn **mọi chữ ký đã từng được chấp nhận**" — chặt hơn, và
  sau một lần rollback có chủ đích về image cũ thì hai cách cho kết quả khác nhau. Đổi tiêu chí đã duyệt là việc phải
  xin duyệt, không phải việc tự quyết giữa lúc sửa lỗi (R5). Nếu người dùng duyệt thì đây là một cải thiện thật.
- **Một race CÓ SẴN ở QĐ-13, không do 61d-1 và chưa sửa.** Trong `receiveWebhook`, khoá advisory lấy theo
  `(environment, pipelineId)` nhưng `latestDeployment` được đọc TRƯỚC khi lấy khoá dòng project. Hai lượt chạy pipeline
  KHÁC nhau của cùng workload không khoá lẫn nhau, nên ở READ COMMITTED cả hai có thể đọc cùng một ảnh chụp cũ rồi đều
  ghi `DEPLOY_START`. Nghĩa là `occurred_at` đúng thứ tự **chưa đủ** để QĐ-13 đúng. Cách sửa rẻ nhất khi làm tới: đổi
  khoá advisory sang `(environment, workloadName)`, hoặc thêm một khoá thứ hai theo workload TRƯỚC bước đọc. Nằm ngoài
  phạm vi bản sửa này.

- **Một luật `design-lint` canh cả LOẠI khiếm khuyết này.** Agent QA đối chiếu thiết kế chỉ ra đúng cơ chế đã để khiếm
  khuyết sống được: `schema-conformance.test.ts` tự nhận canh §2.2 nhưng chỉ so TÊN CỘT và chiều NOT NULL, không so
  DEFAULT — mà cột `@default(now())` của Prisma vẫn CÓ một DEFAULT ở database (chỉ là không bao giờ dùng tới), nên
  phép kiểm xanh trong khi tài liệu nói sai. **Chưa làm vì nó không bịt thêm lỗ nào:** `describe` hồi quy mới canh cả
  hai nửa (catalog của database và hình dạng câu INSERT) và nó chạy trong CI qua `pnpm test:scratch`, nên một lần lùi
  sẽ đỏ. Một luật `design-lint` chỉ làm nó đỏ SỚM hơn (không cần database) và sẽ đòi chú thích lại 22 dòng `DEFAULT
NOW()` của §2.2 để không báo động giả. Đáng làm nếu sau này §2.2 còn trôi lần nữa.

Hai việc nhỏ hơn cũng ghi lại: _Lead Time for Changes_ vẫn là phép đo liên-đồng-hồ (vế `commit_timestamp` đến từ CI) và
`deployment.dora.ts` không kẹp âm — đã ghi vào §2.2 của thiết kế; và `jobs/reconcile.ts` so `occurred_at` với
`now() - 60 giây` nên trước bản sửa cửa sổ thật là 61,5 giây, nay cùng một thước.

### 3.2 Những phát hiện khác

- **Drone thay `${…}` trước khi đọc YAML** (runner-go, `envsubst`; biến lạ thành rỗng — đọc tại mã nguồn). Lỗi có từ
  61b/61c: đăng nhập bằng mật khẩu (`${UDP_REGISTRY_USERNAME:-}`) luôn báo thiếu secret, lượt rebase (`${UDP_KIND:-}`)
  bị báo như lần deploy thường. Đã sửa: adapter Drone thoát `${` thành `$${`; bộ hợp đồng CI/CD có phép kiểm riêng.
- **Thoái lui suýt có:** bản đầu của script danh tính 61d cần cloud của project, nên project đẩy ECR mà chưa có thông
  tin đăng nhập cloud mất cả script lẫn việc "danh tính build". Đã sửa trước khi commit (chế độ không ký) và có test.
- **Lỗ hổng tự rà ra:** nếu `PUT /build` mang `enforce`, Portal mở từ trước lúc cổng tự bật mà lưu cài đặt khác sẽ tắt
  bắt buộc. Đã tách thành thao tác riêng; `PUT /build` giữ giá trị đang lưu.
- **Test chập chờn có sẵn (61c):** test rebase trộn đồng hồ máy test với `now()` của database. Đã đổi sang đồng hồ của
  database.
- **Node ở máy dev là 22.20.0**, repo đòi `>=22.22.2` từ 61d-1 (`@sigstore/verify` 4.x) — nâng lên bản 22 mới nhất. Máy
  ảo production chạy 22.23.3.
- Còn nhắc từ trước: Artifactory OSS không phục vụ registry Docker (chỉ bản Pro/JCR); database dev có hai hàng test mồ
  côi (`aceb37f2…` DOMAIN_APPLY QUEUED, `77e74112…` PROVISION CLUSTER) — test đã kín trước chúng, có thể xoá tay.

## 4. Cho người tiếp theo

- **Thêm một mã từ chối của cổng:** `SIGNATURE_REJECTIONS` (`@udp/shared-types`) ⇒ `verifyDeploySignature` ⇒ câu ở
  `features/deployment/deployment.messages.ts` (`satisfies Record<…>`: thiếu câu là lỗi biên dịch).
- **Nâng cosign:** bản mới phải kéo sigstore ≥ v1.10.10 (lỗi Azure KMS sigstore#2409 có từ v1.10.9); ghi chú ở
  `packages/config/src/build-toolchain.ts`.
- **Đổi hình bundle hay annotation:** sửa CÙNG LÚC `sign-script.ts`, `signature-gate.ts` và
  `tests/fixtures/signing/` (bundle thật của cosign — ký lại bằng cosign, chỉ giữ khoá công khai).
- **Thêm một CI:** bộ hợp đồng CI/CD (`adapter-base/cicd-suite.ts`) đòi bước ký nằm giữa bước quét và bước báo, chữ ký
  tới bước báo, lượt rebase ký lại.

## 5. Còn nợ — 48 mục

Thêm `signing-kms-real` (ký bằng KMS thật ở ba cloud, cổng deploy với pipeline thật). Chi tiết:
`docs/measurements/kiem-chung-con-no.md`.

## 6. Việc tiếp

61d-2 (Trusted Deploy: token OIDC dùng một lần thay secret tĩnh; bộ ký trong cụm cho CircleCI + Azure), 61d-3 (Kyverno
1.19 kiểm chữ ký ở cụm), tài liệu và Playwright cuối Plan #61, rồi Plan #62 (phát hành SDK bằng trusted publishing —
cần tài khoản npm/PyPI của người dùng).

Commit chỉ ở máy; người dùng tự đẩy lên GitHub. Không đọc hay commit `.env*`.

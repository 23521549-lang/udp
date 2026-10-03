# Bàn giao — UDP, 03/10/2026

Tài liệu này đọc được mà không cần phiên làm việc nào. Nó thay `trang-thai-2026-10-02.md` ở vai "điểm bắt đầu cho
người tiếp theo"; tệp đó giữ nguyên phần 61d-1 và phần phát hiện về mốc giờ sự kiện. Nguồn sự thật của thiết kế là
`docs/UDP_design.md`; của phép đo là `docs/measurements/` (nợ trong `kiem-chung-con-no.md`); của từng plan là
`docs/plans/`.

**Trạng thái một câu:** Plan #61 đã xong 61a, 61b, 61c, 61d-1, 61d-2a, 61d-2b-0, 61d-2b-1, và trong ngày hôm nay
thêm **61d-3a**, **61d-3b**, **61d-3c-1**, **61d-3c-2** — lời báo của pipeline mang token OIDC của chính lượt chạy CI ở cả sáu CI;
Kyverno lên chart 3.9.1 kèm đường hạ về thật (`restoreTo`); mỗi project đã bật ký image nhận một
`ImageValidatingPolicy` kiểm chữ ký lúc tạo pod ở chế độ **Audit**; và toạ độ chart Helm của 71 chart thành một bảng
dữ liệu được canh hằng tuần — lượt canh đầu tiên tìm ra **tám** ghim không cài được, năm đã sửa. Còn 61d-2b-2 (bộ ký
trong cụm cho CircleCI + Azure), tài liệu và Playwright cuối Plan #61, rồi Plan #62 (phát hành SDK). **51 mục nợ kiểm chứng.** Hạ tầng của dự án tốn đúng 0 đồng.

**Một điều phải đọc trước khi tin bảng AC:** AC-12 **đạt MỘT PHẦN**, và spec đã được sửa để nói đúng điều đó kèm một
dòng quyết định có ngày (`plan61-spec.md` §2, [03/10/2026]). Lớp admission đã có và ở chế độ quan sát; nửa "E2E trên
cụm" nằm ở nợ `kyverno-admission-real`; và nửa "tự áp bản vá" **đã bị rút khỏi phạm vi** vì một dữ kiện đo được —
xem phần 9.

## 1. 61d-2a — đã làm

| Phần                  | Nội dung                                                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema                | `WebhookTokenUse` (unique `(issuer, token_id)` tên ghim `webhook_token_uses_once`), cột `domain_configs.oidc_required`, hàm `udp_prune_webhook_token_uses` `SECURITY DEFINER` retention viết cứng, trigger đưa cờ về `false` khi đổi `selected_tool` |
| Xác minh              | `cicd/trusted-deploy.ts`: bảng nhà cung cấp **khai báo**, issuer suy từ cấu hình, JWKS qua `createEgressFetch`, cache giữ bản cũ khi nhà cung cấp hỏng, `jose` ghim RS256 + `maxTokenAge` + `clockTolerance`                                         |
| Dùng một lần          | `cicd/token-use.repository.ts`: `ON CONFLICT DO NOTHING` rồi đếm hàng; `body_digest` phân biệt retry với replay                                                                                                                                      |
| Đường webhook         | `verifyDeployToken` ngoài transaction và sau `verified()`; hai luật cưỡng chế; audit mỗi lần từ chối; 401 terminal vs 503 retryable; nhánh lấy từ CLAIM                                                                                              |
| Công tắc              | tự bật ở token hợp lệ đầu tiên, `PUT /projects/:id/domains/CICD/oidc-required` (MAINTAINER, có tiền điều kiện), reset bằng trigger                                                                                                                   |
| Ba adapter            | GitHub xin token trong bước báo (`id-token: write` luôn có); GitLab khai `id_tokens:` ở mức YAML; CircleCI dùng `$CIRCLE_OIDC_TOKEN_V2`. Header Bearer viết MỘT chỗ trong `notifyScript`                                                             |
| Portal                | in `webhookUrl` của máy chủ thay vì tự ghép ở trình duyệt; hàng trạng thái Trusted Deploy nói đúng lý do khi chưa khả dụng; nút bật/tắt cho MAINTAINER; mock của bản xem thử có route mới                                                            |
| `AppDeps.egressFetch` | thêm vào tiến trình API (trước đó chỉ worker có), kèm sentinel `noEgress` cho 24 chỗ dựng app trong test                                                                                                                                             |
| Tài liệu              | §1.2, §2.1 ERD, §2.2 (bảng mới + cột mới), §2.3, §8.3 đoạn `[v4.12] 61d-2a` kèm bảng nhà cung cấp, §12.1 T6 lớp thứ ba, §16 ba dòng, bất biến **I41**, sổ nợ `trusted-deploy-real`                                                                   |
| Test                  | `trusted-deploy` 22 ô tất định; `cicd-webhook` 37 ô (7 ô Trusted Deploy qua HTTP + database thật, 6 ô cho route bật/tắt); `wire-golden` 124; design-lint 162 (sổ kép bảng nhà cung cấp, retention bảng token)                                        |

## 2. Ba quyết định đáng nhớ, và vì sao

- **KHÔNG dùng `createRemoteJWKSet` của `jose`.** Nó đi `fetch` toàn cục, mà luật của repo
  (`cluster-access/src/transport.ts`) là Service 1 gọi URL do người dùng nhập thì phải đi `createEgressFetch` — có
  chặn SSRF ngay trong `lookup` để không hở DNS rebinding. Issuer GitLab đến từ `tool_config.gitlabUrl` và regex của
  nó NHẬN cả `https://169.254.169.254`. Đã đo rằng `jose.customFetch` tồn tại và dùng được, nhưng tự lấy JWKS còn
  được thêm hai thứ: giữ bản khoá cũ khi nhà cung cấp hỏng, và một đường kiểm tất định.
- **`aud` dùng `CORS_ORIGIN`, không thêm biến mới.** Nó LÀ origin của Portal, tức đúng chuỗi người dùng vẫn copy, và
  đã có tiền lệ ghép URL công khai từ nó. Quan trọng hơn: trước đợt này Portal tự ghép URL ở trình duyệt nên "nguồn sự
  thật duy nhất" cho `aud` **không tồn tại** — phải sửa ba chỗ (biến, hàm ghép ở backend, và bỏ `window.location.origin`
  ở Portal), không phải một.
- **Lần từ chối của Trusted Deploy KHÔNG ghi `DEPLOY_FAILURE`.** Nếu ghi, ai có secret HMAC sẽ bơm được sự kiện hỏng
  vô hạn và làm bẩn Change Failure Rate của DORA. Nó là cổng xác thực nên dấu vết là `AuditLog`, và vì vậy trường
  `trustedDeploy` trên dây chỉ có `VERIFIED` hay `null` — enum được thu hẹp cho đúng sự thật.

## 3. Phát hiện khi làm

- **Tài liệu CircleCI lật một giả định của plan.** `aud` mặc định LÀ `ORGANIZATION_ID` và đổi nó cần một tính năng
  riêng ở mức tổ chức, **không đặt được trong `config.yml`**. Hệ quả bảo mật đã công bố ở §16: với CircleCI, `aud`
  không buộc token vào đúng project — mọi job trong cùng tổ chức đều có token mang đúng `aud` đó — nên việc buộc token
  vào project dựa HOÀN TOÀN vào claim `oidc.circleci.com/project-id`.
- **Bộ hợp đồng CI/CD bắt được một lỗi thật.** Tôi chèn dòng xin token trực tiếp vào mảng của adapter; ở hai trong sáu
  chỗ, phép thụt lề chỉ áp cho kết quả của `notifyScript` nên mấy dòng đó rơi sai cột và sinh **YAML không hợp lệ**.
  Sửa ở gốc: đưa chúng thành tham số của `notifyScript`, rồi thêm `UDP_OIDC_TOKEN` vào danh sách needle của bộ hợp đồng.
- **Cờ `oidcRequired` phải là CỘT RIÊNG, không nằm trong `tool_config`.** Đường ghi duy nhất của `tool_config` là
  `replaceDomains`, vốn `upsert` ghi đè TOÀN PHẦN và chỉ chạy khi project còn sửa được ⇒ cờ sẽ bị xoá im lặng mỗi lần
  lưu cấu hình domain và không bao giờ tự bật được cho project đang chạy. Để ở cột riêng thì lỗi đó biến mất về mặt
  cấu trúc. Tiền lệ và lý lẽ đã có sẵn ở `webhook_secret` (migration Plan #36).
- **Reset khi đổi tool làm bằng TRIGGER, không bằng mã.** `tool_config` không phải đường ghi duy nhất của hàng CICD,
  nên một luật đặt trong một đường ghi là luật mà mọi đường ghi tương lai phải nhớ làm lại. Trigger chỉ bao giờ HẠ cờ
  xuống `false`, không bao giờ bật, nên nó không thể làm một project yếu đi bất ngờ.
- **Bộ hợp đồng dây bắt được một lỗ test của tôi.** Route `PUT /domains/CICD/oidc-required` đi `sendJson` nhưng
  tôi không khai nó trong `ROUTES` của `tests/wire-golden.test.ts`, và sáu ô Trusted Deploy đầu tiên sửa cờ thẳng ở
  database nên KHÔNG ô nào gọi route đó qua HTTP. `wire-golden` đỏ ở đúng phép kiểm "không route sendJson nào thiếu
  dòng trong ROUTES". Sửa bằng cách viết sáu ô HTTP thật (bậc quyền, thân `strict`, idempotent, 409 của tiền điều
  kiện, van xả tắt được kể cả khi `available` đã false, và trigger hạ cờ khi đổi CI) chứ không bằng cách thêm một
  dòng miễn trừ vào `NO_GOLDEN_YET`.
- **Một ô test của tôi sai, và tôi sửa test chứ không sửa mã.** `clockTolerance` 60 giây cố ý cho phép lệch đồng hồ
  giữa CI và UDP, nên một `exp` quá hạn 30 giây vẫn được nhận. Con số lề đó giờ được ghim bằng một phép khẳng định hai
  chiều để nó là tính chất có chủ đích chứ không phải tình cờ.

## 4. Cho người tiếp theo

- **Thêm một nhà cung cấp CI mới:** sửa `TRUSTED_DEPLOY_PROVIDERS` trong `cicd/trusted-deploy.ts` **và** bảng trong
  §8.3 — `packages/design-lint/tests/trusted-deploy-providers.test.ts` khẳng định hai bên bằng nhau, nên thiếu một
  bên là một test đỏ. Và phải xác minh mọi giá trị tại tài liệu của chính nhà cung cấp, không lấy từ trí nhớ.
- **Thêm một mã từ chối:** `TRUSTED_DEPLOY_REJECTIONS` (`packages/shared-types/src/build.ts`), rồi quyết xem nó có
  thuộc `TRUSTED_DEPLOY_RETRYABLE` không (503 vs 401). **Đừng** đưa nó vào `ERROR_CATALOG`: catalog không có mã 401
  nào, và `problem.ts` kiểm số mã LÚC NẠP MODULE.
- **Đổi retention của bảng token:** sửa CÙNG LÚC `CICD_WEBHOOK.tokenUseRetentionDays` và thân hàm
  `udp_prune_webhook_token_uses` — `packages/design-lint/tests/retention.test.ts` chốt hai con số không trôi.
- **Đừng dùng projected ServiceAccount token volume cho 61d-2b.** Token của nó do kubelet cấp và dùng lại suốt vòng
  đời, nên hai lượt build trong cùng một giờ có CÙNG một `jti` và sẽ đập vào chính bảng "dùng một lần".
  `adapter-base/packaging/build-script.ts` đã có `tokenRequestLines(audience, file)` cấp token mới mỗi lần, và Role
  `udp-builder-token` đã cho phép đúng việc đó — đây cũng là chữ của QĐ-17.

## 5. 61d-2b-0 — sửa một lỗ mà không test nào bắt được

Đây là một **lỗi đang sống**, tìm ra khi kiểm giả định ngoài cho kế hoạch 61d-2b, không phải một tính năng.

**Lỗi:** GitHub đổi hình chủ thể trong token OIDC — từ **15/07/2026**, mọi repo mới tạo, đổi tên, hay chuyển chủ phát
`sub` = `repo:<owner>@<ownerId>/<name>@<repoId>:ref:…` thay vì hình theo tên (changelog GitHub 23/04/2026). Script
danh tính của UDP so theo hình cũ ở AWS và Azure, nên những repo đó **không đẩy và không ký được**. GCP miễn nhiễm vì
nó ràng theo claim `repository`, và Trusted Deploy của 61d-2a cũng miễn nhiễm vì cùng lý do đó — đọc claim nghiệp vụ
chứ không đọc `sub`. Bài học nằm sẵn trong chính sự tương phản ấy.

**Và một lỗ nguy hiểm hơn, suýt do chính bản sửa đầu của tôi mở ra.** Tôi định cho AWS nhận
`repo:<owner>@*/<name>@*:ref:…`, lấy lý do "tên owner không chứa `@`". Vòng QA chỉ ra dấu `*` của `StringLike` khớp cả
chuỗi RỖNG, nên hình đó bỏ luôn hai số id — đúng hai số mà hình bất biến sinh ra để chặn. Kịch bản: project đổi tên
repo ⇒ tên `acme/web` trống ⇒ ai tạo được repo trong org đó tạo lại tên ấy ⇒ token của repo MỚI khớp chủ thể được tin
⇒ đẩy image vào đúng repository của project **và ký bằng khoá KMS của project**, tức qua cả cổng chữ ký của 61d-1.
Giờ nó là **T14** của §12.1.

**Cách sửa, và vì sao giữ được hình cũ:** tin HAI chủ thể **khớp đúng**, không ký tự đại diện nào. Hình cũ giữ lại
vẫn an toàn, và điều đó chứng minh được chứ không phải hy vọng: từ 15/07/2026 GitHub áp hình bất biến cho mọi repo
mới tạo, đổi tên hay chuyển chủ, nên một `sub` hình cũ chỉ có thể đến từ repo đã tồn tại trước mốc đó và chưa bao giờ
đổi tên — tức đúng repo của project. Repo của kẻ tấn công luôn là repo mới nên nó phát hình bất biến, mà hình bất biến
thì đã ghim id.

**Hai lỗ cùng họ, cùng được đóng trong đợt này:** (1) pool Workload Identity của GCP bind `…/$POOL/*` — CẢ POOL — nên
mọi provider từng tạo trong pool mạo danh được service account; một project đổi từ GitHub sang Jenkins-trong-cụm vẫn
để repo GitHub cũ đẩy và ký. Giờ bind theo đúng một `principalSet` theo attribute, và lượt chạy lại **dọn** member cũ.
(2) federated credential của Azure chỉ `show || create`, không bao giờ `update` — nên một chủ thể đã đổi được tin mãi,
trái đúng câu "chạy lại đưa quyền về đúng mô tả" ở đầu chính script đó. Giờ có `update` và có dọn credential của nhánh
đã xoá.

**Cho người tiếp:** `tests/identity-script.test.ts` giờ khẳng định `not.toContain("@*")` và dựng đúng chuỗi `sub` của
một repo cùng tên khác id để khẳng định nó KHÔNG khớp. Nếu một ngày có ai muốn "đơn giản hoá" bằng ký tự đại diện,
hai ô đó là chỗ nó đỏ. Và quy tắc rút ra đáng mang sang mọi chỗ khác: **ràng theo claim bất biến, đừng ràng theo tên**
— tên thì trống rồi lấy lại được, id thì không bao giờ dùng lại.

## 6. 61d-2b-1 — Trusted Deploy cho Jenkins, Tekton, Drone

**Dữ kiện làm đổi cả thiết kế:** ClusterRoleBinding **mặc định** của Kubernetes
(`system:service-account-issuer-discovery`, gắn cho nhóm `system:serviceaccounts`) cho **mọi** ServiceAccount — kể cả
`udp-tooling` — đọc `/.well-known/openid-configuration` và `/openid/v1/jwks` trên API server. Nên UDP kiểm được token
ServiceAccount mà **không** thêm một verb nào vào §12.2, **không** bootstrap lại cụm nào, và **không** phải lưu URL
issuer ở đâu. Bàn giao bản trước nói "chỉ issuer nhận diện được project nên phải học và lưu issuer lúc provision" —
câu đó giờ sai: thứ buộc token vào project là **KHOÁ** của cụm, không phải chuỗi issuer.

**Hai nửa buộc token vào project, và cần cả hai.** `aud` chặn dùng chéo project, nhưng `aud` do pod tự khai nên một
pod trong cụm X xin được token mang `aud` của project Y; khoá kiểm lấy từ cụm của ĐÚNG project đang nhận webhook là
nửa còn lại. Chủ thể **không** làm được việc đó: mọi cụm đều có cùng `system:serviceaccount:udp-build:udp-builder`.

**Nhưng chủ thể vẫn phải kiểm, vì một lý do khác** — và đây là chỗ đáng tiền nhất của đợt: thiếu phép kiểm `sub` thì
**mọi pod trong cụm**, kể cả chính ứng dụng đang được deploy, xin được token với `aud` của webhook rồi tự deploy image
bất kỳ. `jose` không kiểm `sub` (đã đo), nên phép kiểm đó phải ở mã của UDP.

**Bậc bảo đảm thấp hơn ba CI SaaS một bậc, và đã công bố ở §16.** Token ServiceAccount không mang claim repo hay ref;
quyền tạo pod trong `udp-build` đến từ RBAC của chart CI chứ không từ UDP; và nội dung pipeline là tệp trong repo của
khách. Nên lớp này chứng minh "lời báo đến từ một pod build trong cụm của đúng project này", **không** chứng minh
nhánh — và với ba CI đó, kẻ kiểm soát repo vượt được cả cổng chữ ký của 61d-1 vì khoá KMS cũng chỉ ràng theo cùng chủ
thể. Portal nói đúng câu đó.

**Năm chỗ tôi sửa vì vòng QA chỉ ra, không vì plan:** cache **âm** (trước đó lỗi không được nhớ, nên webhook của một
project đang hỏng cụm thành máy bơm lời gọi vào cloud của khách); `staleMs = 0` cho nhánh cụm (giữ khoá cũ 24 giờ
không mua được tính khả dụng nào vì cụm hỏng thì deploy cũng không áp được gì); `CLUSTER_NOT_READY` tính ở hai chỗ
GỌI chứ không trong hàm thuần (plan để hở, không ai tính được nó); token của bước báo nằm trong **biến** 600 giây
thay vì tệp `0644` 1 giờ trong volume chung; và `curl --retry` — hoá ra chú thích "503 để curl tự lành" của 61d-2a là
**sai**, bước báo sinh ra chưa bao giờ có `--retry`.

**Cho người tiếp:** nếu một ngày ai đó "dọn RBAC" và cấp quyền issuer-discovery trong `cluster/bootstrap.ts`, ba điều
cùng sai (§12.2 nói sai sự thật, mọi cụm cần bootstrap lại, lý lẽ "không thêm verb nào" mất hiệu lực) — nên
`packages/design-lint/tests/cluster-bootstrap.test.ts` biến đúng lần sửa đó thành test đỏ. Và đừng dời `issuerKeys`
xuống `ReadOnlyClusterAccess`: đặt ở nửa đầy đủ là lý do đường quét drift không gọi được nó, và một ô design-lint
khẳng định `readOnlyAccess()` phơi đúng ba thành viên.

## 7. 61d-3a — Kyverno 2.0.0, và đường hạ về của §8.6 lần đầu có hiệu lực

Chart `kyverno-policies` từ 3.9.x mặc định `policyType: ValidatingPolicy` (họ CEL mới), và khoá `policyExclude` mà
bản 1.0.0 truyền **chỉ** áp dụng cho họ `ClusterPolicy` cũ. Nâng chart mà không đổi gì khác thì ba namespace nền
tảng (`udp-system`, `kube-system`, `udp-build`) **mất quyền miễn trừ trong im lặng** — với `Audit` chỉ bẩn báo cáo,
với `Enforce` thì pod của chính nền tảng và pod build BuildKit bị chặn. Nên: `policyType` ghim **tường minh**, miễn
trừ đi bằng `vpolExclude.excludeNamespaces`, và `upgradesFrom` mang **đủ định nghĩa** của 1.0.0.

Và nửa "hạ về" của §8.6 trước đây **không có hiệu lực**: registry nạp một bản adapter mỗi tool nên cổng `rollback`
cắm cứng `FAILED`, mọi lần nâng thất bại ra `ROLLBACK_FAILED` với cụm không được hạ về. Giờ `DomainAdapter.restoreTo?`
là đường áp lại, và `restorePort` (ở `day2/domain-upgrade.ts`) là chỗ duy nhất biết luật "adapter không mang định
nghĩa bản cũ ⇒ FAILED". Thêm `restoreTo?` vào bề mặt đã đóng băng cũng đóng một **lỗ của chính cổng đóng băng**: hai
bộ đọc dùng `/^ {2}(\w+)\(/` nên một thành viên `foo?()` không được đếm — ai cũng thêm được phương thức tuỳ chọn mà
cổng không thấy.

## 8. 61d-3b — `ImageValidatingPolicy`, và nó đi vào cụm bằng đường nào

Policy **không** đi bằng một lời ghi CR của `udp-tooling`. Ba dữ kiện bác bỏ lối đó: `cluster/bootstrap.ts` không
cấp quyền nào trên nhóm `policies.kyverno.io`; bootstrap chỉ chạy lúc PROVISION và lúc THÊM environment nên một
quyền mới chỉ tới cụm MỚI; và D-P25 chốt cơ chế cài của UDP là `helm upgrade --install`. Nên policy là **giá trị**
`customPolicies` của release `kyverno-policies` (chart 3.9.1 có khoá đó cho đúng việc này). Hệ quả: không RBAC mới,
không bootstrap lại, và trôi/hạ về/teardown dùng lại nguyên máy móc của lớp nền.

Một đính chính của chính tôi: nhóm/phiên bản là **`policies.kyverno.io/v1beta1`**, không phải `v1alpha1` như ghi
chép trước đó — CRD của 1.19.1 đánh `v1alpha1` là `deprecated: true`, và `v1beta1` là version LƯU TRỮ.

Bảy quyết định của hình policy, mỗi cái đóng một chế độ hỏng đã kiểm ở nguồn: hai cờ `ctlog` (chữ ký của UDP không
có bản ghi minh bạch — `SIGNING_CONFIG_JSON` không khai Fulcio/Rekor/TSA, nên thiếu chúng thì MỌI image "không xác
minh được"); `credentials.secrets` ở namespace của Kyverno; **ba** glob (`<repo>`, `<repo>:*`, `<repo>@*` — image
không khớp bị Kyverno BỎ QUA, nên thiếu dạng trần là một đường lách; còn một glob `*` sẽ đòi chữ ký ở image nền và
chặn cụm); annotation `dev.udp.project`; `pods/ephemeralcontainers` khai riêng (kyverno#16275 — `kubectl debug` là
đường lách nếu thiếu); `mutateDigest: false` tường minh (mặc định của CRD là `true`, tức Kyverno SỬA image thành
digest ngay ở chế độ Audit ⇒ trôi vĩnh viễn với Flux/Argo); và autogen TẮT (nó phủ Deployment/StatefulSet/… nhưng
**không** phủ `Rollout` của Argo lẫn `Canary` của Flagger, trong khi quy tắc ở tầng `pods` phủ đủ).

**Ship `[Audit]`, không `Deny`.** E2E kind + Kyverno cần một registry mà cả kubelet lẫn pod Kyverno gọi được bằng
CÙNG một chuỗi image, mà cụm kind của UDP cố ý không có registry và máy 7,7 GB không chạy nổi lượt đó. Thay vào đó
là một phép đo **chạy được và đã chạy**: `measure:kyverno-crd` tải chính file CRD của tag `v1.19.1` (444 664 B,
sha256 `32436252cd83…`), dựng bộ kiểm JSON Schema từ `openAPIV3Schema` của version lưu trữ, rồi kiểm policy sinh từ
mã sản phẩm — **3/3 hợp lệ**, cộng một **kiểm ngược** (`validationActions: ["Allow"]`) bị từ chối. Không có ô kiểm
ngược thì ba ca xanh kia không chứng minh gì.

## 9. 61d-3c-1 — ghim chart thành dữ liệu, và tám ghim không cài được

**Phát hiện lớn nhất của cả ngày:** cổng `pnpm chart:check` (mới) tìm ra **tám** ghim chart mà `helm upgrade
--install --version <ghim>` không tải về được — tức tám adapter không cài được chart của mình. Một trong tám
(`snyk-monitor 2.13.1`, repo chỉ còn dòng 2.23.x) **ba vòng QA đọc mã rất kỹ vẫn bỏ sót**, còn cổng tìm ra ở lượt
chạy đầu tiên.

Năm đã sửa, mỗi cái đối chiếu `index.yaml` **và** `values.yaml` thật: `mysql-operator` 2.2.2⇒2.3.0, `zipkin`
0.3.6⇒0.7.0, `snyk-monitor` 2.13.1⇒2.23.26, `raw` 0.3.2⇒**v0.3.2** (lệch một ký tự tiền tố, và chart này dùng ở 7
chỗ), và **repo** của `sealed-secrets` (địa chỉ cũ 404 toàn site). Sửa một ghim ma **không phải** một lần nâng cấp
§8.6: không cụm nào từng chạy chúng, nên `adapter_version` không đổi.

**Ba cái còn lại cố ý KHÔNG sửa**, vì Helm bỏ qua khoá nó không biết **trong im lặng**: sửa version mà giữ `values`
sai biến một lỗi ỒN (job đỏ, domain không deploy) thành một lỗi IM LẶNG (chart cài xong, cấu hình vô tác dụng,
Portal báo ACTIVE). `spinnaker` — chart 2.2.7 không có khoá `kayenta` nào và template không tham chiếu
`.Values.kayenta`; `tekton-pipeline` — chart 1.15.3 không có `controller.replicas`, annotation thật là
`controller.pod.annotations`, nên sửa đúng phải đổi `tektonConfigSchema`, tức một knob cấu hình ĐÃ LƯU của project;
provider GCP — chart chưa bao giờ phát hành lên repo Helm nào. Ba cái nằm trong `KNOWN_BROKEN_CHARTS`, một đường cơ
sở **hai chiều**: mục đã biết hỏng không làm job đỏ, còn mục đã HẾT hỏng thì làm job đỏ kèm câu "xoá nó khỏi danh
sách" — nên lời miễn trừ không mục được.

**Vì sao ghim rời khỏi tệp adapter.** Cổng phải đọc danh sách ghim trên runner CI, nơi không có `.env`, mà nạp
registry adapter kéo theo `adapter-base/helm.ts` → gốc `@udp/config` → `env.ts`, và `env.ts` **ném** khi thiếu biến
(54 tệp dưới `modules/` import từ gốc đó, 9 tệp dùng chính `env` — không có bản sửa rẻ). Lối thứ hai, gắn toạ độ
vào object adapter rồi tra lại lúc chạy, cũng vỡ: `createCicdAdapter` trả `{ ...spec.base }`, một object MỚI, nên
phép tra theo danh tính mất Jenkins, Tekton và Drone — và mất theo kiểu **fail open** (`undefined` ⇒ `[]` ⇒ "ok").
Nên 72 khối chart literal + 7 tham chiếu `RAW_CHART` trên 58 tệp thành `helmChart("…")`, và một cổng grep khẳng
định không tệp adapter nào còn khối literal ngoài vùng `upgradesFrom`.

**Và nửa "tự áp bản vá" của AC-12 bị rút khỏi phạm vi, với lý do đo được.** Không có đường tự áp nào không đi qua
chốt xác nhận production của §8.6: `grep 'scope: "namespace"'` trên mã sản phẩm cho **0** kết quả (56 tệp adapter
khai `scope: "cluster"` — một bản cài cho cả cụm, không có "Kyverno của dev" để nâng riêng); `DomainConfig` là một
hàng theo (project, domainType) với `adapter_version` là một cột; và `requireProductionConfirm` nổ khi project **CÓ**
environment production chứ không phải khi thao tác **chạm** production, mà mọi project đều có `prod`. QĐ-18 của spec
đã được sửa kèm một dòng quyết định có ngày, và lời hứa "trả nợ 'lịch nâng cấp'" bị xoá — `grep` cho thấy món nợ đó
chưa bao giờ được ghi.

## 10. 61d-3c-2 — hai cổng, một `--fix`, và ba lần cổng bắt đúng chuyện của chính tôi

**Cổng F3** (`pnpm --filter @udp/design-lint chart-bump`) cưỡng chế: đổi `version` của một chart trong
`HELM_CHART_PINS` thì cùng commit phải bump `version` của adapter dùng nó **và** để `upgradesFrom` mang đúng version
chart cũ. Miễn trừ bằng một dòng `Ghim-hỏng: <chart>` trong **thông điệp commit** (lời khai về một commit thì phải
sống cùng commit đó; một danh sách trong mã sẽ mục). Kiểm bằng lịch sử git thật: commit đổi `gatekeeper` mà không
bump adapter ⇒ VI PHẠM; thêm dòng miễn trừ ⇒ đạt.

**Cổng thứ hai** canh hai bản chép cứng digest mà trước giờ không gì canh: bảng `TEST_IMAGE` của bản xem thử Portal
và `FROM` của fixture Dockerfile (fixture này được **build thật** trong `build-smoke`).

**`--fix`** (`pnpm toolchain:fix`) soạn bản vá cho ghim dữ liệu thuần rồi ghi tệp; job CI đính kèm một `.patch` với
`contents: read`, **không** mở PR — PR mở bằng `GITHUB_TOKEN` không kích hoạt workflow nào và `build-smoke` bỏ qua
`pull_request`, nên PR đó sẽ có zero phép kiểm máy. Lượt chạy thật: 4 phép thay (`images.awsCli` 2.37.8⇒2.37.9,
`TEST_IMAGES.python` 3.12.14⇒3.12.15 cùng hai dòng `FROM` và bản xem thử), và **5 mục bị từ chối đúng** (ba finding
`moved` = tag bị đẩy lại, `images.builder` có ba hằng vệ tinh, `STEP_IMAGES.terraform` là ghim có cấu trúc).

**Ba lần cổng bắt đúng chuyện của chính tôi — đọc phần này nếu bạn sắp thêm một cổng:**

1. Mẫu đọc ghim của cổng F3 **fail open**: nó đòi khoá có dấu nháy, mà prettier bỏ nháy ở khoá là định danh hợp lệ
   (`gatekeeper:`) — nên cổng chỉ thấy **42 trong 71** chart và im lặng bỏ qua 29 cái. Mười một ô test dùng khuôn
   viết tay đều xanh; ô đọc **chính tệp sản phẩm** là ô duy nhất bắt (`expected 42 to be 71`).
2. Lượt `--fix` đầu tiên **làm đỏ đúng cổng tôi vừa dựng một giờ trước**, vì nó sửa bảng và Dockerfile nhưng không
   sửa bản xem thử. Bất biến có **ba** đầu, không hai.
3. `apps/portal/tests/evidence.test.tsx` đã **đỏ từ 61d-3b** mà tôi không biết: nó đòi mọi tiền tố tệp thô trong
   `docs/measurements/raw/` phải có một thẻ trong sổ thí nghiệm của Portal, và hai phép đo mới không có thẻ. Tôi
   chạy core-backend, config, design-lint, shared-types, adapter-core — **không chạy Portal**. Cổng em-dash của
   Portal cũng bắt hai dấu `—` tôi vừa viết vào thẻ.

   **Bài học: bộ cổng của repo này nằm ở sáu package, và một phép đo mới chạm ít nhất ba trong số đó.** Trước khi
   commit một đợt có phép đo mới: `@udp/config`, `@udp/design-lint`, `@udp/shared-types`, `@udp/adapter-core`,
   `@udp/core-backend`, **và `@udp/portal`**.

## 11. Việc tiếp

**61d-3 (Kyverno, AC-12) đi TRƯỚC 61d-2b-2 — một lần đổi thứ tự, có lý do đo được.** Vòng lập kế hoạch chi tiết của
61d-2b-2 lật một dữ kiện: `cluster/bootstrap.ts` **không** cho `udp-tooling` quyền `batch/jobs` nào, và namespace
`udp-build` chỉ tồn tại ở project dùng CI trong cụm — nên một bộ ký trong cụm đòi **quyền mới trên cụm khách cộng
một lượt bootstrap lại mọi cụm đang chạy**. Đó đúng là cái giá mà QĐ-1 đã từ chối cho lối TokenReview, và lần này nó
chỉ mua được **một** tổ hợp CI × cloud. AC-12 thì là một tiêu chí nghiệm thu. Phân tích đầy đủ (ba thiết kế, cái giá
của từng lối, và ba việc phải quyết trước dòng mã đầu) nằm ở `docs/plans/plan61-plan.md`; dòng §16 vẫn đúng và vẫn
trỏ `(61d-2b-2)`, nên không có nợ nào bị bỏ lửng.

Vậy thứ tự còn lại: **61d-2b-2** (bộ ký trong cụm cho CircleCI + Azure), rồi tài liệu và Playwright cuối Plan #61,
rồi Plan #62.

**Về 61d-3c-2, ba vòng QA đã làm sẵn phần khó — đọc trước khi gõ dòng đầu.** `--fix` như bản nháp viết **không
chạy được**: `checkRelease` dựng URL checksums bằng bản ĐANG ghim và `publishedSha256` chỉ dùng để _so_, còn
`checkImage` chỉ lấy digest của tag đang ghim — nên `Finding` **không mang** giá trị mới nào và `patchEdits` không
thể sinh `to` đúng. Ship nguyên vậy thì `--fix` ghi _version mới + sha256 cũ_ ⇒ `sha256sum -c -` đỏ ⇒ pipeline đóng
gói của **mọi project khách** hỏng. Cần: `Finding.target` do phần MẠNG điền, cộng hai lượt fetch mới.

Bốn ràng buộc nữa, mỗi cái một chế độ hỏng thật: (a) `isActionable` gồm cả `moved` và `broken`, mà `moved` nghĩa là
_tag giữ nguyên, digest đổi_ — một `--fix` theo `isActionable` là **tự động hoá việc chấp nhận một lần đẩy đè tag**,
đúng sự cố Trivy 03/2026 mà `build-toolchain.ts` sinh ra để chống; (b) `STEP_IMAGES` **không** là chuỗi
`name:tag@sha256:…` (0/16 chuỗi ghim thuộc nó — `stepImage()` lắp lúc chạy), sửa nó là một phép **chèn** vào `pins`
cộng quyết định đổi `latest`, và `"3.267.0"` xuất hiện 6 lần; (c) `golden-path-pins.test.ts` khẳng định **mọi** dòng
`FROM` bằng đúng `TEST_IMAGES.<runtime>` và mỗi Dockerfile có **hai** dòng `FROM`, nên luật "khớp đúng một lần" sai
ngay ở ghim được vá dày nhất; (d) job sẽ **không bao giờ** tới bước mở PR, vì script đặt `exitCode = 1` đúng lúc
`--fix` có việc làm.

Và đường PR: PR mở bằng `GITHUB_TOKEN` **không kích hoạt workflow nào**, còn `ci.yml` có `build-smoke` với
`if: github.event_name != 'pull_request'` — nên PR đó có **zero** phép kiểm máy. Thêm `peter-evans/create-pull-request`
còn đi ngược chính nguyên tắc UDP tự viết ở `build-toolchain.ts` (_"chỉ dùng MỘT action bên thứ ba"_), và nâng
`permissions` tại chỗ hiện tại là ở **cấp workflow** nên job báo cáo cũng nhận `contents: write` trong một job đã
chạy `pnpm install`. Hướng đã chọn: `--fix` ghi một tệp `.patch`, in diff vào `$GITHUB_STEP_SUMMARY` và đính kèm
bằng `actions/upload-artifact@v4` (đã là tiền lệ trong `ci.yml`) — `contents: read`, không action mới.

Hai món nhỏ của 61d-3c-2: cổng cho hai chỗ **chép cứng digest mà không cổng nào canh** (`apps/portal/demo/mock/build.ts`
chép 6 digest của `TEST_IMAGES`; `tests/fixtures/build-apps/dockerfile/Dockerfile` chép `images.alpine`, và fixture
này được **build thật** trong job `build-smoke`), và một dòng báo cáo đếm `DomainConfig.adapter_version` **đang
chạy** so với bản máy chủ nạp — thứ gần nhất với "luồng cập nhật" mà dữ liệu đã có sẵn.

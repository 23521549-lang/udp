# Plan #26 — Cloud Adapter AWS, GCP, Azure và bước cấu hình cloud — SPEC

Trạng thái: **v2, 25/09/2026** (v1 → v2: review tự làm, xem §7). Nguồn: §1.4 ADR-06/07/08, §4.1–§4.6, §8.1, §9, §10.5, §12 của
`docs/UDP_design.md`; sổ nợ `portal-cloud-step`, `I31-aws`, `cred-federation`.

## 1. Mục tiêu

1. Ba Cloud Adapter THẬT (AWS, GCP, Azure) hiện thực đủ 10 phương thức của `CloudAdapter`
   (`packages/adapter-core/src/cloud.ts`), không phương thức nào là stub.
2. Credential Manager đầy đủ hai chiều (§4.3): ghi (envelope encryption đã có ở
   `credential.crypto.ts`) và đọc thành `ResolvedCredential` — cả FEDERATED (mặc định) lẫn
   STATIC (dự phòng).
3. UDP làm OIDC issuer (§4.3 "Federation") để GCP Workload Identity Federation và Azure
   federated credential tin được UDP mà UDP không giữ bí mật dài hạn của khách.
4. Bốn endpoint của bước cloud (§9): `GET|PUT /projects/:id/cloud`,
   `POST /projects/:id/cloud/validate`, `POST /projects/:id/cloud/preflight`, cộng
   `GET /projects/:id/cloud/setup` (dữ liệu Portal cần hiển thị cho khách copy).
5. Portal: bước 2 của wizard (§10.5) và thẻ "Cloud" trong Cài đặt.

**Không thuộc plan này:** hàng đợi `pg-boss` và `POST /provision` (sổ nợ
`portal-job-stream`), Domain Config (`portal-domain-screens`), preview/chi phí trên Portal
(`portal-preview` — `estimateCost` thì CÓ trong plan này, màn hình thì không).

## 2. Ràng buộc nền (không được vi phạm)

| Mã  | Ràng buộc                                                                                                                                                   | Nguồn                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| R1  | `@udp/adapter-core` và package adapter mới KHÔNG phụ thuộc `@udp/db` (ma trận writer §1.2 giữ bằng cấu trúc)                                                | package-boundaries.test.ts             |
| R2  | Secret không bao giờ thành `string`: payload chỉ đọc qua `SecretBuffer.use()`; không log lỗi SDK nguyên vẹn (một số SDK nhét credential vào `error.config`) | §4.2 nguyên tắc, §4.3                  |
| R3  | Mọi tài nguyên mang đủ tag `udp.project`/`udp.key`/`udp.owner`/`udp.managed` (+`udp.ttl` khi có hạn) — ở dạng mà cloud đó cho phép                          | §4.5, `REQUIRED_TAG_KEYS`              |
| R4  | `lookup` ba trạng thái; quét tag lỗi là `indeterminate`/`FAILED`, KHÔNG BAO GIỜ là "cloud rỗng"                                                             | §4.2 `LookupOutcome`                   |
| R5  | Mọi Cloud Adapter qua đủ bộ hợp đồng Cloud (`runCloudAdapterContract`, 38 phép) — không nới lỏng mới nào                                                    | §13.2, `CONTRACT_RELAXATIONS`          |
| R6  | Không mã nào chưa có người dùng trong cùng đợt; không stub; lỗi luôn đi qua `AdapterResult`                                                                 | quy ước repo, yêu cầu người dùng 25/09 |
| R7  | Không thoái cấp: mọi cổng hiện có (typecheck, lint, 2409+ test, golden, I10, I38, sổ nợ ba nơi) giữ xanh                                                    | yêu cầu người dùng 25/09               |

## 3. Quyết định (QĐ) — chọn phương án mạnh nhất

### QĐ-1: Package mới `@udp/cloud-adapters`

Không đặt trong `adapter-core` (giữ nó không phụ thuộc SDK nặng — nó là hợp đồng, runner và
bộ test dùng chung), không đặt trong `core-backend` (adapter là mã dùng lại được, và đặt
trong S1 sẽ làm chúng thấy `prisma`). Subpath: `.` (lõi dùng chung), `./aws`, `./gcp`,
`./azure`, `./testing`.

### QĐ-2: Adapter = KẾ HOẠCH của nhà cung cấp + CỔNG gọi cloud + MỘT lõi điều phối

Ba cloud khác nhau ở API nhưng GIỐNG nhau ở mọi luật khó (ghi sổ trước, lookup ba trạng
thái, thứ tự teardown chín bậc, dựng lại sổ từ tag). Viết ba lần các luật đó là ba nơi để
chúng trôi khỏi nhau. Nên:

- `ProviderPlan` (thuần, theo nhà cung cấp): danh sách step mạng/cluster có `dependsOn`,
  cách mã hoá tag (codec), `lookupBy` theo kind, danh sách quyền cần, bảng giá tĩnh, map
  cỡ node, URL tài liệu.
- `CloudGateway` (cổng, theo nhà cung cấp): các thao tác trung tính —
  `create(kind, name, spec, tags, parents)`, `findByTag`, `findByName`, `describe`,
  `isReady`, `remove`, `listByProject`, `checkPermissions`, `clusterInfo`, `kubeToken`,
  `whoAmI`. Mỗi lỗi cloud được phân loại (`not-found` / `throttled` / `transient` /
  `permanent` / `permission`) ngay trong cổng, để lõi không đọc chuỗi lỗi SDK.
- `createPlannedAdapter(plan, gatewayFor)` (một lõi): hiện thực 10 phương thức.

Hệ quả kiểm chứng: lõi + kế hoạch THẬT của từng cloud chạy qua đủ 38 phép hợp đồng trên
một `CloudGateway` dựng trên `SimCloud` (bơm lỗi được). Hai điều kiện để phép đó không
rỗng (rút ra từ review spec v1):

- Mỗi cloud có `CloudFixture` VIẾT TAY riêng (tổng tài nguyên, số theo kind, số step) —
  bộ hợp đồng cấm suy kỳ vọng từ chính danh sách step của adapter.
- Cổng mô phỏng đi qua CODEC tag của cloud ở biên: mã hoá (và khẳng định mọi label/tag
  hợp lệ theo luật của cloud đó), rồi giải mã về dạng chuẩn trước khi lưu vào `SimCloud`,
  vì các phép kiểm tag của bộ hợp đồng đọc kho của `SimCloud` ở dạng chuẩn. Cổng thật
  cũng giải mã khi đọc lại (§4.2: `tags` là tag ĐỌC LẠI TỪ CLOUD, ở dạng chuẩn). Phần duy nhất cần tài khoản thật là
  cổng SDK mỏng của từng cloud — đó là **nợ kiểm chứng**, không phải nợ kỹ thuật.

### QĐ-3: Thư viện

- AWS: AWS SDK v3 dạng module (`client-sts`, `client-iam`, `client-ec2`, `client-eks`,
  `client-resource-groups-tagging-api`) — SigV4 và retry chính chủ; ghim chính xác phiên bản.
- GCP: `google-auth-library` CHỈ để lấy token (JWT của service account, WIF qua STS);
  gọi Compute/Container/Resource Manager bằng REST.
- Azure: `@azure/identity` CHỈ để lấy token (client secret, client assertion); gọi ARM REST.
- Lý do REST cho GCP/Azure: thư viện client đầy đủ của hai cloud kéo hàng trăm MB phụ
  thuộc cho vài chục endpoint; REST có kiểu hoá bằng zod ở biên là đủ và kiểm được.

### QĐ-4: Codec tag theo cloud

| Cloud | Khoá                                                                                                                                                                              | Giá trị `udp.key`                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| AWS   | nguyên văn (`udp.project`, …)                                                                                                                                                     | nguyên văn `{projectId}:{step}:{kind}:{name}`                                             |
| Azure | nguyên văn (Azure cho phép `.`)                                                                                                                                                   | nguyên văn                                                                                |
| GCP   | label chỉ nhận `[a-z0-9_-]`, ≤ 63 ký tự: `udp-project`, `udp-step`, `udp-kind`, `udp-name`, `udp-owner`, `udp-managed`, `udp-ttl`, và `udp-key` = 40 hex đầu của SHA-256 của khoá | dựng lại khoá từ bốn label thành phần; `udp-key` là chỉ mục tra cứu và phép kiểm toàn vẹn |

Codec là hàm thuần hai chiều, có test đi-về cho mọi kind.

### QĐ-5: Federation là mặc định, UDP là OIDC issuer

- AWS_ROLE: `sts:AssumeRole` bằng identity nền của UDP (chuỗi credential mặc định của
  SDK), `ExternalId` = HMAC-SHA256(`UDP_EXTERNAL_ID_SECRET`, projectId) cắt 32 ký tự —
  tất định theo project, không đoán được, không cần lưu.
- GCP_WIF: đổi ID token do UDP ký (audience = provider của pool) lấy access token qua
  STS, rồi impersonate service account của khách.
- AZURE_FEDERATED: client assertion = ID token do UDP ký, subject `project:<id>`.
- S1 phục vụ `/.well-known/openid-configuration` và `/oidc/jwks`, ký RS256 bằng
  `UDP_OIDC_SIGNING_KEY` (PEM), `kid` = thumbprint RFC 7638. Không khoá ⇒ federation
  GCP/Azure báo lỗi cấu hình rõ ràng, STATIC vẫn chạy.
- STATIC (`AWS_KEY`, `GCP_KEY`, `AZURE_SECRET`): dự phòng, `expiresAt` = 15 phút, Portal
  hiện cảnh báo thường trực.

### QĐ-6: Credential Manager ở Service 1

- `cloud.service` ghi `cloud_credentials` (S1 là writer duy nhất): một credential ĐANG
  DÙNG mỗi project (`is_active`), bản mới thay bản cũ trong một transaction; audit chỉ
  chứa fingerprint + metadata.
- `credential.resolver`: giải mã → `CredentialExchange` của cloud tương ứng (ở
  `@udp/cloud-adapters`) → `ResolvedCredential` với payload là token ngắn hạn. Plaintext
  dài hạn không rời hàm resolver; buffer giải mã được `fill(0)` ngay sau đổi token.

### QĐ-7: Quyền endpoint

`GET /cloud`, `GET /cloud/setup`: MAINTAINER (lộ thông tin cấu hình tài khoản khách, không
lộ bí mật). `PUT /cloud`, `POST /cloud/validate`, `POST /cloud/preflight`: OWNER (§2.2
"OWNER quản lý credential"). Registry adapter tiêm qua `createApp(deps)` như
`metricsFor`/`flagService`, để test dùng cổng mô phỏng.

## 4. Tiêu chí chấp nhận (AC)

| Mã    | Tiêu chí                                                                                                                                                                            | Cách kiểm                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| AC-1  | Mỗi adapter AWS/GCP/Azure qua đủ 38 phép hợp đồng Cloud, 0 nới lỏng mới                                                                                                             | `runCloudAdapterContract` × 3 trên cổng `SimCloud` |
| AC-2  | Codec tag đi-về đúng cho mọi `CreatedResourceKind`; label GCP hợp lệ theo luật GCP                                                                                                  | test thuần                                         |
| AC-3  | `preflightPermissions`: AWS `exact` khi gọi được SimulatePrincipalPolicy, `heuristic` khi không; GCP `exact`; Azure `heuristic`; `missingPermissions` đúng tập thiếu                | test cổng giả                                      |
| AC-4  | `estimateCost` có đủ ba mục `control-plane`, `nat-gateway`, `load-balancer` cho cả ba cloud, `pricingAsOf` khai                                                                     | test thuần                                         |
| AC-5  | Cổng SDK của từng cloud: mỗi thao tác map đúng lời gọi SDK/REST và phân loại lỗi đúng (404 ⇒ not-found, throttle ⇒ throttled, 403 ⇒ permission); lỗi không mang credential ra ngoài | test với client SDK giả lập ở tầng HTTP/command    |
| AC-6  | `PUT /cloud` lưu payload mã hoá, không cột nào chứa plaintext; bản cũ hết `is_active`; audit không chứa giá trị bí mật                                                              | test tích hợp + quét sentinel                      |
| AC-7  | `validate`/`preflight` trả đúng kết quả của adapter; project không có credential ⇒ 409 rõ nghĩa; không có adapter cho cloud đó ⇒ 503 `PROVIDER_UNAVAILABLE`                         | test tích hợp với registry mô phỏng                |
| AC-8  | OIDC: discovery + JWKS hợp lệ; token ký kiểm được bằng JWKS công bố; `sub` = `project:<id>`                                                                                         | test thuần + tích hợp                              |
| AC-9  | Resolver: STATIC ⇒ `expiresAt` ≤ 15 phút; buffer giải mã bằng 0 sau khi đổi token; FEDERATED gọi đúng cơ chế đổi token                                                              | test                                               |
| AC-10 | Portal: bước 2 wizard + thẻ Cloud; chọn cloud → cơ chế → hiện đúng dữ liệu setup có nút copy; validate/preflight hiện quyền thiếu                                                   | test Portal với mẫu golden                         |
| AC-11 | Mọi response mới có schema dây `.strict()` và mẫu golden thật                                                                                                                       | `wire-golden.test.ts`                              |
| AC-12 | Không thoái cấp: typecheck, lint, format các tệp chạm, mọi bộ test hiện có xanh                                                                                                     | lệnh cổng từng pha                                 |

## 5. Nợ kiểm chứng (ghi sổ, không phải nợ kỹ thuật)

Sổ đã có sẵn các mục cho phần chạy trên cloud THẬT — Plan #26 cập nhật chúng, không ghi
trùng: `I31-aws` (lưới trên AWS thật), `preflight-confidence`, `getkubeauth-that`,
`k8s-managed-discovery`, `estimatecost-vs-bill`, `cred-federation`. Chỉ thêm mục mới cho
lưới trên GCP và Azure (chưa có mục tương đương `I31-aws`) ở P3/P4: `I31-gcp`, `I31-azure`.

## 6. Rủi ro

| Rủi ro                                                     | Giảm thiểu                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Phụ thuộc SDK lớn làm chậm cài đặt/CI                      | SDK chỉ ở package mới; client module nhỏ; ghim phiên bản                     |
| Nhầm lẫn giữa `CloudProvider` hoa (DB) và thường (adapter) | dùng `provider-codec.ts` sẵn có, không `as`                                  |
| Codec GCP làm mất thông tin khoá                           | test đi-về cho mọi kind + kiểm hash toàn vẹn                                 |
| RAM máy không đủ chạy bộ hợp đồng ba lần                   | bộ hợp đồng chạy in-process trên SimCloud, đã đo nhẹ (adapter-core 409 test) |

## 7. Nhật ký review

| Vòng    | Phát hiện                                                                                                                                                                                                      | Xử lý                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| v1 → v2 | Bộ hợp đồng cần `CloudFixture` viết tay cho từng adapter, nếu không AC-1 sẽ dùng nhầm fixture của adapter mô phỏng                                                                                             | thêm vào QĐ-2 và vào plan (mỗi cloud một fixture)                                                                                          |
| v1 → v2 | Phép kiểm tag của bộ hợp đồng đọc thẳng `SimCloud.listAll()`; label GCP đã mã hoá sẽ làm mọi phép tag đỏ giả                                                                                                   | cổng mô phỏng mã hoá + kiểm hợp lệ + giải mã ở biên                                                                                        |
| P2      | Định ghi `cloud-aws-live` — trùng `I31-aws` và bốn mục khác đã có                                                                                                                                              | cập nhật mục cũ, §5 viết lại                                                                                                               |
| P3      | QĐ-3 định dùng `google-auth-library` và `@azure/identity` chỉ để lấy token; đo lại: đổi token của cả hai chỉ là (a) ký JWT RS256 — `node:crypto` làm được — và (b) một POST form tới endpoint token            | GCP và Azure dùng REST qua `fetch` TIÊM VÀO, không thư viện; test bằng HTTP giả ở tầng request                                             |
| P3      | Label GCP chỉ nhận `[a-z0-9_-]`: `udp.ttl` (ISO) và `udp.key` (có `:` và chữ hoa) không đặt thẳng được                                                                                                         | `udp-ttl` = epoch mili-giây; `udp.key` tách thành `udp-step`/`udp-kind`/`udp-name` + `udp-key` = 40 hex SHA-256 để tra và kiểm toàn vẹn    |
| P3      | GCP chỉ cluster GKE có label; network, subnet, firewall, router, NAT, service account, node pool KHÔNG có                                                                                                      | các kind đó tra theo tên tất định; `description` mang `udp.key` để tên trùng với tài nguyên của khách bị từ chối thay vì bị nhận nhầm      |
| P3      | Bộ hợp đồng đỏ: `udp.owner` là email, mà `@` và `.` không được phép trong giá trị label — GKE thật sẽ từ chối tạo cluster                                                                                      | mã thoát byte UTF-8 (`_xx`) đi–về chính xác cho mọi chuỗi; quá 63 ký tự chia khúc `<khoá>_2`…; test email, tiếng Việt, giá trị dài         |
| P4      | Trong một bậc teardown, lõi xoá theo thứ tự tạo: Elastic IP/Public IP trước NAT còn giữ nó, NSG trước subnet gắn nó — cloud thật từ chối ⇒ mồ côi; SimCloud không mô phỏng "đang dùng" nên hợp đồng không thấy | lõi sắp mỗi bậc theo thứ tự NGƯỢC kế hoạch (đúng câu "theo thứ tự ngược" của §4.2); test với cổng từ chối xoá thứ đang dùng                |
| P4      | ARM chặn xoá NAT gateway còn gắn subnet, mà subnet ở bậc SAU NAT                                                                                                                                               | `beforeRemove` của NAT: GET subnet, bỏ `natGateway`, PUT lại, chờ `Succeeded`, rồi mới DELETE                                              |
| P4      | PUT của ARM là tạo-HOẶC-cập-nhật: PUT lại VNet không kèm `subnets` là xoá subnet; PUT trùng tên tài nguyên của khách là ghi đè                                                                                 | cổng GET trước: có và mang dấu UDP ⇒ không PUT; có mà không phải của UDP ⇒ `permanent`                                                     |
| P4      | AKS với VNet tự quản cần managed identity của control plane có Network Contributor trên subnet — ARM không tự cấp                                                                                              | step `identity-network` (kind `iam-policy`): role assignment tên GUID tất định mang mã ngắn của project ⇒ tra theo tên suy lại được subnet |
| P4      | Đổi token GCP và Azure lặp cùng một đoạn gọi endpoint OAuth + đọc payload đã lưu                                                                                                                               | gom vào `core/credential-exchange.ts`; AWS/GCP/Azure cùng dùng, cùng một hằng 15 phút                                                      |

# Plan #27 — Domain Config, Catalog và Drift trên Portal — SPEC

Trạng thái: **v1, 25/09/2026**. Nguồn: §2.2 (`DomainCatalog`, `DomainConfig`,
`CapabilityPreference`), §5.2–§5.5, §8.1, §8.2, §8.6, §9 (Domain, Catalog, Day-2), §10.7,
§10.12–§10.14 của `docs/UDP_design.md`; sổ nợ `domains-catalog-route`,
`portal-domain-screens`, `domain-day2-route`.

## 1. Mục tiêu

1. `GET /api/v1/domains/catalog` dựng TỪ adapter registry (§5.3, I29) — phép kiểm DƯƠNG
   TÍNH của I28: một adapter mới đặt vào thư mục của nó tự hiện trên catalog, 0 tệp ngoài.
2. `GET /projects/:id/domains`, `POST /projects/:id/domains/validate`,
   `PUT /projects/:id/domains` — cấu hình domain của project nháp (§8.1): validator trên
   trạng thái ĐÍCH, Zod từng `tool_config`, khoá cả tập `domain_set_version`, lưu
   `PENDING`; lựa chọn provider (AMBIGUOUS_PROVIDER) lưu cùng lần PUT.
3. `GET /projects/:id/domains/:type` và `GET /projects/:id/domains/:type/drift` — trạng
   thái một domain và kết quả quét drift gần nhất.
4. Portal: trang Domain của project (bật/tắt, chọn tool, form cấu hình dựng từ schema của
   adapter, kiểm trực tiếp, nút hành động theo mã lỗi, thứ tự triển khai), chi tiết một
   domain (trạng thái, drift), bước 3 của wizard, và trang quản trị Catalog.

**Không thuộc plan này — và vì sao (không làm nửa vời):**

- `POST …/domains/:type/upgrade`, `POST …/domains/:type/drift`, `GET …/versions`: ba route
  này CHẠY adapter trên cluster (`contextFor` cần `ClusterAccess` thật) qua job
  `DOMAIN_APPLY` (cần `pg-boss`). Cả hai hạ tầng chưa có; một route trả 202 mà không có
  gì thực thi là stub. Sổ nợ `domain-day2-route` giữ, tiền đề được viết lại cho đúng.
- `PUT /domains` khi project KHÔNG ở `DRAFT` (§8.2: diff → DEPLOYING → job): cần chính job
  đó. Route trả 409 kèm slug riêng và nói rõ, không lưu một trạng thái không ai áp.

## 2. Ràng buộc nền

| Mã  | Ràng buộc                                                                                                                    | Nguồn                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| R1  | Catalog không có danh sách cứng nào ở Service 1 hay Portal: tool, phiên bản, capability, trường cấu hình đều đọc từ registry | §5.3 bảng "0 file", I28 |
| R2  | Validator là `validateAndOrder` sẵn có — không viết lại luật nào                                                             | §5.3, I13               |
| R3  | Mã lỗi thuộc catalog 24 mã (I36); mã validator đã có sẵn trong đó                                                            | §9                      |
| R4  | Mọi response mới: schema dây `.strict()` + mẫu golden thật; controller gửi qua `sendJson`                                    | D-P8, AC-11 của #26     |
| R5  | `domain_catalog` chỉ owner ghi (I22) — Service 1 CHỈ đọc; registry ↔ catalog kiểm lúc khởi động                              | I29, ma trận writer     |
| R6  | Không thoái cấp: typecheck, lint, format, mọi bộ test, golden, I10, I38, sổ nợ ba nơi                                        | yêu cầu người dùng      |

## 3. Quyết định

### QĐ-1: Tham số đường dẫn là `:type`

§9 và §10.13 dùng `:type`; sơ đồ §8.6 và chú thích `domain-upgrade.ts` dùng `:domainId`.
`(project_id, domain_type)` là UNIQUE, nên `:type` đủ định danh và đọc được trên URL. Chú
thích lệch được sửa; §10.15 ghi D-P.

### QĐ-2: Registry là phụ thuộc tiêm qua `createApp`

`AppDeps.domains: DomainRegistry` — bản thật `createRegistry({ root: src/modules })` nạp
lúc khởi động; test tiêm registry dựng từ thư mục fixture. `index.ts` gọi
`assertRegistryCoveredByCatalog` TRƯỚC khi mở cổng (fail-fast: adapter mà catalog không
biết là cấu hình sai, không phải một domain im lặng biến mất).

### QĐ-3: Form cấu hình dựng từ `configSchema` của adapter

Catalog trả `configFields` cho từng tool: duyệt `ZodObject` của adapter thành
`{key, kind: string|number|boolean|enum|json, required, options?, default?}` (hàm thuần
`describeConfigSchema`). Kiểu lồng hoặc lạ ⇒ `json` (ô nhập JSON) — không bao giờ bỏ im
một trường. Server vẫn parse bằng CHÍNH `configSchema` lúc PUT (một nguồn sự thật).

### QĐ-4: Hình của validate và PUT

- `POST /domains/validate` nhận trạng thái đích (như body PUT, bỏ version) và trả
  `DomainValidationResponse` §9: `valid`, `errors[] {code, subject, detail[],
suggestedAction?}`, `warnings[]`, `deployOrder[][]`. Chữ hiển thị do Portal dựng từ mã
  - subject + detail (I37). `rebindPlan` không trả: chỉ có nghĩa khi đã có binding (sau
    ACTIVE), tức sau job — D-P.
- `PUT /domains` nhận `{lastKnownDomainSetVersion, domains[{domainType, enabled, toolId,
config}], preferences[{capabilityId, providerToolId}]}`. Thứ tự kiểm: quyền → project
  DRAFT (409 `domains-need-apply-job`) → version (409 `OPTIMISTIC_LOCK` kèm bản hiện
  tại) → domain/tool tồn tại và `is_available` (422) → Zod từng config (400, trường
  `domains.<i>.config.<key>`) → validator (422 mã catalog + `suggestedAction`) → một
  transaction: upsert `domain_configs` (PENDING), thay `capability_preferences`, tăng
  `domain_set_version` có điều kiện (`WHERE version = lastKnown`, 0 hàng ⇒ 409).
- Body là TOÀN BỘ trạng thái đích: domain đang bật mà không có trong body bị tắt. Gửi phần
  thay đổi thì validator phải ghép với trạng thái đang lưu — và hai người sửa hai domain
  khác nhau sẽ ghép lên hai nền khác nhau; khoá `domain_set_version` chỉ bảo vệ được khi
  mỗi lần ghi mang cả tập.
- `preferences` gộp vào PUT thay cho `PUT /capability-preferences` riêng: lựa chọn provider
  là một phần của trạng thái đích và phải qua cùng validator, cùng khoá phiên bản — hai
  endpoint là hai cửa sổ đua. D-P.

### QĐ-5: `suggestedAction` suy từ catalog, không đoán

`MISSING_CAPABILITY cap` ⇒ `ENABLE_DOMAIN` với tool đầu tiên (theo thứ tự registry) CUNG
CẤP `cap` ở phiên bản thoả ràng buộc; không có ⇒ không gợi ý. `AMBIGUOUS_PROVIDER` ⇒
`CHOOSE_PROVIDER` với `capabilityId`. `VERSION_MISMATCH`/`CONFLICT` ⇒ không gợi ý máy
(Portal hiện chữ): chọn thay người dùng giữa hai tool xung đột là đoán.

### QĐ-6: Drift chỉ ĐỌC trong plan này

`GET …/drift` đọc `last_error` do `scanDomainDrift` ghi (`DriftRecord`): `CLEAN` (không
có bản ghi drift), `DRIFTED` / `SCAN_FAILED` kèm `message` và `at`. "Chưa quét lần nào"
và "sạch" là hai câu khác nhau: domain chưa ACTIVE trả `NOT_DEPLOYED`.

### QĐ-7: Quyền

Catalog: mọi người đã đăng nhập. `GET domains`, `GET :type`, `GET drift`: VIEWER.
`POST validate`: DEVELOPER (không ghi, nhưng là công cụ của người cấu hình). `PUT`:
MAINTAINER (§8.6 dùng MAINTAINER cho thao tác domain; §2.2 dành OWNER cho credential,
thành viên, quota).

## 4. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                                                               | Cách kiểm                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| AC-1 | Catalog trả 16 domain (từ bảng) kèm tool của registry; thêm một thư mục adapter ⇒ tool hiện ra, 0 tệp ngoài (I28 dương tính)                           | test tích hợp với registry trên thư mục tạm |
| AC-2 | `configFields` phủ mọi trường của `configSchema` hai adapter thật; kiểu lạ ⇒ `json`                                                                    | test thuần                                  |
| AC-3 | validate/PUT: đủ bảy mã validator đi ra đúng mã catalog; MISSING_CAPABILITY kèm ENABLE_DOMAIN đúng tool                                                | test thuần + tích hợp                       |
| AC-4 | PUT: version cũ ⇒ 409 kèm bản hiện tại; hai PUT đua ⇒ đúng một thắng; config sai ⇒ 400 đúng trường; project không DRAFT ⇒ 409 slug                     | tích hợp                                    |
| AC-5 | PUT lưu preference; bỏ domain đang là provider được chọn ⇒ preference bị xoá cùng transaction                                                          | tích hợp                                    |
| AC-6 | Drift: NOT_DEPLOYED / CLEAN / DRIFTED / SCAN_FAILED đúng từ `last_error`                                                                               | tích hợp                                    |
| AC-7 | Portal: bật domain, chọn tool, form từ `configFields`, lỗi validator có nút hành động, 409 tải lại; VIEWER chỉ xem; wizard bước 3; trang catalog admin | test Portal với golden                      |
| AC-8 | Không thoái cấp                                                                                                                                        | lệnh cổng từng pha                          |

## 5. Nợ kiểm chứng

Không có phép đo mới cần hạ tầng. `domain-day2-route` viết lại tiền đề (cluster transport

- `pg-boss`); `portal-domain-screens` và `domains-catalog-route` được trả.

## 6. Rủi ro

| Rủi ro                                                                          | Giảm thiểu                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `import()` động của registry khác nhau giữa vitest (`.ts`) và bản build (`.js`) | test hiện có đã nạp fixture qua đúng đường này; khởi động dev chạy `tsx` |
| Khoá chữ hoa/thường: `adapterKey` giữ nguyên chữ, `providedBy` chữ thường       | mọi so khoá đi qua `registryKey` (chữ thường) ở một chỗ                  |
| Portal tự dựng câu cho bảy mã                                                   | `Record<ErrorCode…>` theo kiểu — thiếu câu là lỗi biên dịch              |

## 7. Nhật ký review

| Vòng | Phát hiện                                                                                                                                                                                                                    | Xử lý                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| v1   | Day-2 POST cần cluster + hàng đợi; trả 202 không thực thi là stub                                                                                                                                                            | ra khỏi phạm vi, tiền đề nợ viết lại (§1)                                                            |
| v1   | Body PUT chưa nói là cả tập hay phần thay đổi                                                                                                                                                                                | cả tập (QĐ-4): validator kiểm trạng thái ĐÍCH                                                        |
| v1   | §9 tách `PUT /capability-preferences`; hai endpoint cùng sửa trạng thái đích là hai cửa sổ đua với khoá `domain_set_version`                                                                                                 | gộp vào PUT (QĐ-4)                                                                                   |
| P2   | Resolver so `pref.providerToolId` (chữ thường, như `provided_by` §2.2) với `adapterKey` giữ chữ hoa của `domainType`: MỌI preference thật bị ném `OrphanPreferenceError`; fixture test dùng `domainType: "d"` nên không thấy | `adapterKey` và `keyOf` của oracle viết thường; test hồi quy với `MONITORING` + preference đọc từ DB |
| P2   | `AppError` không mang được `suggestedAction` lên Problem Details dù `buildProblem` hỗ trợ                                                                                                                                    | `withSuggestedAction`, cùng khuôn `withResource`; test qua HTTP thật                                 |
| P2   | `prometheus-grafana` đòi `registry.oci` mà registry chưa có tool nào cung cấp: bật riêng nó trả `MISSING_CAPABILITY` KHÔNG kèm gợi ý                                                                                         | đúng hành vi (QĐ-5: không gợi ý tool không tồn tại); datadog bật được riêng                          |
| P3   | Thêm trường `AppDeps` lần thứ ba phải sửa bảy chỗ dựng deps trong test                                                                                                                                                       | gom phụ thuộc "trơ" vào `tests/helpers/inert-deps.ts`                                                |

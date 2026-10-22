# Plan #44 — SPEC v1: Luồng 4 đủ route §9 — sửa variant và promote cấu hình

Nguồn: `docs/ban-giao/viec-con-lai-2026-09-28.md` mục 2 và 3; §9 (Feature Flag, Internal S2), §2.2
`FlagVariant`, §6.7, §8.4, §10.12 "Nút Promote", §16 hàng "Luồng 4 ở Service 1 chưa đủ route §9".

## 1. Phạm vi

1. `PUT /api/v1/projects/:id/flags/:flagId/variants` (S1) và `PUT /internal/flags/:id/variants` (S2):
   thay TOÀN BỘ danh sách variant của một flag.
2. `POST /api/v1/projects/:id/flags/:flagId/promote` (S1): sao chép rule của env nguồn sang env đích,
   bằng CÙNG hàm lập kế hoạch mà Portal dùng để hiện diff.
3. Portal: mục sửa variant ở chi tiết flag; hộp Promote gọi route mới.
4. Tài liệu: §9, §16 (gỡ hàng "Luồng 4 chưa đủ"), I40 (thêm `flag.variants.update`), design-lint
   `internal-routes` (gỡ `notImplemented` của PUT variants).

Không thuộc plan: đổi `flagType` (DRAFT-only, đã là quyết định của §6.7, không route nào hứa).

## 2. Quyết định

### QĐ-1: Danh tính variant giữ qua PUT — cùng khuôn `PUT …/rules`

Body `{ lastKnownUpdatedAt, variants: [{ id?, key, value }], defaultVariantKey?, confirmFlagKey? }`
(S1 bóc `confirmFlagKey` trước khi gửi S2). `defaultVariantKey` đổi variant mặc định của FLAG trong
cùng lần ghi — không route nào khác đổi được nó, và "đổi mặc định rồi xoá variant cũ" phải là một
thao tác, không phải hai lời gọi để giữa chúng flag trỏ một variant sắp bỏ. Có `id` ⇒ variant ĐANG CÓ, sửa `key`/`value` tại chỗ; không `id` ⇒ variant mới; variant
đang có mà không có trong body ⇒ bị xoá. Xoá-rồi-chèn bị loại: `serve.variantId` của rule,
`default_variant_id` của flag và env-config đều trỏ id — đổi id là làm mồ côi chúng (I39) chỉ vì
người dùng sửa một giá trị.

### QĐ-2: Luật nội dung

| Luật                                                                                                            | Mã                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ≥ 2 variant, key duy nhất, key không bắt đầu `__` (cùng `variantKey` của tạo flag), giá trị khớp `flagType`     | 400 (schema dùng chung)                                                                                                                                                                                                                                                |
| `id` không thuộc flag này, hoặc một `id` xuất hiện hai lần                                                      | 400 `ValidationError` — lỗi nội dung request, gửi lại vẫn hỏng                                                                                                                                                                                                         |
| Flag `BOOLEAN`: hai variant `on`/`off` do hệ thống sinh (§2.2) — không sửa                                      | 422                                                                                                                                                                                                                                                                    |
| Xoá variant đang được `serve` của rule nào đó tham chiếu                                                        | 409 `VARIANT_IN_USE` (trigger `UDP02` lúc COMMIT, đã có)                                                                                                                                                                                                               |
| Xoá variant đang là `default_variant_id` của env-config nào, hay của flag mà body không đổi `defaultVariantKey` | 409 `VARIANT_IN_USE` — kiểm tường minh TRONG transaction, trước lần xoá (FK `Restrict` thô sẽ là 500)                                                                                                                                                                  |
| Thứ tự ghi                                                                                                      | đổi key tạm (`__udp_tmp_<id>`, tiền tố schema cấm ở key thật) cho variant bị xoá và variant đổi key → sửa → tạo → đặt mặc định → xoá: đổi chỗ hai key hay tạo lại key vừa bỏ không đụng chỉ mục `(flag_id, key)`, và mặc định mới có trước khi FK `Restrict` được kiểm |
| Flag đang có rollout sống                                                                                       | 409 `ROLLOUT_IN_PROGRESS` + `resourceId` — nhãn `ff` mang key variant (§6.6), đổi key/giá trị giữa rollout làm phép đo mất nghĩa; cùng chốt với đổi vòng đời                                                                                                           |
| `lastKnownUpdatedAt` khác `FeatureFlag.updated_at`                                                              | 409 `OPTIMISTIC_LOCK` kèm bản hiện tại                                                                                                                                                                                                                                 |
| Không đổi gì so với hiện tại                                                                                    | 400 — cùng lý lẽ `updateFlagRefine`: một lần ghi rỗng vẫn tăng version mọi env                                                                                                                                                                                         |

### QĐ-3: Quyền theo vòng đời

Variant thuộc FLAG, dùng ở MỌI environment. Flag `DRAFT` (SDK chưa thấy): DEVELOPER. Flag `ACTIVE` hoặc
`ARCHIVED`: MAINTAINER + gõ lại key flag (428 `CONFIRMATION_REQUIRED`) — đổi giá trị một variant đang phục
vụ là đổi thứ người dùng production nhận, cùng luật "mọi thay đổi toàn cục" của `PATCH /flags/:flagId`.

### QĐ-4: Ghi ở S2 theo ADR-05, audit cùng transaction (I40)

`writeConfigChange` trên MỌI environment của project, `changeType: "flag.updated"`, `stateOf:
stateFor(key)` — snapshot đã mang variant nên replica áp bằng đúng đường của `flag.updated`, không cần
change type mới (không đụng thứ tự "replica trước, writer sau" của §16). Trong `mutate`: khoá bởi bước 1,
đọc lại flag, so mốc, kiểm rollout, kiểm mặc định, `update`/`create`/`deleteMany`, chạm
`FeatureFlag.updated_at` (mốc lock của lần sau), rồi hàng audit `flag.variants.update` với before/after
là `{ variants: [{ id, key, value }] }` (`key` trần không khớp `/.+key$/i` của `redact()` — đã đọc
`REDACTED_KEY_PATTERNS`). Route đòi `X-Udp-Actor-Id` như bốn route ghi flag.

### QĐ-5: Promote là route của S1, kế hoạch là hàm DÙNG CHUNG

`planPromotion` và `stableJson` dời từ `apps/portal/src/features/flag/promote-model.ts` sang
`@udp/shared-types/promote` (hàm thuần trên `RuleWire`). Portal hiện diff bằng hàm đó; S1 áp bằng CHÍNH
hàm đó trên dữ liệu đọc TRONG lời gọi. Hai phía cùng một hàm thì "diff đã xem" và "thứ được ghi" không
thể lệch vì hai cách hiểu.

Body `{ fromEnvId, toEnvId, sourceUpdatedAt, lastKnownUpdatedAt, confirmFlagKey? }`:

- `fromEnvId === toEnvId` ⇒ 400; env không thuộc project ⇒ 404.
- Quyền: DEVELOPER; env đích production ⇒ MAINTAINER + 428 khi thiếu/sai `confirmFlagKey` (Portal đã
  đòi gõ key cho đích production; nay server cưỡng chế, không còn là chốt chỉ ở trình duyệt).
- `sourceUpdatedAt` khác `FlagEnvConfig.updated_at` của NGUỒN ⇒ 409 `OPTIMISTIC_LOCK` (người dùng đã xem
  diff của một bộ rule nguồn khác); mốc của ĐÍCH đi vào body `PUT …/rules` của S2 như mọi lần thay rule.
- Kế hoạch 0 thay đổi ⇒ 200, không gọi S2 (không tăng version).
- Response `{ rules, updatedAt, diff, changes }`: rule của env ĐÍCH sau khi áp (cùng hình `GET …/rules`)
  và diff đã áp.

Không có chế độ `dryRun`: Portal đã có dữ liệu hai phía và cùng hàm; một chế độ chỉ-đọc trên một POST là
hai hợp đồng trên một route.

## 3. Tiêu chí chấp nhận

- **AC-1** S2: PUT variants sửa tại chỗ (id giữ, rule trỏ nó vẫn hợp lệ), thêm, xoá variant không ai dùng;
  `config_version` +1 mọi env, snapshot mang giá trị mới, `config_hash` khớp snapshot đọc thẳng; một hàng
  audit `flag.variants.update` có người làm.
- **AC-2** S2: 409 `VARIANT_IN_USE` khi xoá variant rule đang serve và khi xoá mặc định (flag lẫn
  env-config); 422 BOOLEAN; 409 rollout sống; 409 mốc cũ kèm `current`; 400 thiếu người làm; không hàng
  audit nào ở mọi ca từ chối.
- **AC-3** S1: DRAFT ⇒ DEVELOPER được; ACTIVE ⇒ DEVELOPER 403, MAINTAINER thiếu key 428, đủ ⇒ 200 `{flag}`;
  lỗi của S2 chuyển nguyên mã.
- **AC-4** S1 promote: rule khớp giữ `id` ĐÍCH (salt giữ, I1), rule mới có salt mới, rule thừa ở đích bị
  bỏ; nguồn đổi ⇒ 409; đích production thiếu key ⇒ 428; cùng env ⇒ 400; 0 thay đổi ⇒ không version mới.
- **AC-5** Portal: sửa variant (flag không-BOOLEAN) có xác nhận khi flag ACTIVE; hộp Promote gọi route mới
  và hiện lại diff khi 409; golden cho hai route mới; I38 xanh.
- **AC-6** Không thoái cấp: typecheck, lint, prettier (tệp đổi), test S1/S2/Portal/shared-types/design-lint
  theo lô; `internal-routes` không còn `notImplemented` cho S2.

## 4. Phát hiện khi làm

- **Xoá variant rule đang serve ra 500, không phải 409.** Trigger `UDP02` chỉ chạy lúc COMMIT, còn
  `stateOf` của `writeConfigChange` dựng snapshot ngay sau `mutate` và `variantKeyOf` ném lỗi thường khi
  rule trỏ variant không còn. Sửa: kiểm tường minh bằng đúng biểu thức của trigger trước lần xoá
  (`assertNotInUse`); trigger giữ vai hàng rào ở database cho writer khác.
- **Hai nút vòng đời của Portal luôn nhận 428.** `LifecycleActions` không gửi `confirmFlagKey` trong khi S1
  đòi nó cho mọi đổi vòng đời từ Plan #19; không test nào bấm hai nút đó. Sửa: hộp xác nhận đòi gõ key và
  gửi nó; thêm test.
- **Lượt đầy đủ của Portal đỏ 2 ô trên máy đo ngay ở `ab13620`** (ô đầu của `promote`, `domain` — vượt
  hạn chờ 5 giây khi 17 tệp jsdom chạy song song với ~0,7 GiB RAM trống; chạy riêng xanh). Không phải thoái
  cấp: cổng Portal trên máy này chạy hai lô, như S1/S2 (bàn giao §4).

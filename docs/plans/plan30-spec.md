# Plan #30 — Áp cấu hình domain cho project đã triển khai và hai route Day-2 — SPEC

Trạng thái: **v1, 25/09/2026**. Nguồn: §8.2 (năm CASE, rebind trước teardown), §8.6 (nâng
cấp, quét drift), §5.3 (đồ thị capability), §9 (`PUT /domains`, `POST …/upgrade`,
`POST …/drift`); sổ nợ `domain-day2-route`; slug `domains-need-apply-job` (Plan #27).

## 1. Mục tiêu

1. **`PUT /projects/:id/domains` cho project ACTIVE:** kiểm trạng thái ĐÍCH như hôm nay;
   hợp lệ ⇒ tăng `domain_set_version`, ghi job `DOMAIN_APPLY` (payload = trạng thái đích)
   trong CÙNG transaction, trả **202 `{ job }`**. Không còn 409 `domains-need-apply-job`
   cho project ACTIVE.
2. **Worker `DOMAIN_APPLY`** trên hàng `udp-jobs`, lease/fence của Plan #28: so hiện tại
   (bảng) với đích (payload), ra năm loại thay đổi của §8.2 và thi hành đúng thứ tự:
   - CASE 1 bật: `deploy` theo bậc của đồ thị ĐÍCH, binding xuống bảng.
   - CASE 3 đổi tool: deploy mới → `healthcheck` → rebind binding → `onDependencyChanged`
     cho mọi consumer theo bậc (`notifyDependents`) → CHỈ SAU ĐÓ teardown tool cũ
     (`"switch"`); healthcheck hỏng ⇒ teardown cái mới, GIỮ tool cũ, domain ERROR.
   - CASE 4 đổi cấu hình cùng tool: `configure`.
   - CASE 5 đổi preference: rebind + `onDependencyChanged`, không deploy/teardown.
   - CASE 2 tắt: teardown (`"disable"`) ngược bậc của đồ thị HIỆN TẠI — validator đã bảo
     đảm đích không còn ai cần nó.
     Mọi ghi cấu hình qua `applyDomainChange` (dọn preference mồ côi, binding cùng
     transaction).
3. **`POST /projects/:id/domains/:type/drift`** (MAINTAINER): quét NGAY một domain, đồng bộ
   (chỉ đọc, `scanDomainDrift`), trả phán quyết.
4. **`POST /projects/:id/domains/:type/upgrade`** (MAINTAINER; environment production ⇒ 428
   nếu thiếu xác nhận): job `DOMAIN_APPLY` loại nâng cấp chạy `upgradeDomain` (validator
   trước, rollout đang chạy ⇒ 409, `adapter_version` đổi cùng rebind).
5. **Portal:** lưu domain của project ACTIVE ⇒ hiện tiến độ job (dùng lại `JobLog`); nút
   "Quét ngay" và "Nâng cấp" ở trang chi tiết domain.

## 2. Quyết định

- **QĐ-1: Trạng thái đích nằm trong payload của job**, không trong bảng: bảng là trạng thái
  ĐANG CHẠY trên cluster; ghi đích vào bảng trước khi áp là để Portal và drift nói về thứ
  chưa tồn tại. Worker cập nhật bảng theo từng thay đổi ĐÃ áp.
- **QĐ-2: Trạng thái job:** `QUEUED → DOMAINS → DONE | FAILED`. Một domain lỗi ⇒ domain đó
  ERROR, domain phụ thuộc BLOCKED, các domain khác vẫn áp; job FAILED với danh sách lỗi.
  Không bù trừ cloud: DOMAIN_APPLY không tạo tài nguyên cloud.
- **QĐ-3: Nâng cấp khi registry chỉ có một version:** hạ về bản cũ cần instance adapter bản
  cũ (nợ `upgrade-rollback-that`). Cổng `rollback` báo thất bại có lý do ⇒
  `ROLLBACK_FAILED` — kêu to, không giả vờ đã hạ.
- **QĐ-4: Quét drift ngay là đồng bộ:** chỉ đọc, một domain, không cần hàng đợi; dùng CÙNG
  `scanDomainDrift` với lịch 6 giờ.

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| AC-1 | PUT trên ACTIVE ⇒ 202 job; `domain_set_version` tăng; khoá cũ ⇒ 409 optimistic lock; không hợp lệ ⇒ 422       |
| AC-2 | Bật domain mới: deploy theo bậc, binding trong bảng, domain ACTIVE                                            |
| AC-3 | Đổi tool: thứ tự deploy → healthcheck → rebind → onDependencyChanged → teardown cũ; healthcheck hỏng ⇒ giữ cũ |
| AC-4 | Tắt domain: teardown `"disable"`, `is_enabled = false`, preference mồ côi xoá cùng transaction                |
| AC-5 | Quét ngay: phán quyết đúng, chỉ `last_error` đổi                                                              |
| AC-6 | Nâng cấp: rollout đang chạy ⇒ 409; bản đã mới nhất ⇒ 409; thành công ⇒ `adapter_version` mới                  |
| AC-7 | Không thoái cấp                                                                                               |

## 4. Nợ kiểm chứng

Trả `domain-day2-route`. Giữ `upgrade-rollback-that`, `helm-real`, `I32-cluster`.

## 5. Nhật ký review

| Vòng | Phát hiện                                                                                              | Xử lý                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| P2   | `rebindProvider` đổi mọi binding cùng capability của project — ghi đè provider thứ hai (§5.3 cho phép) | Lọc theo `domain_config_id`; ô âm trong `capability-persist.test.ts` |
| P2   | `upgradeDomain` gọi `upgrade`/`healthcheck` một lần — adapter theo namespace chỉ nâng một env          | `perEnvironment` bọc cả hai hook                                     |
| P3   | Hai hình response cho `PUT /domains` (200 view, 202 job) phá quy tắc một route một schema của golden   | Một hình, thêm `job`                                                 |
| P4   | Trình sửa domain dựng lại theo `domain_set_version` ⇒ mất tiến độ job ngay khi lưu                     | Job giữ ở `DomainPanel`, ngoài `key`                                 |
| P4   | Chi tiết domain tải catalog cả khi không có nút nào (VIEWER)                                           | Chỉ tải khi thao tác được hiện                                       |

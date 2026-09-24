# Bàn giao trạng thái — UDP, phiên 25/09/2026

Tiếp nối `trang-thai-2026-09-24.md`. Tệp này nói: Plan #25 (Portal) đã tới đâu, bằng
chứng là gì, và cái gì **chưa** được kiểm lại trong phiên này.

## 1. Đã làm, có bằng chứng

Commit (mới nhất trước, tất cả **local**, chưa push):

```
78332b8  P25 P1-P8: Portal SPA on the wire contract
1f6b8cb  P25 P0: wire schemas, sendJson in all Portal controllers, myRole, golden capture
```

cộng một commit tài liệu (§10.15 `[v4.11]` và hai tệp bàn giao này).

### P0 — hợp đồng dây (đóng)

- `@udp/shared-types/wire`: schema `.strict()` cho **mọi** phong bì response Portal gọi
  (40 route). Controller auth/project/member/environment/flag/segment/rollout gửi qua
  `sendJson`.
- `myRole` do server tính theo bốn đường vào (middleware; `OWNER` tường minh ở
  `POST /projects`; hàng thành viên trong cùng truy vấn ở `GET /projects`, **ném** khi
  thiếu, không `?? "VIEWER"`). `PublicProject` giữ nguyên (tầng view ở `project.view.ts`).
- Golden capture: `UDP_CAPTURE_WIRE=1` ghi response 2xx thật vào
  `services/core-backend/tests/fixtures/wire/` (40 tệp, `secretKey`/`csrfToken` thay bằng
  giá trị giả cùng dạng). Cổng `wire-golden.test.ts` **48/48**. Cổng này lộ ra 8 route
  chưa từng được test nào đi qua đường 2xx (`GET /projects/:id`, `GET /auth/me`…) —
  `wire-routes.integration.test.ts` (6/6) phủ chúng và khẳng định `myRole` từng đường.

| Bộ test core-backend (chạy từng tệp, sau thay đổi)              | Kết quả                     |
| --------------------------------------------------------------- | --------------------------- |
| auth / project / project-resources / flag / rollout integration | 16 / 23 / 70 / 29 / 19 xanh |
| 15 tệp còn lại (trừ `grid-tier2`)                               | xanh                        |
| `wire-golden` + `wire-routes`                                   | 48 + 6 xanh                 |

### P1–P8 — Portal (`apps/portal`)

| Cổng                                                   | Kết quả                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `pnpm --filter @udp/portal test`                       | **61/61** (http 12, rules-model 11, I38 11, design-lint 8, app 12, rollout 7) |
| `vite build`                                           | xanh, JS 137 KB gzip                                                          |
| `tsc` toàn workspace                                   | 0 lỗi                                                                         |
| `eslint .` (nay phủ `.tsx`)                            | 0 lỗi                                                                         |
| `@udp/shared-types` / `@udp/http` / `@udp/design-lint` | 103 / 47 / 124 xanh                                                           |

Màn hình: đăng nhập/đăng ký, danh sách + tạo project (bước 1), Tổng quan, Flag (danh
sách nhóm, phím tắt j/k/c/Ctrl S, xem nhanh, bật/tắt theo env có xác nhận gõ key ở
production và Hoàn tác ở env khác, trình sửa rule giữ `id`, tester, thống kê, snippet),
Dọn dẹp flag, Segment, Rollout (tạo FLAG_LEVEL có `canaryPairOf` + probe, chi tiết có
polling theo trạng thái, intent, "vì sao đang đứng yên", biểu đồ), Cài đặt (SDK key hiện
một lần, thành viên + ma trận quyền, nhật ký diff, quota/TTL/xoá).

**QĐ-2 (font) đã đo:** `cmap` của Geist 400/600 và Geist Mono 400 phủ đủ 102 ký tự tiếng
Việt, thiếu 0 ⇒ giữ Geist.

### P9 — sửa thiết kế

`docs/UDP_design.md` §10.15: bảng D-P1..D-P14 (mỗi chỗ lệch §10 kèm lý do).

## 2. CHƯA kiểm lại trong phiên này — nói thẳng

1. **`grid-tier2.test.ts`**: lượt đầu hết giờ 420s, lượt chạy riêng bị hệ thống dừng vì
   máy thiếu RAM (còn ~1,4/7,7 GiB, một dự án khác đang chạy vitest song song). Tệp này
   không chạm mã đã sửa (provisioning, không controller), nhưng **chưa có bằng chứng xanh
   sau thay đổi**. Chạy lại khi máy rảnh: `pnpm --filter @udp/core-backend exec vitest run
tests/grid-tier2.test.ts`.
2. **`pnpm test:scratch`** (đúng lệnh CI) chưa chạy trong phiên này.
3. **`pnpm format:check` đỏ ở HEAD từ trước**: ~37 tệp (vd. `tests/helpers/tier2.ts`,
   `capability.resolver.ts`) lệch Prettier 3.9.6 ngay ở commit `e256ed1`. Không tệp nào
   phiên này chạm nằm trong danh sách đó; không định dạng lại hộ vì ngoài phạm vi.
4. **P9 phần đo:** ngân sách hiệu năng Portal chưa đo. Đợt đột biến thì ĐÃ chạy: 6/6 đỏ
   (bỏ `envId` khỏi key flags → I38 đỏ; bỏ `id` rule khi PUT → rules-model đỏ; bỏ Web
   Locks → http đỏ; bỏ single-flight → http đỏ; bỏ xác nhận production → app đỏ; polling
   không dừng khi kết thúc → rollout đỏ). Mã khôi phục nguyên sau mỗi đột biến.

## 3. Bẫy mới tìm ra

| Bẫy                                                  | Sự thật                                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Prettier trên thư mục có tệp chưa định dạng từ trước | Chạy `--write` theo glob rộng sửa luôn tệp người khác; chỉ đưa đúng tệp mình chạm                                                |
| `fetch` của Node trong jsdom                         | Không nhận URL tương đối ⇒ `lib/http.ts` dựng URL tuyệt đối theo `window.location.origin`                                        |
| `navigator.locks.request`                            | Kiểu DOM trả `Promise<Promise<T>>`; lúc chạy đã phẳng                                                                            |
| Cổng ranh giới package                               | Từng đọc `from "@udp/…"` trong CHUỖI là một import; nay chỉ đọc câu lệnh `import/export` đầu dòng (549/549 import thật vẫn khớp) |
| Python sửa tệp                                       | `"\b"` trong chuỗi Python thường là ký tự backspace — dùng raw string                                                            |

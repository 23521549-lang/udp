# Bàn giao - UDP, 22/10/2026

Tài liệu này đọc được mà không cần phiên làm việc nào. Nó thay `trang-thai-2026-10-21.md` ở vai "điểm bắt đầu cho
người tiếp theo"; tệp đó giữ nguyên phần Plan #64 và #65 (lượt CI đỏ, bằng chứng, các sửa trong lúc chờ CI). Nguồn sự
thật của thiết kế là `docs/UDP_design.md`; của phép đo là `docs/measurements/` (nợ trong `kiem-chung-con-no.md`); của
từng plan là `docs/plans/`.

**Trạng thái một câu:** Plan #66 (nhánh `p66-cong-noi-bo`, PR #3) đưa `/internal/*` của Service 1 và Service 2 sang
cổng nội bộ riêng, có NetworkPolicy theo cổng - lớp mạng của T12. **Lượt `39642205055` (`dcdf9cf`) xanh cả 8 job**
(`build-smoke` bỏ qua đúng thiết kế), **PR #3 đã gộp vào `p61-dong-goi` (`44f506b`)**. PR #1 (`p61-dong-goi` →
`main`) giờ mang Plan #16-#66; việc còn lại cần chủ repo: gộp PR #1 vào `main` (mục 4). **53 mục nợ kiểm chứng**, Plan
#66 không thêm mục nào.

Quyền của phiên: được push các nhánh và gộp PR giữa các nhánh không phải `main`; **không** merge vào `main`.

---

## 1. Nhánh và PR

| Nhánh             | Đỉnh      | Vai                                                        |
| ----------------- | --------- | ---------------------------------------------------------- |
| `main` (remote)   | `46a1049` | Plan #15 (12/09) - lượt đêm vẫn chạy trên đây              |
| `p61-dong-goi`    | `44f506b` | Plan #16-#66, PR #1 vào `main` - chờ chủ repo gộp          |
| `p66-cong-noi-bo` | `dcdf9cf` | Plan #66, PR #3 - ĐÃ GỘP vào `p61-dong-goi`                |
| `p64-sua-loi-ci`  | `1af8e4a` | Plan #64 và #65, PR #2 - ĐÃ GỘP vào `p61-dong-goi` (21/10) |

## 2. Plan #66 - cổng nội bộ riêng (spec, plan: `docs/plans/plan66-*.md`)

| Commit    | Nội dung                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `d530285` | `internalPortOnly`, `listenInternal`, `closeServer`; hai biến cổng nội bộ; listener thứ hai ở Service 1, 2 |
| `b7ac5cd` | Service `internal-*`, policy theo cổng, cổng manifest dựng bên gọi từ mã; phép thử trên kind và k3s        |
| `dcdf9cf` | Thiết kế: T12 có lớp mạng, D-P58, §9, §16; plan ghi ba vòng QA                                             |

Những gì giờ đúng:

- `/internal/*` tới qua cổng công khai trả đúng 404 của route không tồn tại; chốt đọc `req.socket.localPort`, đứng
  ngay sau `helmet` (trước parser body). Vòng QA C thử keep-alive, pipelining, IPv6 và 17 biến thể đường dẫn.
- `CORE_BACKEND_INTERNAL_PORT`, `FLAG_SERVICE_INTERNAL_PORT` bắt buộc ở production, không được trùng cổng công khai ở
  mọi môi trường; dev và test để rỗng thì chạy như cũ (một cổng).
- NetworkPolicy: cổng nội bộ của Service 1 chỉ mở cho Service 3; của Service 2 cho Service 1 và Service 3. Luật 1 mở
  cổng công khai cho mọi nguồn. Bên gọi trong cổng manifest dựng từ chỗ dùng `env.*_URL` trong `src`, không gõ tay.
- Lỗi có từ trước, sửa kèm: `server.close()` của Node 22 không đóng kết nối keep-alive đang bận (đo được 392 request
  lọt sau `close()`, 12 giây chưa đóng) - tắt êm kẹt tới khi bị giết. `closeServer` đặt `connection: close`; test đỏ
  rồi xanh.
- E2E kind và k3s (`deploy/e2e/netpol-probe.ts`): Service 3 thật tới cổng nội bộ của cả hai service; route nội bộ có
  thật trả 401 qua cổng nội bộ, 404 qua cổng công khai; nhãn lạ và namespace khác bị chặn; cổng công khai vẫn mở.

## 3. Chưa chứng minh được

1. **Supabase dev vẫn không truy cập được** (`tenant/user ... not found`, 21-22/10). Bằng chứng ĐỎ của cổng
   `catalog-seeded` trên mã cũ cần `pnpm db:verify-chain` sau khi khôi phục project (chi tiết: bàn giao 21/10, mục
   4.1). Mọi test chạm database của Plan #66 chạy trên CI.
2. **`TokenReview` chưa làm.** `/internal/*` giờ có lớp mạng và bí mật dùng chung; một pod của chính bên gọi bị
   chiếm vẫn gọi được. Giới hạn §16, T12.

## 4. Việc tiếp

1. **Chủ repo gộp PR #1 vào `main`** (mô tả đã cập nhật tới Plan #66). Rồi pha 2 của `ci-github-green`: lượt `push`
   của `main` chạy `build-smoke`; chạy tay `toolchain.yml` và `publish-rehearsal.yml` (`gh workflow run <tệp>`).
2. Khôi phục project Supabase dev rồi chạy `pnpm db:verify-chain`.
3. Nâng Node trên máy dev lên `>=22.22.2`.
4. `sdk-publish-real` (cần tài khoản npm, PyPI của chủ repo), và E5 (bằng chứng của C1, cần cụm có Prometheus).
5. Việc kỹ thuật kế tiếp: Plan #67 - `TokenReview` cho `/internal/*` (RBAC `system:auth-delegator`, token
   ServiceAccount projected có audience, chế độ không cụm cho dev và test).

## 5. Máy này

7,71 GiB RAM. Node 22.20.0 (repo đòi `>=22.22.2`). ESLint toàn repo hết bộ nhớ: lint theo tệp đã đổi.

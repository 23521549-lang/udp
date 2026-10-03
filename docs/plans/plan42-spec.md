# Plan #42 — Báo cáo E1, E8 và bàn giao cuối — SPEC

Trạng thái: **v1, 27/09/2026**. Nguồn: §14.1 E1 (effort mở rộng adapter: số file sửa NGOÀI thư
mục adapter, số lần phá vỡ interface, số lần nới lỏng contract test — git tag
`adapter-interface-v1`), E8 (differential test validator ↔ oracle độc lập + mutation testing; mã
kết quả oracle sinh được 7/7), §13.3 I28. Tiền đề: Plan #14 (oracle, `oracle-independence`),
Plan #18 (tag `adapter-interface-v1`), `docs/E1-relaxations.json`.

## 1. Mục tiêu

1. **E1 có số đọc được, lấy từ lịch sử git**, không từ trí nhớ: mọi tool có adapter được thêm sau
   tag, file nào ngoài thư mục của nó đổi trong commit thêm nó, phân loại vì sao.
2. **E8 có số mutant bị giết**, không chỉ "differential test xanh".
3. **Bàn giao cuối**: một tài liệu trạng thái đọc được mà không cần phiên làm việc — đã làm gì, bất
   biến nào được cưỡng chế ở đâu, còn nợ gì (sổ nợ), chạy các cổng thế nào trên máy ít RAM.

## 2. Quyết định

- **QĐ-1 — E1 là script trên git** (`pnpm --filter @udp/experiments e1`): bề mặt interface ở tag
  so với HEAD (tên phương thức và thuộc tính của `CloudAdapter`, `DomainAdapter`,
  `CicdDomainAdapter`) ⇒ số lần phá vỡ; `E1-relaxations.json` ⇒ số lần nới lỏng; với mỗi thư mục tool
  `src/modules/<domain>-adapter/<tool>/` xuất hiện sau tag: commit thêm nó, và file đổi NGOÀI thư
  mục đó trong commit ấy, chia nhóm — lớp nền dùng chung (`adapter-base/`), lõi adapter
  (`packages/adapter-core/`), danh mục/cấu hình, test, tài liệu, mã sản phẩm khác. Số thô vào
  `raw/E1-*.json`.
- **QĐ-2 — Đọc E1 trung thực**: tool được thêm theo lô, cùng commit với phần mở rộng lớp nền của
  lô đó; "0 file ngoài thư mục adapter" chỉ đúng cho tool thêm khi lớp nền đã đủ. Báo cả hai con
  số: file ngoài thư mục tool, và file ngoài MỌI thư mục adapter + lớp nền (thứ một tác giả adapter
  bên ngoài thật sự phải chạm).
- **QĐ-3 — E8 mutation là script** (`pnpm --filter @udp/core-backend e8`): danh sách mutant viết
  tay trên validator (`capability.resolver.ts`) — đảo điều kiện, bỏ một nhánh lỗi, lệch biên
  semver, bỏ kiểm exclusive/conflict/preference — mỗi mutant áp lên tệp, chạy bộ differential +
  bộ mã oracle, ghi bị giết hay sống, LUÔN khôi phục tệp (kể cả khi bị ngắt). Số thô vào
  `raw/E8-*.json`: mutant bị giết / tổng, và mã kết quả oracle sinh được (7/7).
- **QĐ-4 — Bàn giao cuối** `docs/ban-giao/trang-thai-2026-09-27.md`: tổng kết Plan #1–#42 theo
  nhóm, bảng bất biến → nơi cưỡng chế, sổ nợ 40 mục theo nhóm hạ tầng cần có, cách chạy cổng theo lô.

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------- |
| AC-1 | `e1` chạy lại cho cùng số trên cùng commit; mọi tool thêm sau tag có một hàng; phân nhóm cộng đủ số file        |
| AC-2 | `e8`: tệp validator sau khi chạy GIỐNG hệt trước (kể cả mutant làm test treo); số mutant bị giết ghi vào `raw/` |
| AC-3 | README đo có hàng E1, E8; §14 trỏ tới số; không có con số nào không truy về một tệp `raw/`                      |
| AC-4 | Tài liệu bàn giao cuối đủ bốn phần của QĐ-4; mọi mã nợ nhắc tới có trong sổ nợ (design-lint)                    |
| AC-5 | Không thoái cấp: experiments, S1 (phần chạm), design-lint                                                       |

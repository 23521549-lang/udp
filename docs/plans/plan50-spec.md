# Plan #50 — SPEC v1: CI/CD của UDP theo §13.5, chi phí 0

Nguồn: `docs/ban-giao/viec-con-lai-2026-09-28.md` (việc #50; yêu cầu cứng: chi phí hạ tầng ĐÚNG 0); §13.3
I28, §13.5 (sơ đồ CI), §14.1 E2 và E9, Plan #49 AC-3 (dựng cụm thật được kiểm ở CI).

## 1. Phạm vi

| Thiết kế hứa (§13.5, §13.3)                                                | Hôm nay                                                               | Plan này                                                                                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| I28: job CI đọc `git diff --name-only` của commit thêm adapter, fail build | Chỉ có nửa dương tính (adapter giả `noop-logger` trong test tích hợp) | Cổng `@udp/design-lint` `i28` + job `i28` trên push/PR                                                                        |
| PR → build image                                                           | Dockerfile có (Plan #49) nhưng chưa build ở đâu                       | Job `kind` build đủ 6 image trong runner                                                                                      |
| → dựng kind cluster                                                        | `pnpm deploy:up` chưa từng chạy (máy dev không đủ RAM cho Docker)     | Job `kind` chạy ĐÚNG `pnpm deploy:up` mà developer chạy                                                                       |
| → E2E rút gọn                                                              | Không có                                                              | `deploy/e2e`: Portal, đăng nhập qua proxy, tạo khoá CLIENT, `/sdk/config`, OFREP, lan truyền bật/tắt flag qua SSE, Prometheus |
| Hằng đêm → benchmark                                                       | Lượt `schedule` chỉ chạy lại bộ test                                  | Lượt đêm chạy cả job `kind` và đo **E9** (rỗi + 1 000 SSE), kết quả thành artifact                                            |
| → adapter contract test trên kind; E2E với LocalStack                      | Contract test chạy in-process ở job `test`                            | **Không làm** — cần `ClusterAccess` thật và LocalStack: đã có mục trong sổ nợ (`I32-cluster`, `I31-localstack`, …)            |
| Trước bảo vệ → cloud thật                                                  | —                                                                     | **Không làm** — tính tiền (D-P37); **E2** vào sổ nợ                                                                           |

## 2. Quyết định

### QĐ-1: Cổng I28 là mã thuần + một lớp git mỏng, và áp từ commit đưa nó vào

`@udp/design-lint/adapter-commit` giữ ĐỊNH NGHĨA DUY NHẤT của "thư mục tool" (`modules/<x>-adapter/<tool>/`
có `index.ts`); E1 (`@udp/experiments`) dùng lại chính nó — phép đo và cổng cưỡng chế cùng một chỉ số không
được hiểu "thư mục adapter" theo hai cách. Luật đúng chữ §13.3: commit THÊM ít nhất một `index.ts` của tool
mới ⇒ MỌI đường dẫn đổi (cả hai phía của rename) phải nằm trong một thư mục tool mới của chính commit đó —
kể cả tài liệu và test (contract test của adapter nằm trong thư mục của nó, §5.3 D-7). Commit merge bỏ qua:
nội dung của nó đã được kiểm ở các commit nó gộp.

Khoảng kiểm: PR = `base..head`; push = `before..after`; `before` không giải được (nhánh mới, force-push) ⇒
chỉ kiểm commit đầu, kèm cảnh báo. **Điểm bắt đầu:** commit mà cây của nó CHƯA có module cổng là commit
"trước cổng" — được liệt kê, không bị chặn. 11 commit thêm adapter theo lô trước Plan #50 sửa cả lớp nền
trong cùng commit; số của chúng là việc của E1 (đo từ git, báo tệp ngoài adapter theo lô), không phải của
một cổng viết sau. Không băm cứng SHA nào: tiêu chí đọc được từ chính cây.

### QĐ-2: Job `kind` chạy đúng lệnh của developer

`helm/kind-action` chỉ để cài `kind` (`install_only`); dựng cụm, build, `kind load`, Secret, migrate, chờ
sẵn sàng đều là `pnpm deploy:up` — CI kiểm đúng đường mà README hứa, không một kịch bản thứ hai. Thất bại ⇒
một bước chẩn đoán in pod, sự kiện, `describe` và log (Secret sinh ngay trong runner cho lượt đó, huỷ cùng
runner — không bí mật thật nào tồn tại để lộ).

### QĐ-3: E2E rút gọn là một bộ vitest riêng của `@udp/deploy`

`deploy/e2e/*.e2e.test.ts`, cấu hình riêng (`pnpm --filter @udp/deploy e2e`), không nằm trong `test` — nó cần
một cụm đang chạy. Tài khoản, mật khẩu và SERVER key của seed chuyển vào `@udp/db/seed-constants` (seed dùng
lại), để E2E, E9 và seed không giữ ba bản chép. Bảy kiểm tra, mỗi cái là một đường mà cụm chạy lỗi mới lộ:
Portal phục vụ SPA; đăng nhập QUA proxy nginx (cookie + CSRF); tạo khoá CLIENT bằng API thật; SERVER key đọc
`/sdk/config`; khoá CLIENT đánh giá OFREP; tắt flag ở Portal ⇒ stream SSE của SDK nhận thay đổi trong hạn
(Luồng 4 xuyên ba tầng: S1 → S2 → SDK, NOTIFY bật trong cụm) và khôi phục; Prometheus trong cụm scrape được
sample-app với nhãn `namespace` đúng env dev của seed.

### QĐ-4: E9 đọc Summary API của kubelet

`GET /api/v1/nodes/<node>/proxy/stats/summary` qua `kubectl get --raw` — đúng nguồn mà metrics-server đọc,
nên không thêm thành phần nào vào cụm. CPU = Δ`usageCoreNanoSeconds` / Δ thời gian (trung bình cả pha từ
hai đầu, và cực đại theo khoảng); RAM = `workingSetBytes` (số `kubectl top` hiện và số OOM-killer xét). Hai
pha: **rỗi** và **1 000 SDK nối SSE** bằng SERVER key seed (trần `streamOpensPerKey` 1 000/phút và
`maxStreamsPerKey` 1 000 đặt đúng cho E9; 429 ⇒ chờ `Retry-After` rồi mở lại). Không đủ 1 000 stream ⇒ thoát
mã 1: một phép đo thiếu tải không được ghi như số của E9. Chi phí bộ nhớ mỗi stream = chênh `workingSet`
của Service 2 giữa hai pha chia số stream.

Nhánh **100 rollout đồng thời** KHÔNG đo được ở chi phí 0 mà không phá bất biến: trần
`MAX_TRACKED_FLAGS_PER_ENV = 3` (§6.6) buộc ≥ 34 environment, mỗi cái một workload có lưu lượng để qua probe
pha 1 — hơn 34 pod ứng dụng mẫu cộng tải trên runner 7 GiB. Ghi vào mục `E9` của sổ nợ cùng tiền đề.

### QĐ-5: Làn chạy và chi phí

| Job          | push/PR | đêm/thủ công | Ghi chú                                                     |
| ------------ | ------- | ------------ | ----------------------------------------------------------- |
| `i28`        | ✔       | —            | Cần khoảng commit; `fetch-depth: 0`                         |
| `kind` + E2E | ✔       | ✔            | §13.5 "PR → build image → kind → E2E rút gọn"               |
| E9           | —       | ✔            | §13.5 "hằng đêm → benchmark"; artifact `E9-*.json`, 30 ngày |

Chi phí 0 do cấu trúc: runner GitHub (miễn phí cho repo public; repo private trong hạn mức miễn phí, và hạn
mức chi tiêu mặc định $0 làm job DỪNG chứ không tính tiền); image không đẩy lên registry; không cloud.

### QĐ-6: Sổ nợ thêm E2 và E9 (39 → 41)

E2 cần ba cloud thật — trái yêu cầu chi phí 0. E9 có harness và chạy mỗi đêm nhưng chỉ XONG khi artifact
của một lượt được commit vào `raw/` (luật của sổ), cộng nhánh 100 rollout ở trên.

## 3. Tiêu chí chấp nhận

- **AC-1** Cổng I28: test thuần (phân loại, rename, merge) + test tích hợp trên repo git tạm (commit chỉ
  thêm adapter qua; thêm adapter + một tệp ngoài đỏ; sửa adapter có sẵn cùng tệp khác qua; commit trước cổng
  được miễn). Chạy cổng trên `origin/main..HEAD` của repo này: không vi phạm.
- **AC-2** E1 dùng định nghĩa thư mục tool của cổng; test E1 xanh, số E1 không đổi.
- **AC-3** Phần thuần của E9 (đọc summary, tốc độ CPU, gộp theo pha) có test trên một summary đúng hình dạng
  kubelet.
- **AC-4** `ci.yml` parse được; job `kind` chạy `pnpm deploy:up` rồi E2E; E9 chỉ ở làn đêm/thủ công; artifact
  trỏ đúng thư mục `raw/` — một test của `@udp/deploy` giữ ba điều đó.
- **AC-5** Sổ nợ 41 mục, `design-lint` xanh; §13.5, §14.1 (E9), §16, D-P38 cập nhật.
- **AC-6** Không thoái cấp: typecheck, lint, format, test của các package chạm tới xanh.
- **AC-7** Dựng cụm, E2E và E9 chạy THẬT ở lượt CI đầu tiên sau khi người dùng push (máy dev không có
  Docker) — ghi ở bàn giao.

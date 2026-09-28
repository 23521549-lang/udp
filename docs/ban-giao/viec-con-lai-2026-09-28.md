# Việc còn lại theo thiết kế — rà soát 28/09/2026

Đối chiếu `docs/UDP_design.md` với mã ở `ab13620`. Không tính: 39 mục nợ cần hạ tầng hoặc người thật
(`docs/measurements/kiem-chung-con-no.md`), giới hạn đã chấp nhận ở §16 và hướng tương lai §17, sai
lệch có chủ đích D-P1…D-P32 (§10.15). Mỗi dòng dưới đây là một thứ thiết kế hứa mà mã chưa có, và
chỉ cần viết mã (hoặc hạ tầng chi phí 0) để làm.

## 1. Danh sách

| #   | Việc                                                                                                                                                                                                          | Thiết kế                                             | Hiện trạng                                                                      | Plan     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- | -------- |
| 1   | Định dạng: `pnpm format:check` của CI                                                                                                                                                                         | §13.5                                                | Khoảng 37 tệp lệch prettier — cổng `check` của CI đỏ                            | #43      |
| 2   | `PUT /projects/:id/flags/:flagId/variants` (S1) + `PUT /internal/flags/:id/variants` (S2) + sửa variant trên Portal                                                                                           | §9 (Feature Flag, Internal S2), §16 "Luồng 4…"       | Chưa có; design-lint khai `notImplemented`                                      | #44      |
| 3   | `POST /projects/:id/flags/:flagId/promote` — sao chép cấu hình env này sang env kia                                                                                                                           | §9, §10.12                                           | Portal tự làm bằng `PUT …/rules` phía trình duyệt; không route                  | #44      |
| 4   | `POST /projects/:id/domains/:type/retry` + nút "Thử lại" (ERROR) và "Áp lại cấu hình mong muốn" (đã trôi)                                                                                                     | §9 Domain, §10.13 "Drift badge"                      | Chưa có                                                                         | #45      |
| 5   | `GET /projects/:id/domains/:type/versions` + hộp nâng cấp chọn phiên bản đích, kèm kết quả chạy lại validator                                                                                                 | §9 Day-2, §8.6, §10.13 "Upgrade dialog"              | Portal chỉ nâng lên bản mới nhất của catalog                                    | #45      |
| 6   | `GET /projects/:id/deployments/latest`, `GET …/deployments/:deploymentId/logs`; thẻ "Deploy gần nhất" và "Cluster" ở Tổng quan                                                                                | §9 Deployments, §10.6                                | Chưa có; chú thích ở `OverviewPage.tsx` đã cũ                                   | #45      |
| 7   | Luồng 5 đầy đủ: `ATTRIBUTE_SPLIT`, `BLUE_GREEN`, `SERVICE_LEVEL` (udp-driven qua Argo Rollouts/Flagger, tool-driven soi gương), `POST /internal/clusters/:id/token`, bất biến I4, I5; Portal đủ ba chiến lược | §7.2, §7.3, §8.5, §9 Internal, §10.9, §16 "Lát cắt…" | S1 trả 422 cho mọi thứ ngoài FLAG_LEVEL + CANARY                                | #46, #51 |
| 8   | Provider OpenFeature + middleware Python (`contextvars`)                                                                                                                                                      | §6.8, §11.1, §16 "Provider Python chưa có"           | Chưa có                                                                         | #47      |
| 9   | Golden Path: mẫu Node và Python đủ cây §11.1 (`Dockerfile`, `k8s/`, `.github/workflows/udp.yml`); Import Existing Repo §11.2 (quét, đề xuất, cờ "chưa sẵn sàng cho flag-level rollout")                       | §11.1, §11.2, §10.5                                  | Wizard chỉ lưu `creationMode`; chỉ có `pipeline-template` của CI/CD             | #48      |
| 10  | Hạ tầng triển khai UDP: Dockerfile multi-stage cho S1/S2/S3/Portal/sample-app, manifest Kubernetes, PostgreSQL + Prometheus trong cluster, job migrate + đăng nhập role, script `up`/`down` trên `kind`       | §13.5 "build image", §15.1 hàng Local, §15.2, §15.3  | Không có Dockerfile, không manifest; `docker-compose.dev.yml` chỉ có Prometheus | #49      |
| 11  | CI/CD của chính UDP: build image, dựng `kind` rồi triển khai + E2E rút gọn, cổng I28 theo `git diff`, lane hằng đêm; đo E9 trên runner                                                                        | §13.5, I28 (§13.3), E9 (§14.1)                       | CI chỉ có typecheck, lint, format, bộ test trên database dùng-một-lần           | #50      |
| 12  | Sổ nợ thiếu hai phép đo cam kết: E2 (thời gian provisioning theo cloud) và E9 (tài nguyên tiêu thụ)                                                                                                           | §14.1                                                | Không có mục trong sổ; E9 đo ở #50, E2 cần cloud thật ⇒ ghi nợ                  | #50      |

## 2. Hạ tầng phải có chi phí đúng 0 — yêu cầu cứng

Người dùng yêu cầu (28/09/2026, không được đổi): hạ tầng dựng cho dự án phải tốn **0 đồng**. Chọn theo
nguyên tắc "bằng 0 do cấu trúc", không phải "thường nằm trong hạn mức":

| Thành phần | Chọn                                                                                                                          | Vì sao bằng 0                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cluster    | `kind` trên máy cá nhân (§15.1 hàng Local) và `kind` trong runner GitHub (§15.1 hàng CI)                                      | Chạy trên máy có sẵn; không EKS/GKE/AKS, không load balancer, không NAT gateway                                                                                           |
| Image      | Build trong runner rồi `kind load docker-image` thẳng vào cluster                                                             | Không cần registry. Đẩy GHCR chỉ bật khi đặt biến repo `UDP_PUBLISH_IMAGES=true` (mặc định tắt)                                                                           |
| CI         | GitHub Actions, runner chuẩn `ubuntu-latest`                                                                                  | Repo public: miễn phí không giới hạn phút. Repo private: 2 000 phút/tháng miễn phí; hết hạn mức thì job dừng, không tự tính tiền khi hạn mức chi tiêu là 0 USD (mặc định) |
| Database   | PostgreSQL trong cluster cho bản triển khai (§15.3 "mặc định của bản triển khai demo"); Supabase free cho dev/CI như hiện tại | Image `postgres` chính thức, dữ liệu trên volume của node; Supabase gói free không có phương thức thanh toán                                                              |
| Metrics    | Prometheus trong cluster                                                                                                      | Image chính thức, không SaaS                                                                                                                                              |
| Truy cập   | `kubectl port-forward` hoặc ingress-nginx trên cổng của máy                                                                   | Không domain, không chứng chỉ trả phí                                                                                                                                     |

**Không làm** hàng "Cloud thật — bật theo phiên" của §15.1 và script `make cloud-up` / `make cloud-down`
của §15.2: chúng tạo cluster tính tiền theo giờ, trái yêu cầu cứng. Ghi thành sai lệch có chủ đích
trong §15 khi làm #49; các phép đo cần cloud thật vẫn là nợ như cũ.

## 3. Thứ tự và quy trình

#43 → #44 → #45 → #46 → #47 → #48 → #49 → #50 → #51, rồi bàn giao cuối (số plan theo thứ tự làm). Việc nhỏ và độc lập đi trước để
CI xanh lại sớm. Luồng 5 là việc lớn nhất, chia hai plan: #46 chiến lược mức flag, #51 mức service — đi sau cùng vì nó cần gói client Kubernetes dùng chung, route cấp token và sinh CR Argo/Flagger, trong khi hạ tầng và CI/CD (#49, #50) là thứ người dùng hỏi trực tiếp.

Mỗi plan theo quy trình cũ: spec (`docs/plans/planNN-spec.md`) → plan (`planNN-plan.md`) → mã → cổng
(typecheck, lint, prettier trên tệp đổi, test theo lô của `trang-thai-2026-09-27.md` §4) → cập nhật
thiết kế, sổ nợ, bàn giao → commit ở máy. Thứ không kiểm được trên máy này (Docker cần ≥ 2 GiB RAM
trống, cluster thật) đi vào sổ nợ kèm lệnh chạy và dấu hiệu đạt.

## 4. Tiến độ

| Plan | Trạng thái                                                                                                                                                                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #43  | XONG 28/09 — 34 tệp lệch prettier (`e5cc139`); cổng `format:check` của CI xanh lại                                                                                                                                                                                          |
| #44  | XONG 28/09 — làm trước #43 vì mã đã viết dở lúc máy chưa chạy được lệnh. Kèm hai lỗi tìm ra khi làm (xem `plan44-spec.md` §4): 500 khi xoá variant đang dùng, hai nút vòng đời của Portal luôn 428                                                                          |
| #45  | XONG 28/09 — `retry` (job `reapply`), `versions` + `toVersion`, `deployments/latest` + `logs`, `cluster` ở chi tiết project; Portal: Thử lại / Áp lại, hộp nâng cấp có validator, hai thẻ Tổng quan, nhật ký deploy (D-P33)                                                 |
| #46  | XONG 28/09 — `ATTRIBUTE_SPLIT` ở FLAG_LEVEL (không tự quyết; PROMOTE tay đổi default variant qua S2 mang người bấm); BLUE_GREEN FLAG_LEVEL 422 theo thiết kế (D-P34)                                                                                                        |
| #47  | XONG 28/09 — provider Python `sdks/python` (lõi viết lại, 906 test kể cả 639 pattern regex do Node sinh; I15c + I26 chéo ngôn ngữ với Service 2 thật); ngữ pháp regex khả chuyển (D-P35); job CI `python`                                                                   |
| #48  | XONG 29/09 — Golden Path Node/Python là dự án chạy được (`packages/golden-path`), `GET /golden-path`, quét repo GitHub/GitLab (`POST /repo-scan`, `projects.repo_scan`), trang Mã nguồn + thẻ sẵn sàng; nhãn phiên bản pod khi áp image; pipeline test theo runtime (D-P36) |

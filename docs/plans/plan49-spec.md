# Plan #49 — SPEC v1: hạ tầng triển khai UDP, chi phí 0

Nguồn: `docs/ban-giao/viec-con-lai-2026-09-28.md` mục 10 và §2 (yêu cầu cứng: chi phí hạ tầng ĐÚNG 0);
§13.5 "build image", §15.1 hàng Local/CI, §15.2, §15.3 "PostgreSQL trong cụm K8s — mặc định của bản
triển khai demo".

## 1. Phạm vi

| Thiết kế hứa                                                          | Hôm nay                                     | Plan này                                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Image của S1, S2, S3, Portal (§13.5 "build image")                    | Không Dockerfile nào                        | Dockerfile nhiều tầng cho service Node (một tệp, tham số theo package), Portal (nginx không root), job migrate |
| Bản triển khai demo: PostgreSQL + Prometheus trong cụm (§15.1, §15.3) | Chỉ `docker-compose.dev.yml` với Prometheus | Kustomize `deploy/k8s`: base + overlay `kind`                                                                  |
| Local = `kind` (§15.1)                                                | Không script                                | `pnpm deploy:up` / `deploy:down` — dựng kind, build, nạp image, sinh secret, migrate, chờ sẵn sàng             |
| `make cloud-up` / `cloud-down` (§15.2)                                | Không có                                    | **Không làm** — tạo cluster tính tiền theo giờ, trái yêu cầu chi phí 0 (D-P37)                                 |

## 2. Quyết định

### QĐ-1: Service chạy mã nguồn bằng `tsx`, không bundle

Gói `@udp/*` xuất thẳng mã TS (`main: ./src/index.ts`), nên `node dist/src/index.js` (script `start` cũ)
chưa bao giờ chạy được. Bundle bằng esbuild thì vỡ registry adapter của S1 — nó KHÁM PHÁ adapter bằng
`import()` động trên cây thư mục (§5.3) — và vỡ mọi tài nguyên đọc theo `import.meta.url` (template
Golden Path). Image chạy `node --import tsx src/index.ts`: ĐÚNG đường mã mà dev và cả bộ test đã chạy.
`tsx` thành phụ thuộc chạy của service; `start` sửa theo; script `build` (sinh `dist/` không chạy được)
bỏ khỏi ba service.

### QĐ-2: Một Dockerfile cho mọi service Node

`deploy/docker/service.Dockerfile` với `ARG PKG` (tên package) và `ARG DIR` (thư mục): tầng build cài
đúng đồ thị phụ thuộc của package (`pnpm install --filter "<PKG>..."`), sinh Prisma client, cài lại chỉ
phụ thuộc production; tầng chạy `node:22-alpine`, người dùng `node`. `.dockerignore` loại `.env*`, `.git`,
`node_modules`, tài liệu — bí mật không bao giờ vào image.

### QĐ-3: Kustomize — base dùng chung, overlay theo nơi chạy

`deploy/k8s/base`: namespace `udp`; PostgreSQL 16 (StatefulSet + PVC); Prometheus (khám phá pod theo
annotation `prometheus.io/*`, gắn nhãn `namespace` từ namespace của pod — đúng giả định §7.4); job
`udp-migrate` (migrate deploy, bật LOGIN + mật khẩu cho `udp_s1…3`, seed tuỳ cờ); S1, S2, S3 (probe
`/healthz`, `/readyz`, không root, request/limit); Portal (nginx proxy `/api` sang S1, không đệm cho SSE).
Cấu hình không bí mật ở ConfigMap `udp-config`; bí mật ở Secret `udp-secrets` do script sinh — không
commit. `deploy/k8s/overlays/kind`: image `udp/*:local` nạp thẳng vào kind (`imagePullPolicy: Never`, không
registry), NodePort cho Portal (8080) và Service 2 (3002), sample-app trong namespace env dev của seed.

### QĐ-4: Cấu hình sinh ra được kiểm bằng CHÍNH schema env

Schema env tách sang `@udp/config/env-schema` (không tác dụng phụ). Test của `@udp/deploy` dựng overlay
bằng `kubectl kustomize`, gộp ConfigMap với bộ secret do CHÍNH hàm sinh của script tạo, rồi parse bằng
`envSchema` — cấu hình trong cluster mà mọi service từ chối là test đỏ, không phải pod crash lúc chạy.
Cùng test kiểm: image đúng tập build, cổng Service khớp container, probe đúng đường, không container nào
của UDP chạy root, NodePort khớp `extraPortMappings` của kind, namespace sample-app khớp seed.

### QĐ-5: Chi phí 0 do cấu trúc

kind trên máy có sẵn; image build tại chỗ và `kind load` (không registry); PostgreSQL và Prometheus là
image chính thức trong cụm; truy cập qua cổng của máy. Không tài nguyên cloud nào được tạo.

## 3. Tiêu chí chấp nhận

- **AC-1** `kubectl kustomize deploy/k8s/overlays/kind` dựng được; test bất biến manifest xanh.
- **AC-2** Cấu hình cluster (ConfigMap + secret sinh ra) qua `envSchema`.
- **AC-3** `pnpm deploy:up` dựng xong một cụm chạy được: migrate hoàn tất, S1/S2/S3/Portal sẵn sàng — kiểm
  ở CI (Plan #50) vì máy dev không đủ RAM cho Docker (ghi sổ nợ với lệnh chạy và dấu hiệu đạt).
- **AC-4** Không thoái cấp: service vẫn chạy bằng `pnpm dev`; mọi test hiện có xanh.

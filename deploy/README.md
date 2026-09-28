# deploy — UDP trên cụm kind, chi phí 0

Hạ tầng triển khai của UDP (Plan #49): mọi thứ chạy trên máy có sẵn — không registry, không cloud,
không dịch vụ trả phí.

```bash
pnpm deploy:up     # dựng cụm kind "udp", build + nạp image, sinh Secret, migrate + seed, chờ sẵn sàng
pnpm deploy:down   # huỷ cụm (cùng dữ liệu PostgreSQL)
```

Cần Docker đang chạy (≥ 4 GiB RAM cho Docker), `kind` và `kubectl` trên PATH. Sau khi dựng:

| Thành phần             | Truy cập                                                                          |
| ---------------------- | --------------------------------------------------------------------------------- |
| Portal                 | http://localhost:8080 — tài khoản seed `dev@udp.local` / `udp12345678`            |
| Service 2 (SDK, OFREP) | http://localhost:3002 — SERVER key seed `udp_sk_dev_0000000000000000000000000000` |
| Prometheus             | `kubectl --context kind-udp -n udp port-forward svc/prometheus 9090:9090`         |

## Cấu trúc

- `docker/service.Dockerfile` — một Dockerfile cho S1, S2, S3 và sample-app (`--build-arg PKG`, `DIR`);
  service chạy mã nguồn bằng `tsx`, đúng đường mà dev và bộ test chạy.
- `docker/portal.Dockerfile` + `nginx.conf` — Portal tĩnh, proxy `/api` sang Service 1, nginx không root.
- `docker/migrate.Dockerfile` — job `udp-migrate`: migration, LOGIN + mật khẩu cho `udp_s1…3`, seed.
- `k8s/base` — PostgreSQL 16, Prometheus (khám phá pod, nhãn `namespace` từ pod), S1/S2/S3, Portal, job.
- `k8s/overlays/kind` — tag `local`, NodePort 8080/3002, seed, sample-app trong namespace env dev của seed.
- `kind/cluster.yaml` — một node, hai cổng ra máy.
- `src/cluster.ts` — hằng (context `kind-udp`, cổng máy, namespace sample-app), bộ sinh Secret, danh mục
  image; `src/up.ts`, `src/down.ts`, `src/diagnose.ts` (in pod, sự kiện, log khi dựng đỏ).
- `e2e/` — E2E rút gọn của §13.5 trên cụm đang chạy (Plan #50).

Mọi lệnh kubectl ghim context `kind-udp`: context hiện tại của máy có thể là một cụm cloud thật.

Secret `udp-secrets` sinh MỘT lần khi dựng cụm (tệp tạm quyền 0600, không qua dòng lệnh), không bao giờ
nằm trong repo; `.dockerignore` loại mọi `.env*` khỏi image.

## Kiểm

`pnpm --filter @udp/deploy test` dựng overlay bằng `kubectl kustomize` rồi kiểm: cấu hình cụm qua CHÍNH
schema env của service, image đúng tập build, cổng, probe, không container nào chạy root, NodePort ra tới
máy, namespace và SDK key của sample-app khớp seed; cùng nối dây của CI (`tests/ci-workflow.test.ts`).

Trên một cụm đang chạy:

```bash
pnpm --filter @udp/deploy e2e          # E2E rút gọn: Portal, API qua proxy, khoá CLIENT, OFREP, lan truyền SSE, Prometheus
pnpm --filter @udp/experiments e9      # E9: CPU/RAM khi rỗi và khi 1 000 SDK nối SSE (~8 phút)
pnpm --filter @udp/deploy diagnose     # khi có gì đỏ
```

CI chạy cả ba ở job `kind` (E9 chỉ ở làn đêm và khi chạy tay; kết quả là artifact `E9-<run_id>`).

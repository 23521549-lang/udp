# Plan #66 - Spec: `/internal/*` trên cổng riêng, và NetworkPolicy chỉ mở cổng đó cho bên gọi

Nối tiếp Plan #65 (D-P57). Giới hạn §16 "`/internal/*` chỉ còn một lớp: bí mật dùng chung" ghi điều kiện gỡ: tách
`/internal/*` sang cổng riêng, NetworkPolicy chỉ mở cổng đó cho bên gọi hợp lệ, và `TokenReview`. Đợt này làm hai vế
đầu - lớp mạng của T12. `TokenReview` là Plan #67: nó cần RBAC `system:auth-delegator`, token chiếu của
ServiceAccount và một chế độ cho dev/test không có cụm, độc lập với việc tách cổng.

## 1. Hiện trạng - đo trên mã ở `92fa78a`

| Khẳng định                                                                  | Bằng chứng                                                                                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hai service có route nội bộ                                                 | Service 1: `internalMetricsRouter`, `internalClusterTokenRouter` (`core-backend/src/app.ts:132-133`); Service 2: tám router (`flag-service/src/app.ts:12-19`) |
| Service 3 không có route nội bộ                                             | `pd-controller/src/app.ts` không mount `/internal`                                                                                                            |
| Mỗi service một cổng                                                        | `app.listen(env.CORE_BACKEND_PORT)`, `app.listen(env.FLAG_SERVICE_PORT)`                                                                                      |
| `CORE_BACKEND_URL`, `FLAG_SERVICE_URL` chỉ dùng cho bên gọi nội bộ và probe | S1 → S2: `app-deps.ts:187`; S3 → S1: `pd-controller/src/index.ts:59,77`; S3 → S2: `:65`; probe `/healthz`: `admin.controller.ts:191-192`                      |
| Trong cụm hai biến trỏ cổng công khai                                       | `deploy/k8s/base/kustomization.yaml:28-29`                                                                                                                    |
| Cụm chạy `NODE_ENV=production`                                              | `kustomization.yaml:26`; env-schema bắt buộc khai `NODE_ENV`                                                                                                  |
| 32 tệp test chạm `/internal`, phần lớn qua `createApp()` của supertest      | `grep -rln "/internal"` dưới `services/*/tests`, `packages/*/tests`                                                                                           |

## 2. Thiết kế

**Một app, hai listener, chốt theo cổng.** `createApp({ internalPort })` của Service 1 và Service 2 mount
`internalPortOnly(internalPort)` (mới, `@udp/http`) ở ĐẦU app, trước mọi router `/internal` (Service 2 có router mount
trước parser): request `/internal/*` mà `req.socket.localPort !== internalPort` đi thẳng tới `notFoundHandler` - 404
giống hệt route không tồn tại, không lộ route nội bộ có thật. `index.ts` mở hai listener trên cùng app và tắt êm cả
hai. Không truyền `internalPort` (supertest của 32 tệp test, test-support) thì không có chốt: route nội bộ ở cổng duy
nhất như hôm nay - test không phải đổi.

**Cấu hình.** `CORE_BACKEND_INTERNAL_PORT`, `FLAG_SERVICE_INTERNAL_PORT` trong env-schema, tuỳ chọn; `NODE_ENV=production`
thì BẮT BUỘC và phải khác cổng công khai (superRefine, fail-fast). Trong cụm: `CORE_BACKEND_URL=http://core-backend:3101`,
`FLAG_SERVICE_URL=http://flag-service:3102` - hai biến vốn là "địa chỉ service khác dùng để gọi", nay trỏ cổng nội bộ;
listener nội bộ phục vụ cả `/healthz` nên probe của Service 1 vẫn đúng. Không thêm biến URL mới.

**Manifest.** Deployment khai `containerPort` tên `internal`. Cổng nội bộ đi qua Service ClusterIP RIÊNG
`internal-core-backend`, `internal-flag-service` (QA vòng A): overlay kind đổi Service công khai thành NodePort, và một
cổng thêm vào đó sẽ lộ ra IP của node. Tên `internal-…` chứ không `…-internal`: kubelet sinh biến service link
`<TÊN>_PORT`, và `CORE_BACKEND_INTERNAL_PORT` là biến cấu hình (QA vòng B). NetworkPolicy `core-backend-ingress` và
`flag-service-ingress`: luật 1 mở cổng công khai cho MỌI nguồn, không có `from` (Traefik, NodePort, Prometheus, probe
của kubelet, sample-app ở namespace khác - chọn pod là cô lập mọi ingress của nó, nên phải mở lại tường minh); luật 2
mở cổng nội bộ chỉ cho nhãn bên gọi: Service 1 ← `pd-controller` (Service 2 không gọi route nào của Service 1, dù v4
ghi "S2/S3"); Service 2 ← `core-backend`, `pd-controller`.

**Cổng (viết trước).** `@udp/http`: chốt theo cổng trên hai listener thật (cổng công khai 404 cho `/internal`, cổng nội
bộ 200; không chốt khi không cấu hình). `@udp/config`: production thiếu cổng nội bộ hoặc trùng cổng công khai ⇒ từ
chối. `manifests.test.ts`: URL trong ConfigMap trỏ đúng cổng nội bộ của Service; mỗi policy mở cổng công khai cho mọi
nguồn và cổng nội bộ chỉ cho đúng nhãn bên gọi; danh sách bên gọi dựng từ MÃ (service nào đọc `env.*_URL` - ConfigMap chung cho mọi workload nên không phân
biệt được ai, QA vòng A); không Service NodePort nào mang cổng nội bộ. E2E kind và máy ảo: phép thử kẹp như Plan #65 cho cổng nội bộ của Service 2 (dương
`pd-controller`, âm nhãn lạ, âm namespace khác, dương) bằng `wget` tới ClusterIP; cổng công khai vẫn tới được từ nhãn
lạ (đối chứng: luật 1 không bị quên).

## 3. Không làm, và vì sao

- **`TokenReview`** - Plan #67 (§1).
- **Tách app thành hai app riêng.** 32 tệp test dựng `createApp()` và gọi `/internal` qua cùng app; chốt theo cổng cho
  đúng bảo đảm (cổng công khai không phục vụ `/internal`) mà không đổi chúng. Hai app là đổi cấu trúc không đổi bảo đảm.
- **Đưa `/metrics` sang cổng nội bộ.** Prometheus đang scrape cổng công khai; ingress công khai không route `/metrics`
  (§9). Đổi là một việc khác.

## 4. Tiêu chí nghiệm thu

1. Ba cổng tại chỗ đỏ trước, xanh sau; `@udp/http`, `@udp/config`, `@udp/deploy` xanh; typecheck ba service.
2. CI: `test` xanh (không test nào phải đổi vì chốt), `kind` và `vm` xanh gồm phép thử kẹp cổng nội bộ.
3. T12, §9, §16 nói đúng: lớp mạng có, `TokenReview` còn là giới hạn.

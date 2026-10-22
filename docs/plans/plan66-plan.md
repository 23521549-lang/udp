# Plan #66 - Kế hoạch: cổng nội bộ riêng cho Service 1 và Service 2, NetworkPolicy theo cổng

Spec: `docs/plans/plan66-spec.md`. Nhánh `p66-cong-noi-bo` tách từ `p61-dong-goi` (`92fa78a`), PR vào `p61-dong-goi`.
Cổng viết TRƯỚC, đỏ trên mã hiện tại, rồi sửa, rồi xanh, rồi commit một dòng tiếng Anh.

Chạm khoảng 20 tệp, một interface công khai (`createApp` của hai service, `@udp/http`), cấu hình chung và bất biến bảo
mật T12 ⇒ trên ngưỡng R2: ba vòng QA chạy lần lượt trên bản nháp.

**Nối tiếp (R3):** Plan #65. Giữ nguyên: `postgres-clients`; phép thử kẹp `deploy/e2e/netpol-probe.ts`; `INTERNAL_SERVICE_SECRET`
và `X-Internal-Secret` (lớp ứng dụng không đổi); `notFoundHandler`; cổng công khai 3001/3002 và mọi route công khai;
`createApp()` không tham số vẫn dựng được (32 tệp test).

**Mốc lùi (R10):** đỉnh `92fa78a`. Mỗi đợt một commit ⇒ `git revert`. Không đổi schema, migration, lockfile.

---

## 66a. Chốt theo cổng

- **Làm gì:** `internalPortOnly(port)` trả `RequestHandler` cho `/internal`: `req.socket.localPort === port` ⇒ `next()`,
  khác ⇒ `notFoundHandler(req, res, next)`.
- **Ở đâu:** `packages/http/src/internal-port.ts` (mới), export qua entry chính và một subpath thuần nếu cổng
  `ci-entry-purity` đòi; test `packages/http/tests/internal-port.test.ts` dựng HAI listener thật trên một app.
- **Hệ quả:** một hàm cho cả hai service, không chép.
- **Ai dùng hôm nay:** `createApp` của Service 1 và Service 2.

## 66b. Cấu hình

- **Làm gì:** `CORE_BACKEND_INTERNAL_PORT`, `FLAG_SERVICE_INTERNAL_PORT` (tuỳ chọn); superRefine: `NODE_ENV=production`
  ⇒ cả hai bắt buộc, khác cổng công khai tương ứng.
- **Ở đâu:** `packages/config/src/env-schema.ts`, test `packages/config/tests/env-internal-port.test.ts`, `.env.example`.
- **Lan sang:** mọi chỗ parse env ở production - `manifests.test.ts` đã parse ConfigMap của cụm bằng `envSchema`.

## 66c. Hai service

- **Làm gì:** `createApp(deps?, { internalPort? })` (Service 1 giữ `deps` là tham số đầu) mount chốt ở đầu app;
  `index.ts` mở listener thứ hai khi có cổng, tắt êm đóng cả hai (cùng thứ tự đã có).
- **Ở đâu:** `services/core-backend/src/{app.ts,index.ts}`, `services/flag-service/src/{app.ts,index.ts}`.
- **Hệ quả:** tiến trình thật ở production chỉ phục vụ `/internal` trên cổng nội bộ.

## 66d. Manifest và phép thử trên cụm

- **Làm gì:** cổng `internal` ở Deployment và Service; ConfigMap: hai cổng nội bộ, `CORE_BACKEND_URL`/`FLAG_SERVICE_URL`
  trỏ cổng nội bộ; `core-backend-network-policy.yaml`, `flag-service-network-policy.yaml`; cổng manifest; E2E kẹp cho
  cổng nội bộ của Service 2 ở kind và máy ảo (mở rộng `netpol-probe.ts` cho HTTP).
- **Ở đâu:** `deploy/k8s/base/{core-backend,flag-service,kustomization}.yaml`, hai tệp policy mới,
  `deploy/tests/manifests.test.ts`, `deploy/e2e/netpol-probe.ts`, `deploy/e2e/smoke.e2e.test.ts`,
  `deploy/e2e-vm/vm.e2e.test.ts`.

## 66e. Tài liệu

`docs/UDP_design.md`: §3.1, §9 khối Internal và ghi chú `/internal/*`, T12, §12.2, §13.5, §15.1 (không §15.3 - mục đó chỉ nói về PostgreSQL), §16 (hàng "chỉ còn một lớp" thành
"lớp mạng có, `TokenReview` chưa"), D-P58; chú thích ba tệp mã đã sửa ở Plan #65; bàn giao.

## Kiểm cuối (R9) và kiểm thoái cấp (R11)

`@udp/http`, `@udp/config`, `@udp/deploy` test; typecheck `@udp/http`, `@udp/config`, `core-backend`, `flag-service`,
`@udp/deploy`; eslint, prettier theo tệp đổi; `design-lint` phần không cần database. CI: cả 8 job. Kiểm thoái cấp:
route công khai, probe, Prometheus, SSE, ingress không đổi; dev và test không cấu hình cổng nội bộ chạy như cũ.

## Ba vòng QA đã bẻ gì (chạy lần lượt; vòng B bị ngắt một lần bởi giới hạn phiên, làm tiếp từ đầu)

- **A (thiết kế):** overlay kind đổi Service `flag-service` thành NodePort - thêm cổng nội bộ vào đó là lộ nó ra IP
  của node, đúng đường T12 lo ⇒ Service ClusterIP riêng; ConfigMap `udp-config` chung cho bốn workload nên không
  dựng được bên gọi từ đó ⇒ đọc từ mã; thiết kế hứa "S2/S3" gọi Service 1 nhưng Service 2 không gọi route nào ⇒ chỉ
  Service 3, ghi vào D-P58; mười một dòng thiết kế cần sửa.
- **B (mã và plan trước):** `port.optional()` lệch quy ước `optionalSetting` - chuỗi rỗng bị từ chối; test-support
  dựng Service 2 với env kế thừa - một cổng nội bộ trong `.env` của dev làm các tiến trình con giẫm cổng ⇒ đặt rỗng;
  luật 1 phải không có `from`; tên `core-backend-internal` sinh `CORE_BACKEND_INTERNAL_PORT` trùng biến cấu hình;
  chốt ở Service 1 đứng sau parser 1 MB ⇒ dời lên ngay sau `helmet`; `service-boot-contract` mù với `listenInternal`;
  `internal-routes` khoá chữ tiêu đề §9.
- **C (đúng kỹ thuật):** đo `req.socket.localPort` qua keep-alive, pipelining, IPv6 và 17 biến thể đường dẫn - không
  lách được; pod thử mang nhãn `pd-controller`/`core-backend` thành endpoint của Service thật ⇒ phía dương bằng
  `kubectl exec` vào pod Service 3; `wget` thoát 1 cho cả HTTP 4xx lẫn bị chặn ⇒ phân loại theo câu nó in; đo được
  `server.close()` của Node 22 không đóng kết nối keep-alive bận (392 request sau `close()`, 12 giây chưa đóng) ⇒
  `closeServer` đặt `connection: close`, test đỏ rồi xanh; luật trùng cổng áp cho mọi môi trường.

# Plan #65 - Kế hoạch: NetworkPolicy cho PostgreSQL trong cụm, và ba câu thiết kế nói đúng

Spec: `docs/plans/plan65-spec.md`. Cổng viết TRƯỚC, đỏ trên mã hiện tại, rồi sửa, rồi xanh, rồi một commit một dòng
tiếng Anh; push lên `p64-sua-loi-ci` (PR #2) khi lượt CI trước đã cho kết quả cần đọc.

Chạm sáu tệp và một bất biến bảo mật (T12, T15) ⇒ trên ngưỡng R2: ba vòng QA chạy lần lượt trên bản nháp; phần cuối
ghi từng chỗ bị bẻ.

**Nối tiếp (R3):** Plan #64. Giữ nguyên: `UDP_DB_TLS_MODE=disable` của cụm và rào host nội bộ; nhãn
`app.kubernetes.io/name` của mọi workload; `kube`/`kubeAsync` của E2E máy ảo; `PROXY_NOT_READY`; mọi cổng của
`manifests.test.ts`, `ci-workflow.test.ts`.

**Mốc lùi (R10):** đỉnh `8ea89bc`. Mỗi đợt một commit ⇒ `git revert`. Không đổi schema, migration, lockfile.

---

## 65a-1. Cổng manifest (viết trước)

- **Làm gì:** ba ô trong `describe` mới "NetworkPolicy của PostgreSQL (Plan #65)", chạy trên overlay `kind` và `vm`:
  policy chọn postgres đúng hình dạng; mọi workload mang chuỗi kết nối có nhãn trong danh sách; không nhãn thừa. Danh sách
  client dựng bằng `podWorkloads` + `allContainersOf` (gồm CronJob và initContainer).
- **Ở đâu:** `deploy/tests/manifests.test.ts`.
- **Hệ quả:** đỏ ở ô (1) và (2) trước 65a-2.
- **Lan sang:** không.
- **Ai dùng hôm nay:** `pnpm --filter @udp/deploy test` (job `check`/`test` của CI).

## 65a-2. Policy

- **Làm gì:** `deploy/k8s/base/postgres-network-policy.yaml` mới; thêm vào `resources` của
  `deploy/k8s/base/kustomization.yaml`.
- **Hệ quả:** trên k3s, chỉ năm loại pod tới được 5432; `kubectl exec` vào `postgres-0` không bị ảnh hưởng (socket
  trong pod). Trên kind, policy được áp; có cưỡng chế hay không tuỳ CNI.
- **Lan sang:** ô đếm tài nguyên của overlay trong `manifests.test.ts` nếu có (kiểm khi chạy).
- **Kiểm thoái cấp:** không đường nào đang dùng bị chặn - năm client là toàn bộ chỗ đọc `udp-secrets`/`DATABASE_URL*`
  (spec §1), và ô (2) chứng minh điều đó trên manifest đã dựng chứ không trên trí nhớ.

## 65a-3. Phép thử trên cụm thật - kind và máy ảo

- **Làm gì:** `expectPostgresOnlyForClients(kube, namespace)` trong `deploy/e2e/netpol-probe.ts`: tới ClusterIP, thứ tự
  kẹp dương - âm nhãn - âm namespace khác - dương, lặp đối xứng 10 lần; namespace tạm `udp-netpol-probe` xoá trước khi
  tạo và trong `finally`. Gọi ở `deploy/e2e/smoke.e2e.test.ts` (kind) và `deploy/e2e-vm/vm.e2e.test.ts` (k3s);
  `pnpm --filter @udp/deploy diagnose` in NetworkPolicy.
- **Hệ quả:** hai bộ cưỡng chế khác nhau (kindnet rơi gói, kube-router REJECT) cùng đo một policy. Bước E2E rút gọn
  của kind thêm khoảng 2-3 phút (âm rơi gói chờ đủ `--timeout`), dưới trần 10 phút.
- **Ai dùng hôm nay:** job `kind`, job `vm`.

## 65b. Thiết kế

`docs/UDP_design.md`: §16 hàng TLS máy công khai, T15, T12, §9 khối Internal và ghi chú `/internal/*`, §16 hàng I29,
hàng §16 mới "NetworkPolicy cho `/internal` cần cổng riêng", D-P57. Bàn giao 21/10 thêm mục Plan #65.

## Kiểm cuối (R9) và kiểm thoái cấp (R11)

`pnpm --filter @udp/deploy test`; typecheck `@udp/deploy`; eslint, prettier theo tệp đổi; `design-lint` (phần không
cần database). Trên runner: `kind`, `vm` xanh. Kiểm thoái cấp: mỗi câu thiết kế sửa phải giữ hoặc tăng điều nó bảo
đảm, không hạ một lời hứa xuống cho vừa mã mà không ghi thành giới hạn.

## Ba vòng QA đã bẻ gì (một vòng, chạy lần lượt)

- **A (thiết kế):** spec ghi TokenReview đã có - mã không có, xác thực nội bộ chỉ là bí mật dùng chung (D-P39); câu
  §16 về I29 chỉ nói quá một nửa (job của project đã bật domain vẫn thất bại); cổng chưa bắt peer `podSelector: {}`;
  phép thử chưa thử pod namespace khác - kịch bản đe doạ thật; ba câu thiết kế (§15.1, §13.5, câu "cụm chưa có
  NetworkPolicy nào") và ba chú thích trong mã sẽ sai sau đợt này.
- **B (mã và plan trước):** `internal-routes.test.ts` tìm khối §9 bằng đúng dòng tiêu đề và đóng khối ở dòng trống
  đầu tiên - sửa tại chỗ, không chèn dòng trống; pod dương mang nhãn `core-backend` sẽ thành endpoint của Service
  (giữ `udp-migrate`); `diagnose` chưa in NetworkPolicy.
- **C (đúng kỹ thuật):** pod khác namespace gọi `postgres` gặp NXDOMAIN và cũng thoát 2 - xanh giả, nên đi bằng
  ClusterIP; mã 2 không phân biệt bị chặn với postgres đang khởi động lại - kẹp bằng dương ở hai đầu; NetworkPolicy
  cộng dồn - cổng phải bắt policy thứ hai; kind v0.31.0 của CI CÓ cưỡng chế (spec ghi "chưa chắc" - sai), nên đo ở
  cả hai cụm. Đã đọc mã kube-router `v2.6.3-k3s1`: REJECT, kết nối ESTABLISHED được giữ.

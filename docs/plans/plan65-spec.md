# Plan #65 - Spec: chỉ client của database mới tới được PostgreSQL trong cụm

Nối tiếp Plan #64 (nhánh `p64-sua-loi-ci`, PR #2). Plan #64 đặt `UDP_DB_TLS_MODE=disable` cho postgres kèm cụm và ghi
vào §16 rằng máy công khai chạy plaintext trong mạng pod, với điều kiện gỡ: "trước đó, NetworkPolicy chỉ cho ba
service và hai job tới cổng 5432". Đợt này làm đúng biện pháp đó, và sửa hai chỗ thiết kế nói quá.

## 1. Hiện trạng - đo trên mã ở `9737605`

| Khẳng định                                                                                   | Bằng chứng                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cụm không có NetworkPolicy nào                                                               | `grep -rn "kind: NetworkPolicy" deploy` rỗng                                                                                                                                                                                                                                 |
| Postgres chỉ có Service ClusterIP, cổng 5432                                                 | `deploy/k8s/base/postgres.yaml` (không `type`)                                                                                                                                                                                                                               |
| Đúng năm workload nối tới postgres                                                           | `core-backend`, `flag-service`, `pd-controller`, Job `udp-migrate` (`envFrom: udp-secrets`), CronJob `udp-backup` (`DATABASE_URL_DIRECT`, overlay `vm`)                                                                                                                      |
| Mọi đường vận hành khác vào postgres đi qua `kubectl exec` (socket trong pod)                | `deploy/src/vm-restore.ts` (`POD = "postgres-0"`), `vm.e2e.test.ts` (`exec … psql`); không port-forward nào tới 5432                                                                                                                                                         |
| k3s cưỡng chế NetworkPolicy                                                                  | `deploy/vm/bootstrap.sh` cài k3s không có `--disable-network-policy` (bộ điều khiển kube-router nhúng sẵn, bật mặc định)                                                                                                                                                     |
| kind trong CI CÓ cưỡng chế                                                                   | Lượt `39506463646`, job `kind`: kind v0.31.0, `kindest/node:v1.35.0`, CNI mặc định (kindnet); từ kind v0.24 kindnet cưỡng chế NetworkPolicy (kube-network-policies, rơi gói) - đo bằng log, QA vòng C ⇒ phép thử chạy ở cả `kind` và `vm`                                    |
| T12 và §9 hứa "NetworkPolicy chỉ cho pod của S2/S3 tới cổng nội bộ" - mã không có            | Mỗi service một cổng (`app.listen(env.*_PORT)`), `/internal/*` cùng cổng với API công khai ⇒ NetworkPolicy không tách được theo đường dẫn                                                                                                                                    |
| Lớp bảo vệ ở tầng ứng dụng của `/internal/*` chỉ là bí mật dùng chung - TokenReview CHƯA làm | `INTERNAL_SECRET_HEADER`; `cluster-token.ts:26-27` và D-P39 ghi "xác thực nội bộ hôm nay là bí mật dùng chung"; ingress không route `/internal`, nginx của Portal chỉ chuyển `/api/`. Bản nháp đầu của spec này ghi TokenReview đã có - sai (QA vòng A)                      |
| Câu §16 "I29 chỉ kiểm một chiều … Portal vẫn cho bật" nói quá một nửa                        | `resolveTarget` (`domain-target.ts:44-53`) từ chối tool không có trong registry (422 `unknown-tool`), nên không BẬT MỚI được; nhưng project ĐÃ bật domain đó thì job áp domain và quét trôi thất bại (`domain-apply.job.ts:145-149`, `domain-phase.ts:143-147`) - nửa đó giữ |

## 2. Thiết kế

**65a - NetworkPolicy `postgres-clients`** (`deploy/k8s/base/postgres-network-policy.yaml`, thêm vào `resources` của
base): `podSelector` chọn pod postgres; `policyTypes: [Ingress]`; một luật `from` duy nhất là `podSelector` (không
`namespaceSelector` ⇒ chỉ namespace `udp`) với `app.kubernetes.io/name In [core-backend, flag-service, pd-controller,
udp-migrate, udp-backup]`, cổng TCP 5432. `udp-backup` chỉ có ở overlay `vm`; khai trong base là vô hại và giữ một
danh sách duy nhất.

**Cổng (viết trước):** `deploy/tests/manifests.test.ts`, trên CẢ HAI overlay: (1) có đúng một NetworkPolicy chọn pod
postgres, chỉ Ingress, chỉ cổng 5432, không `namespaceSelector`, không `ipBlock`; (2) **mọi** workload (Deployment,
StatefulSet, Job, CronJob) có container mang chuỗi kết nối - `envFrom` secret `udp-secrets` hoặc biến `DATABASE_URL*`

- có nhãn `app.kubernetes.io/name` nằm trong danh sách của policy; (3) không nhãn nào trong danh sách là thừa (mỗi nhãn
  khớp ít nhất một workload ở overlay `vm`). Ô (2) đỏ khi ai đó thêm một workload nối DB mà quên policy - đúng loại hỏng
  mà policy sinh ra (service không lên, chỉ lộ trên cụm).

**Phép thử trên cụm thật (E2E của `kind` và của máy ảo, một hàm dùng chung `deploy/e2e/netpol-probe.ts`):** pod
`postgres:16-alpine` lặp `pg_isready --timeout=3` tới ClusterIP của Service `postgres` (không qua tên: pod ở namespace
khác gặp NXDOMAIN và cũng thoát 2 - xanh giả), theo thứ tự kẹp: dương (namespace `udp`, nhãn `udp-migrate` - không
Service nào chọn nó) ⇒ 0; âm nhãn lạ ⇒ 2; âm namespace khác `udp-netpol-probe` với nhãn được phép ⇒ 2; dương lần hai
⇒ 0. Lặp đối xứng (10 lần): dương chịu được trễ đồng bộ của bộ cưỡng chế, âm không được lọt lần nào; dương lần hai
chứng minh postgres sống suốt quãng âm (mã 2 cũng ra khi nó đang khởi động lại).

**65b - Thiết kế nói đúng.** §16 hàng TLS của máy công khai: biện pháp bù nay có thật; T15 thêm NetworkPolicy. T12 và
§9 (khối Internal và ghi chú `/internal/*`): NetworkPolicy theo cổng nội bộ CHƯA làm - cần tách cổng nội bộ, là thay
đổi kiến trúc; TokenReview cũng chưa làm (D-P39); lớp đang có là header bí mật dùng chung + ingress và nginx không route `/internal`; ghi thành giới hạn §16.
§16 hàng I29: bỏ nửa nói quá, giữ nửa còn thật. Các câu hứa TokenReview (§3.1, §9, §13) và chú thích trong mã hứa NetworkPolicy cho `/internal` cũng nói đúng hiện trạng. D-P57.

## 3. Không làm, và vì sao

- **NetworkPolicy cho ba service.** Cổng của mỗi service vừa là API công khai (qua Traefik ở `kube-system`, qua
  NodePort ở kind) vừa là `/internal`: một policy theo pod nguồn phải mở cho Traefik và NodePort (nguồn là IP của
  node), nên không chặn được thứ T12 lo, mà rủi ro làm gãy đường công khai trên hai loại cụm là thật. Đúng cách là
  tách cổng nội bộ - một plan riêng.
- **default-deny cho cả namespace `udp`.** Cùng lý do; và mọi đường mới sau này phải nhớ mở policy.
- **TLS cho postgres kèm cụm.** Điều kiện gỡ đầy đủ của §16 vẫn giữ; policy là biện pháp bù trong lúc chờ.

## 4. Tiêu chí nghiệm thu

1. Cổng manifest đỏ trên mã hiện tại (chưa có policy), xanh sau 65a; cả `@udp/deploy` xanh.
2. Lượt CI: `kind` và `vm` xanh, gồm phép thử kẹp ở cả hai bộ cưỡng chế.
3. Thiết kế và chú thích trong mã không còn câu nào hứa NetworkPolicy hay TokenReview mà mã không có, hoặc nói hệ quả mà mã không gây ra.

# Plan #67 - Spec: danh tính bên gọi `/internal/*` bằng token chiếu của ServiceAccount và `TokenReview`

Nối tiếp Plan #66 (D-P58). Giới hạn §16 "`/internal/*`: có lớp mạng, chưa có danh tính bên gọi" ghi điều kiện gỡ:
Service 1 và Service 2 xác thực bên gọi bằng token chiếu của ServiceAccount cộng `TokenReview`, RBAC tương ứng, và một
chế độ cho dev/test không có cụm. Đợt này làm lớp ứng dụng của T12, và khoá chính ServiceAccount của bên gọi để danh
tính đó có nghĩa (QA vòng A).

## 1. Hiện trạng - đo trên mã ở `b57ebcc`

| Khẳng định                                                                     | Bằng chứng                                                                                                                          |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Lớp ứng dụng duy nhất là bí mật dùng chung                                     | `packages/http/src/internal-caller.ts` (`requireInternalCaller`, so `X-Internal-Secret` hằng thời gian)                             |
| Ai giữ bí mật và tạo được pod mang nhãn bên gọi trong `udp` thì qua cả hai lớp | NetworkPolicy theo nhãn (`core-backend-ingress`, `flag-service-ingress`); bí mật nằm trong Secret `udp-secrets` (§16)               |
| Bốn client nội bộ, đều nhận `secret: string`                                   | S1 → S2 `createFlagServiceClient`; S3 → S1 `createCoreMetricsClient`, `createClusterTokenClient`; S3 → S2 `createFlagLevelExecutor` |
| 30+ tệp test dựng bốn client hoặc gọi `/internal` bằng bí mật                  | `grep -rln` bốn hàm dựng dưới `services/*/tests`; `packages/test-support/src/fixture.ts`                                            |
| Service 2 và Service 3 chạy bằng ServiceAccount `default`                      | trong các service chỉ `core-backend.yaml` khai `serviceAccountName` (ngoài ra `prometheus.yaml`)                                    |
| Đã có client API server trong cụm có ghim CA                                   | `platformProbeFromEnv` (`core-backend/src/core/platform-probe.ts`), `caPinnedTransport` (`@udp/cluster-access`)                     |
| Mọi tiến trình đọc `udp-config` trong cụm chạy `NODE_ENV=production`           | `deploy/k8s/base/kustomization.yaml`; ba service, job `udp-migrate` (`sync-catalog`, `seed` import `@udp/config`)                   |
| Image service đặt sẵn `NODE_ENV=production`                                    | `deploy/docker/service.Dockerfile:25`; `build-smoke` của CI chạy app mẫu, không chạy image service của UDP                          |
| Header request không vào log                                                   | serializer của `request-logger.ts` chỉ giữ `id`, `method`, `url`; `logger.ts` che `req.headers.authorization`                       |
| Quyền tạo pod trong một namespace là quyền dùng MỌI ServiceAccount ở đó        | mô hình phân quyền của Kubernetes (pod chọn `serviceAccountName`, admission `ServiceAccount` chỉ kiểm SA tồn tại)                   |

## 2. Thiết kế

**Bên gọi gửi token chiếu, mỗi đích một audience.** Pod của bên gọi gắn một volume `projected` với
`serviceAccountToken` cho từng đích nó gọi: audience `udp:internal:core-backend` và `udp:internal:flag-service`
(hằng trong `@udp/config/constants`), hết hạn 3600 giây, kubelet tự xoay. Client đọc tệp token MỖI lời gọi và gửi
`Authorization: Bearer <token>` bên cạnh `X-Internal-Secret`. Audience theo đích: token gửi cho Service 2 không dùng lại
được ở Service 1 nếu Service 2 bị chiếm.

**Bên nhận hỏi API server.** Service 1 và Service 2 gọi `TokenReview` (`authentication.k8s.io/v1`) với
`spec.audiences = [audience của chính nó]`, rồi đòi đủ ba điều: `status.authenticated`, `status.audiences` chứa
audience đó (tài liệu Kubernetes: bên đặt `spec.audiences` phải kiểm điều này để chắc API server hiểu audience), và
`status.user.username` thuộc danh sách bên gọi - `system:serviceaccount:<namespace của chính nó>:<tên>`. Danh sách là
hằng `INTERNAL_CALLERS`: Service 1 ← `pd-controller`; Service 2 ← `core-backend`, `pd-controller` - cùng tập mà cổng
manifest của Plan #66 dựng từ mã.

**Nhớ và khi API server vắng (QA vòng A).** Kết quả dương nhớ 10 giây theo sha256 của token, gộp lời gọi đang bay, giới
hạn số mục; âm không nhớ. Lỗi mạng hay 5xx từ API server: dùng tiếp kết quả dương ĐÃ CÓ của đúng token đó tới 60 giây kể
từ lần xác nhận cuối; không có ⇒ 503 (bên gọi thử lại). `authenticated: false` hay audience, username sai thì luôn từ
chối, không bao giờ dùng bản nhớ. Đánh đổi được ghi vào thiết kế: API server thành phụ thuộc trên đường dữ liệu nội bộ
(CRUD flag, kill-switch); trần 60 giây giữ hệ thống chạy qua một lần k3s khởi động lại ngắn mà không cho token lạ nào
qua. Pod bên gọi bị xoá thì token của nó bị từ chối sau khoảng 50 giây (QA vòng C: ân hạn dừng pod 30 giây vì API server
cho leeway quanh `deletionTimestamp`, API server tự nhớ kết quả 10 giây, cộng 10 giây nhớ của verifier); khoảng 100 giây
nếu API server vắng đúng lúc đó.

**Vì sao `TokenReview` chứ không kiểm JWT bằng JWKS** (lối mà §8.3 chọn cho Trusted Deploy trên cụm của khách,
Plan #61). Lối JWKS ở đó tránh thêm quyền trên cụm của KHÁCH, vốn phải bootstrap lại. Ở đây là cụm của chính UDP, manifest
do repo này dựng, nên quyền thêm là một ClusterRoleBinding trong base. Đổi lại, `TokenReview` biết token còn gắn với pod
đang sống, còn JWKS chấp nhận tới khi token hết hạn (một giờ).

**Khoá ServiceAccount của bên gọi (QA vòng A, chặn).** Không có bước này, ai có quyền tạo pod trong `udp` đặt
`serviceAccountName: pd-controller` là qua cả ba lớp, và `TokenReview` chỉ xác nhận đúng cái tên đó. Một
`ValidatingAdmissionPolicy` (`udp-internal-identity`, binding `Deny`) chặn mọi cách lấy được danh tính của ba
ServiceAccount `core-backend`, `flag-service`, `pd-controller` trong `udp` để làm BÊN GỌI `/internal`, và giả làm
BÊN NHẬN để hứng token:

- TẠO Deployment, StatefulSet, DaemonSet, Job, CronJob, ReplicaSet, ReplicationController, Pod mang một trong ba SA
  đó; SỬA chúng khi pod template đổi (đổi image hay lệnh là chạy mã khác dưới cùng SA; controller và garbage collector
  không đổi template); `pods/exec`, `pods/attach`, `pods/ephemeralcontainers` vào pod mang SA đó (đọc được tệp token);
  `serviceaccounts/token` (TokenRequest) cho chúng; tạo, sửa, xoá ConfigMap `udp-config-*` và Secret `udp-secrets` mà
  ba Deployment nạp qua `envFrom` (QA vòng B: thêm `NODE_OPTIONS=--import=…` vào ConfigMap rồi xoá pod là chạy mã lạ
  dưới SA `pd-controller` mà không chạm template);
- SỬA Pod mang ba SA khi image của `containers`, `initContainers` đổi so với `oldObject` (QA vòng C: `kubectl set image
pod/…` giữ nguyên UID, SA và token; garbage collector và controller chỉ sửa metadata);
- nhãn `app.kubernetes.io/name` mang một trong ba tên thì `serviceAccountName` phải cùng tên, cho Pod và mọi template
  (QA vòng C, chặn: pod SA `default` mang nhãn `core-backend` thành endpoint của Service `internal-core-backend`, nhận
  nguyên văn token chiếu và bí mật của `pd-controller` rồi phát lại tới pod thật - bên gọi không xác thực bên nhận);
  tạo, sửa, xoá năm Service (`core-backend`, `flag-service`, `pd-controller`, `internal-core-backend`,
  `internal-flag-service`) và EndpointSlice mang nhãn `kubernetes.io/service-name` của chúng (chỉ
  `endpointslice-controller`); xoá ba ServiceAccount; Secret kiểu `kubernetes.io/service-account-token` trỏ tới chúng;
- với `pods/exec`, `pods/attach` (thao tác `CONNECT`) và TokenRequest, `object` là `PodExecOptions`, `PodAttachOptions`,
  `TokenRequest` - không có `serviceAccountName` (QA vòng B) ⇒ so `request.name`: tên pod bắt đầu bằng
  `core-backend-`, `flag-service-`, `pd-controller-` (pod mang ba SA chỉ sinh từ Deployment cùng tên - cổng manifest
  khẳng định không workload nào khác có tên với tiền tố đó), tên SA với TokenRequest; `pods/ephemeralcontainers` có
  `object` là Pod;
- CEL đọc `serviceAccountName` bằng `?.` và `orValue("default")` cho mọi hình (Pod, template của Deployment, Job,
  CronJob): template không khai SA (CronJob `udp-backup` sinh Job qua `cronjob-controller`) không được làm biểu thức lỗi;
  `failurePolicy: Fail` khai tường minh;
- được phép khi bên yêu cầu có quyền `escalate` trên `clusterroles` (biến `authorizer` của CEL) - tức người cài đặt, vốn
  đã làm được mọi thứ; hoặc là controller tạo đúng loại đó: ReplicaSet ← `deployment-controller`, Pod ←
  `replicaset-controller` (dạng ServiceAccount của `kube-system` - kind và k3s đều bật
  `use-service-account-credentials`, QA vòng C); TokenRequest ← nhóm `system:nodes` (kubelet xin token chiếu). Pod CREATE
  dùng `generateName` nên `request.name` rỗng - với Pod chỉ dựa vào `object`.

Kẻ chỉ có quyền trong namespace (`admin`, `edit` buộc bằng RoleBinding) không có `escalate` trên `clusterroles`, nên không
tạo được workload mang SA bên gọi, không vào được pod của nó, không xin được token cho nó. Phần còn lại, ghi vào §16:
chiếm node (đọc được tệp token của mọi pod trên node), quyền cấp cụm, mã của chính bên gọi bị chiếm, registry image bị
chiếm; pod `hostPath` ở namespace KHÁC `udp` (Pod Security chỉ đặt cho `udp`, k3s không có mặc định cấp cụm - QA vòng C);
bên gọi không xác thực bên nhận (lý do dài hạn cho mTLS). `edit` vẫn `impersonate` được ba SA: đó là danh tính API
(quyền đọc và `tokenreviews: create`), KHÔNG là token `/internal` - API server không cấp token có audience qua giả danh,
và token không audience bị `TokenReview` với `spec.audiences` từ chối.

**Pod Security `baseline` cho namespace `udp` (QA vòng B, chặn).** Không có nó, người có quyền `edit` tạo pod SA
`default` gắn `hostPath` tới thư mục pod của kubelet và đọc tệp token chiếu của `pd-controller` - k3s một node nên luôn
cùng node. Nhãn `pod-security.kubernetes.io/enforce: baseline` ở `namespace.yaml` chặn `hostPath`, `hostNetwork`,
`privileged`; mọi workload hiện có (ba service, portal, postgres, prometheus, migrate, backup) đều qua `baseline`.

**RBAC hẹp nhất.** ClusterRole `udp-internal-token-review` chỉ có `tokenreviews: create`, buộc vào ServiceAccount
`core-backend` và `flag-service` - không dùng `system:auth-delegator` (thiết kế §16 ghi tên này) vì nó cấp thêm
`subjectaccessreviews`. ServiceAccount mới `flag-service`, `pd-controller`; `pd-controller` không gọi API server của cụm
nên `automountServiceAccountToken: false`, chỉ có token chiếu. Câu "Service 1 chỉ đọc" thành "chỉ đọc, cộng
`tokenreviews: create`".

**Một middleware, mount ở cấp app.** `requireInternalIdentity({ verifier, callers })` (`@udp/http`) mount ở
`app.use("/internal", …)` ngay sau `internalPortOnly`, trước parser: mọi route nội bộ đều qua, không sửa call-site nào
của `requireInternalCaller`, request chưa xác thực không được parse body. Thiếu token, token sai, bên gọi lạ: cùng một 401
"Lời gọi nội bộ không hợp lệ" như bí mật sai; middleware tự log `warn` có cấu trúc `{ reason, username }` (không bao giờ
token), vì ở Service 1 nó đứng trước `requestLogger`. Tên hàm không kết thúc bằng `Router` (cổng `internal-routes` lấy
định danh `\w*Router` trong mount `/internal`).

**Ranh giới package (QA vòng A).** `CallerVerifier` là interface của `@udp/http`. Hiện thực `TokenReview` ở
`@udp/cluster-access`, subpath MỚI `@udp/cluster-access/in-cluster` (chỉ `node:fs`, `undici` - Service 2 không nạp
`direct.ts`, `adapter-core`); nó KHÔNG import `@udp/http` (kéo theo `@udp/db` và kiểm env) - tự khai kiểu trả về, tương
thích cấu trúc được typecheck ở `index.ts` của hai service. Cùng subpath: `inClusterApi()` trả
`{ kind: "outside" } | { kind: "in-cluster", api }`, tách từ `platformProbeFromEnv` (probe lùi về "ngoài cụm", verifier
thì thoát). `flag-service` khai thêm phụ thuộc `@udp/cluster-access` ⇒ `pnpm-lock.yaml` đổi phần `importers`.

**Chế độ.** `INTERNAL_AUTH_MODE`: `secret` (mặc định - dev, test, supertest: như hôm nay) hoặc `token-review`.
`NODE_ENV=production` ⇒ BẮT BUỘC `token-review` và `INTERNAL_TOKEN_DIR` là đường tuyệt đối - schema chỉ kiểm chuỗi, không
đọc đĩa (job `udp-migrate` dùng cùng schema). Lúc khởi động: bên nhận (Service 1, 2) ngoài cụm ⇒ thoát, không lùi về
`secret`; bên gọi (Service 1, 3) đọc thử tệp token của TỪNG đích nó gọi trước khi mở cổng, thiếu ⇒ thoát với lỗi rõ. Bí
mật dùng chung giữ nguyên ở mọi chế độ.

**Cổng (viết trước).**

- `@udp/http`: middleware với verifier giả - thiếu header, sai scheme, verifier trả `null`, username ngoài danh sách,
  verifier ném ⇒ 503; đúng ⇒ `next()`; dòng log không chứa token.
- `@udp/cluster-access`: `TokenReview` trên API server giả - thân request đúng, ba điều kiện, nhớ dương, không nhớ âm,
  gộp lời gọi đang bay, dùng bản nhớ có trần khi 5xx hay lỗi mạng và KHÔNG khi `authenticated: false`.
- `@udp/config`: production thiếu `token-review` hay `INTERNAL_TOKEN_DIR` (hoặc đường tương đối) ⇒ từ chối.
- `manifests.test.ts`, `vm.test.ts` (theo SUBJECT, không theo tên):
  - mỗi bên gọi có ServiceAccount riêng, token chiếu đúng audience cho đúng các đích; tập đích dựng từ mã khớp
    `INTERNAL_CALLERS` và NetworkPolicy;
  - mọi quyền buộc vào SA `core-backend` gộp lại đúng bằng các quyền đọc cũ cộng `tokenreviews: create`; quyền
    `tokenreviews` chỉ ở `core-backend`, `flag-service`; `pd-controller` không gắn token mặc định;
  - `ValidatingAdmissionPolicy` có mặt, che đúng ba SA và đủ các loại workload;
  - cổng parse env của cụm thêm job `udp-migrate`.
- E2E kind và k3s:
  - **Dương:** Service 3 thật gọi route nội bộ có thật của cả hai service bằng bí mật cộng token chiếu ⇒ đúng mã của
    route (không phải 401, không phải 503 - lớp danh tính hỏng trả 503). Có token mà không bí mật ⇒ đúng 401.
  - **Âm, trên pod thật:** từ pod Service 3, có bí mật (đọc `process.env`, không qua argv) nhưng không token ⇒ đúng 401;
    token của audience kia ⇒ đúng 401.
  - **Âm, kẻ mạo nhãn:** pod dựng bằng `kubectl apply` mang nhãn `pd-controller` (qua NetworkPolicy), SA `default`, token
    chiếu ĐÚNG audience, bí mật qua `secretKeyRef` ⇒ đúng 401 (in dòng trạng thái, không chỉ mã thoát). Pod chạy dài,
    readiness luôn hỏng (không thành endpoint của Service thật), đo bằng `kubectl exec`.
  - **Âm, kẻ có quyền trong namespace:** một ServiceAccount thử có Role tạo pod, deployment, replicaset và
    `pods/exec`, `serviceaccounts/token`, `configmaps` trong `udp` (đủ `get`, `patch` để RBAC không trả 403 trước
    admission); phép ghi chạy `--dry-run=server`; `exec` và `create token` không có dry-run nên chạy thật nhưng vô hại theo
    cấu tạo (`exec -- true`, token không in ra); giả danh nó (`--as`): tạo pod và Deployment mang SA `pd-controller`,
    sửa image của Deployment `pd-controller` thật, `exec` vào pod của nó, xin token cho `pd-controller`, sửa ConfigMap `udp-config-*`, tạo pod SA `default` mang nhãn `core-backend`, sửa image pod `pd-controller` ⇒ admission
    từ chối, thông điệp nêu tên policy. Đối chứng: cùng danh tính tạo pod SA `default` ⇒
    được (lần từ chối đến từ policy, không từ RBAC). Pod `hostPath` SA `default` ⇒ Pod Security từ chối.
  - **Quyền:** `kubectl auth can-i create tokenreviews` có cho `core-backend`, `flag-service`; không cho `pd-controller`.

## 3. Không làm, và vì sao

- **Bỏ bí mật dùng chung.** Ở chế độ `secret` nó là lớp duy nhất; trong cụm nó là lớp thứ ba, chi phí bằng không. Webhook
  Flagger (`pd-controller/src/delivery/gate.ts`) còn dẫn khoá HMAC từ nó.
- **D-P39 cấp SA theo danh tính bên gọi.** Route token vẫn chỉ cấp `traffic`; giờ Service 1 BIẾT bên gọi là Service 3,
  nhưng chưa có bên gọi thứ hai cần SA khác - mở rộng khi có consumer.
- **mTLS giữa các service.** §9 cho phép "mTLS hoặc shared secret"; token chiếu cho danh tính mà không cần CA nội bộ và
  xoay chứng chỉ.
- **Trusted Deploy trên cụm của khách** (§8.3, JWKS) - đã có từ Plan #61, ngoài phạm vi.
- **Chạy image service ngoài cụm ở `NODE_ENV=production`** - giờ không khởi động; ghi một dòng ở `deploy/README.md`.

## 4. Tiêu chí nghiệm thu

1. Các cổng tại chỗ đỏ trước, xanh sau; `@udp/http`, `@udp/cluster-access`, `@udp/config`, `@udp/deploy` xanh;
   typecheck ba service.
2. CI cả 8 job xanh; `kind` và `vm` gồm năm nhóm phép thử ở §2.
3. Thiết kế nói đúng (danh sách mục ở plan 67f); hàng §16 "chưa có danh tính bên gọi" viết lại thành phần còn lại thật
   (chiếm node, quyền cấp cụm, mã của bên gọi bị chiếm) và đánh đổi phụ thuộc API server.

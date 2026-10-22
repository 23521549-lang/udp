# Plan #67 - Kế hoạch: danh tính bên gọi `/internal/*` bằng token chiếu và `TokenReview`

Spec: `docs/plans/plan67-spec.md`. Nhánh `p67-token-review` tách từ `p61-dong-goi` (`b57ebcc`), PR vào `p61-dong-goi`.
Cổng viết TRƯỚC, đỏ trên mã hiện tại, rồi sửa, rồi xanh, rồi commit một dòng tiếng Anh.

Chạm khoảng 30 tệp, ba package dùng chung (`@udp/http`, `@udp/cluster-access`, `@udp/config`), RBAC và admission của
cụm, bất biến bảo mật T12 ⇒ trên ngưỡng R2: ba vòng QA chạy lần lượt trên bản nháp.

**Nối tiếp (R3):** Plan #66. Giữ nguyên: `internalPortOnly`, cổng nội bộ 3101/3102, Service `internal-*`, hai
NetworkPolicy theo cổng và phép thử kẹp của chúng; `requireInternalCaller` và `X-Internal-Secret`; `platformProbeFromEnv`
cùng hành vi (chỉ dời phần dò cụm); 30+ tệp test dựng client bằng `secret` không phải đổi.

**Mốc lùi (R10):** đỉnh `b57ebcc`. Mỗi đợt một commit ⇒ `git revert`. Không đổi schema, migration. Lockfile đổi đúng
một chỗ: `flag-service` khai `@udp/cluster-access` (67d).

---

## 67a. Interface và middleware bên nhận

- **Làm gì:** `CallerVerifier { verify(token): Promise<string | null> }` (username hoặc `null`; ném khi không hỏi được)
  và `requireInternalIdentity({ verifier, callers })`: đọc `Authorization: Bearer`, so username với `callers`; thiếu,
  sai hay lạ ⇒ `UnauthenticatedError` cùng thông điệp với bí mật sai, log `warn` `{ reason, username }`; verifier ném ⇒ 503.
- **Ở đâu:** `packages/http/src/internal-caller.ts`, test `packages/http/tests/internal-identity.test.ts`.
- **Ai dùng:** `createApp` của Service 1 và Service 2 (67d).

## 67b. `TokenReview` và dò cụm

- **Làm gì:** subpath `@udp/cluster-access/in-cluster` (chỉ `node:fs`, `undici`, không import `@udp/http`):
  `inClusterApi(env)` trả `{ kind: "outside" } | { kind: "in-cluster", api }` (API server, CA, namespace, token đọc mỗi
  lần) - tách từ `platformProbeFromEnv`; `tokenReviewVerifier({ api, audience, ttlMs, staleMs, maxEntries })`: POST
  `/apis/authentication.k8s.io/v1/tokenreviews`, ba điều kiện của spec, nhớ dương theo sha256, gộp lời gọi đang bay,
  bản nhớ có trần khi API server lỗi.
- **Ở đâu:** `packages/cluster-access/src/in-cluster/{api.ts,token-review.ts,index.ts}`, `package.json` (`exports`),
  test cùng tên; `services/core-backend/src/core/platform-probe.ts` dùng `inClusterApi`.

## 67c. Cấu hình và bên gọi

- **Làm gì:** `INTERNAL_AUTH_MODE` (`secret` | `token-review`, mặc định `secret`; chuỗi rỗng = mặc định, theo quy ước
  `optionalSetting`), `INTERNAL_TOKEN_DIR` (tuỳ chọn, đường tuyệt đối). Luật production KHÔNG ở đợt này (QA vòng B: nó
  làm cổng env của cụm đỏ và cụm kind, vm sập tới khi manifest có ở 67e) - dời sang 67e. Hằng `INTERNAL_AUDIENCE`, `INTERNAL_CALLERS` ở
  `@udp/config/constants` (cổng `ci-entry-purity`). Bốn client nhận thêm `token?: () => Promise<string>` và gửi
  `Authorization: Bearer`; `internalTokenFrom(dir, target)` đọc tệp mỗi lời gọi, `assertInternalTokens(dir, targets)`
  đọc thử lúc khởi động - cả hai ở `@udp/http` (S1, S3 đều đã phụ thuộc). Đọc token nằm TRONG nhánh bắt lỗi của mỗi
  client (lỗi đọc tệp đi đúng đường lỗi mạng, `token-client.ts` không báo sai lý do HOLD). `test-support` ép
  `INTERNAL_AUTH_MODE=""` cho tiến trình con như cổng nội bộ.
- **Ở đâu:** `packages/config/src/{env-schema.ts,constants.ts}`, test `env-internal-auth.test.ts`; bốn client;
  `pd-controller/src/index.ts`, `core-backend/src/core/app-deps.ts` và `index.ts`; `.env.example`;
  `packages/test-support/src/service.ts`.

## 67d. Hai service

- **Làm gì:** `createApp(..., { internalPort, identity })` mount `requireInternalIdentity` ngay sau `internalPortOnly`
  khi có `identity` (độc lập với `internalPort`); `index.ts` dựng verifier khi `token-review`, ngoài cụm thì thoát. Test: `/healthz` trên cổng nội bộ
  vẫn 200 khi bật `identity` (hai listener thật - supertest không đo được cổng); route nội bộ không token ⇒ 401 trước
  khi parse body. Tệp: `services/{core-backend,flag-service}/tests/internal-identity.test.ts`.
- **Ở đâu:** `services/{core-backend,flag-service}/src/{app.ts,index.ts}`; `flag-service/package.json` +
  `pnpm-lock.yaml`; chú thích `flag-service/src/app.ts` (dòng "chua co TokenReview").

## 67e. Manifest, admission và phép thử trên cụm

- **Làm gì:**
  - Luật production của `@udp/config` (`token-review` và `INTERNAL_TOKEN_DIR` bắt buộc) cùng cổng đỏ-trước của nó: đây
    là commit đầu tiên cụm chạy `token-review`.
  - Nhãn Pod Security `baseline` ở `namespace.yaml`.
  - ServiceAccount `flag-service`, `pd-controller`; volume `projected` ở `core-backend` (đích Service 2) và
    `pd-controller` (hai đích); `automountServiceAccountToken: false` ở `pd-controller`; ConfigMap `INTERNAL_AUTH_MODE`,
    `INTERNAL_TOKEN_DIR`.
  - ClusterRole `udp-internal-token-review` và binding; sửa chú thích "CHỈ-ĐỌC" của `core-backend-rbac.yaml`.
  - `ValidatingAdmissionPolicy` `udp-internal-identity` + binding `Deny` (spec §2), cluster-scoped: kiểm kustomize không
    gắn `namespace` vào nó; cổng kiểm `operations` của từng subresource.
  - Cổng manifest theo SUBJECT (viết lại cổng "Service 1 chỉ đọc" của Plan #53), cổng VAP, cổng parse env thêm job
    `udp-migrate` (`effectiveEnv` của `deploy/tests/kustomize.ts` nhận cả Job); danh sách `clusterScoped` của
    `vm.test.ts`.
  - E2E năm nhóm của spec ở kind và máy ảo: tệp mới `deploy/e2e/internal-identity-probe.ts`, gọi từ
    `smoke.e2e.test.ts` và `vm.e2e.test.ts`. Pod thử dựng bằng `kubectl apply -f -`, đòi mã HTTP chính xác; phép ghi
    âm `--dry-run=server`; chú thích "401 (thiếu bí mật)" của Plan #66 trong `netpol-probe.ts` sửa theo lớp mới.
    `timeout-minutes` của job `kind`, `vm` trong `.github/workflows/ci.yml` nâng theo thời gian đo được.
  - `diagnose.ts` in ServiceAccount, ClusterRoleBinding, ValidatingAdmissionPolicy; một dòng ở `deploy/README.md` về
    chạy image ngoài cụm.
- **Ở đâu:** `deploy/k8s/base/*`, `deploy/tests/{manifests,vm}.test.ts`, `deploy/e2e/*`, `deploy/e2e-vm/vm.e2e.test.ts`,
  `deploy/src/diagnose.ts` (thêm ReplicaSet), `deploy/README.md`, `deploy/tests/kustomize.ts`, `.github/workflows/ci.yml`.

## 67f. Tài liệu

`docs/UDP_design.md`: §3.1 và §3.2 (cây thư mục: tên tệp thật thay `internal-auth.middleware.ts`,
`internal-auth.guard.ts`), §9 (ghi chú `/internal/*` và hai khối Internal - GIỮ NGUYÊN hai dòng tiêu đề khối, không
chèn dòng trống trong khối Service 1, cổng `internal-routes` đọc chúng), T12, §12.2 ("Hệ quả với ADR-06" và quyền của
SA trong cụm UDP), §13.5 (phép thử mới), §15.1, §16 (hàng "chưa có danh tính bên gọi" viết lại theo phần còn lại và
đánh đổi API server; hàng "Audit của Luồng 4" - vế TokenReview xong, còn ký người làm), D-P39 (ghi chú), D-P59 (gồm lệch
khỏi `system:auth-delegator`); chú thích `internal-caller.ts`, `platform-probe.ts`; bàn giao.

## Kiểm cuối (R9) và kiểm thoái cấp (R11)

`@udp/http`, `@udp/cluster-access`, `@udp/config`, `@udp/deploy` test; typecheck các package đó và ba service; eslint,
prettier theo tệp đổi; `design-lint` phần không cần database. CI: cả 8 job. Kiểm thoái cấp: dev và test chạy như cũ ở
chế độ `secret`; route công khai, probe, platform probe của Service 1, phép thử kẹp Plan #65 và #66, sao lưu và khôi
phục của máy ảo (rollout restart do người cài làm) không đổi.

## Giả định phải đo (R6)

1. API server của k3s và kind trả `status.audiences` khi request có `spec.audiences`.
2. Pod `automountServiceAccountToken: false` vẫn nhận volume `projected` với `serviceAccountToken`.
3. `ValidatingAdmissionPolicy` v1 có ở k3s `v1.36.4+k3s1` và image node của kind; biến `authorizer` dùng được.
4. Tên người yêu cầu khi controller tạo ReplicaSet, Pod, EndpointSlice và khi kubelet xin token chiếu, trên CẢ k3s và
   kind (QA vòng C đọc từ nguồn: dạng ServiceAccount của `kube-system`; đo lại trên cụm).
5. Người cài (`install.ts`) có `escalate` trên `clusterroles` ở cả hai cụm.
6. `kubectl exec` có đi qua admission với thao tác `CONNECT` trên `pods/exec` (policy chặn được).
7. API server của k3s ngừng bao lâu khi khởi động lại (đặt trần 60 giây có đủ không).
8. Mọi workload hiện có qua Pod Security `baseline` trên cụm thật (cảnh báo `warn` trước khi `enforce`).
9. Kind dùng image node nào (không ghim) - phiên bản Kubernetes có VAP v1.

## Ba vòng QA đã bẻ gì

- **A (thiết kế):** kẻ có quyền tạo pod trong `udp` dùng được SA `pd-controller` - `TokenReview` một mình chỉ xác nhận
  đúng cái tên đó ⇒ `ValidatingAdmissionPolicy` khoá ba SA, phép thử kẻ có quyền trong namespace; `flag-service` phải
  khai `@udp/cluster-access` ⇒ lockfile đổi, subpath nhẹ; `cluster-access` không được import `@udp/http`; cổng
  `internal-routes` đọc tiêu đề khối §9 và tên `\w*Router`; bảy chỗ thiết kế thiếu trong danh sách; cổng "Service 1 chỉ
  đọc" lọc theo tên ⇒ viết lại theo subject; luật production chạm job `udp-migrate` ⇒ schema chỉ kiểm chuỗi, bên gọi
  kiểm tệp lúc khởi động; ở Service 1 middleware đứng trước `requestLogger` ⇒ tự log; API server thành phụ thuộc đường
  dữ liệu ⇒ bản nhớ có trần khi nó vắng; phép thử dễ xanh giả (`wget` gộp mã, `kubectl run` không gắn được volume, bí
  mật qua argv).
- **B (mã và plan):** với `pods/exec`, `pods/attach`, TokenRequest thì `object` không phải Pod ⇒ so `request.name`; namespace
  không có Pod Security ⇒ pod `hostPath` đọc được token của `pd-controller` ⇒ `baseline`; luật production ở 67c làm CI
  đỏ ⇒ dời sang 67e; sửa ConfigMap `udp-config-*` thêm `NODE_OPTIONS` là chạy mã lạ dưới SA bên gọi ⇒ policy khoá
  ConfigMap và Secret được nạp; template không khai SA làm CEL lỗi và chặn sao lưu hằng đêm ⇒ `?.`/`orValue`; phép thử
  dương "không phải 401" xanh giả khi lớp danh tính trả 503 ⇒ mã chính xác; Role của danh tính thử thiếu verb ⇒ 403
  trước admission; `effectiveEnv` chỉ nhận Deployment; `z.enum` từ chối chuỗi rỗng; thời hạn job E2E.
- **C (đúng kỹ thuật, đối chiếu nguồn Kubernetes v1.35.0 và k3s):** pod SA `default` mang nhãn `core-backend` thành
  endpoint của Service nội bộ và hứng nguyên văn token chiếu cùng bí mật ⇒ policy buộc nhãn đi cùng SA, khoá năm Service
  và EndpointSlice; `kubectl set image pod/…` đổi mã giữ nguyên token ⇒ so image khi sửa Pod; thời gian từ chối sau khi
  xoá pod là khoảng 50 giây chứ không 10; `impersonate` và Secret token dài hạn cho danh tính API chứ không cho token
  `/internal` ⇒ viết hẹp khẳng định, chặn Secret token; Pod Security chỉ ở `udp` ⇒ ghi phần còn lại; `exec`, `create
token` không có dry-run. Đứng: ngữ nghĩa audience, kiểm UID pod, token chiếu khi tắt automount, VAP v1 và `CONNECT`
  trên cả hai cụm, `authorizer`, `?.`/`orValue`, người cài có `escalate`, mọi pod qua `baseline`.

## Lượt CI đầu (`39701859694`, `b5ee191`) - đỏ ở `kind` và `vm`, cùng một gốc

`request.subResource` và `request.name` VẮNG MẶT khỏi request khi rỗng; policy truy cập thẳng nên CEL báo "no such
key", và `failurePolicy: Fail` biến lỗi đó thành từ chối. Trên k3s, cert-manager không tạo được Secret `udp-tls-*`
(log của controller ghi nguyên văn); trên kind, pod của ba Deployment kịp tạo trước khi policy có hiệu lực, nhưng
job-controller không gỡ được finalizer của pod `udp-migrate` đã `Succeeded` nên Job không bao giờ hoàn thành. Kiểm
kiểu của policy (`status.typeChecking`) KHÔNG bắt được lỗi này - nó chỉ cảnh báo trường không có trong schema. Sửa:
hai biến `sub`, `requestName` đọc qua `request.?`; cổng manifest đòi mọi truy cập thẳng `request.<trường>` chỉ ở
`kind`, `operation`, `resource`, `userInfo` (đỏ trên policy cũ, xanh trên bản sửa).

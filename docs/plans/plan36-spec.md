# Plan #36 — CI/CD (6 tool) và Luồng 3 — deploy qua webhook (§8.3) — SPEC

Trạng thái: **v2, 26/09/2026** (v2: QĐ-1, QĐ-2, QĐ-4, QĐ-5, QĐ-6 chốt theo review bản nháp mã —
xem "Nhật ký v2" cuối tệp). Nguồn: §8.3 (Luồng 3), §5.2 (`CicdDomainAdapter`: `verifySignature`,
`parsePayload`, `renderPipelineTemplate`), §5.5 CI/CD, §2.2 (`DeploymentEvent`,
`Environment.autoDeploy`), §12.2 (`udp-workload`), sổ nợ `cicd-adapter`; tiền đề: Plan #35
(`udp-registry-pull`, `registry.oci`).

## 1. Mục tiêu

1. **Sáu adapter CI/CD:** GitHub Actions, GitLab CI, Jenkins, CircleCI, Tekton, Drone CI — hiện
   thực `CicdDomainAdapter` (bề mặt đã đóng băng): `verifySignature` so theo thời gian HẰNG,
   `parsePayload` ra `WebhookDeployEvent`, `renderPipelineTemplate` sinh pipeline Golden Path.
2. **Webhook `POST /webhooks/cicd/:projectId/:provider`**: thân THÔ (chữ ký tính trên byte gốc),
   secret webhook của project sinh khi bật domain, niêm phong (§4.3), hiện MỘT lần, xoay vòng có
   audit; chữ ký sai ⇒ 401 + ghi nhận; trùng `pipelineId` ⇒ 200 bỏ qua.
3. **Deploy (§8.3):** pipeline thành công ⇒ `DEPLOY_START` rồi áp image vào workload của ĐÚNG
   environment bằng `udp-workload` (chỉ image tag — không `spec.strategy`, không trạng thái
   rollout, I25), theo dõi có hạn chờ, quá hạn / CrashLoop ⇒ `rollout undo` + `DEPLOY_FAILURE` +
   `ROLLBACK`; environment `autoDeploy = false` ⇒ `DEPLOY_PENDING`, người có quyền duyệt trên
   Portal. Deploy ≠ release: flag vẫn tắt.
4. Trả nợ `cicd-adapter` (phép kiểm AST: `timingSafeEqual`, không `===` trên chữ ký).

## 2. Quyết định

- **QĐ-1 — Họ adapter thứ tư `CicdAdapter`:** phần cluster theo họ gốc của tool — Tekton, Jenkins,
  Drone là họ Helm (cài vào cluster); GitHub Actions, GitLab CI, CircleCI là họ SaaS (không cài
  gì, ghi ConfigMap kết nối). Ba phương thức CI/CD là hàm THUẦN khai cạnh spec — lớp nền bọc
  chúng thành `CicdDomainAdapter`. **v2:** họ "SaaS" của CI là lớp nền MÔ TẢ (gộp `RegistryAdapter`
  của Plan #35, mở `requires`), không phải `SaaSAdapter`: CI dịch vụ không gọi API nào lúc cài.
- **QĐ-2 — Secret webhook là của PROJECT, sinh bởi UDP** (32 byte ngẫu nhiên), không phải một
  trường `configSchema`: người dùng không chọn nó, chỉ dán nó vào CI. Lưu niêm phong trong
  `domain_configs` của domain CICD (trường riêng `webhook_secret`), trả về đúng MỘT lần lúc bật
  hay xoay; `POST /projects/:id/domains/CICD/webhook-secret` xoay vòng, audit.
- **QĐ-3 — Thứ tự xử lý webhook:** giới hạn kích thước thân (1 MiB) → tra project + domain CICD
  → `verifySignature` trên byte gốc → `parsePayload` → idempotent theo `(project, pipelineId,
environment)` → quyết định deploy. Chữ ký sai trả 401 KHÔNG phân biệt "project không có" với
  "chữ ký sai" (không làm oracle dò project).
- **QĐ-4 — Áp image là `patch` Deployment/Rollout đã có** (`workloadName` từ payload, namespace của
  environment): chỉ `spec.template.spec.containers[name].image` và `imagePullSecrets:
[udp-registry-pull]`. Workload chưa tồn tại ⇒ `DEPLOY_FAILURE` "workload chưa có" — tạo mới
  workload là việc của Golden Path/GitOps, không của webhook.
- **QĐ-5 — Theo dõi deploy là job trên hàng đợi RIÊNG `udp-deploy`** (pg-boss, `singletonKey` =
  `deploymentId`), KHÔNG phải một `ProvisioningJob`: deploy chạy mỗi lần push — là job hạ tầng thì
  nó ngập danh sách `/jobs`, và "project đang có job chạy" sẽ chặn lưu cấu hình domain. CI nhận
  202 ngay; job đọc trạng thái Deployment mỗi 10 giây tới `progressDeadlineSeconds` (mặc định 600,
  đặt vào chính Deployment — `Progressing=False/ProgressDeadlineExceeded` là tín hiệu thất bại, không
  cần quyền đọc pod mà §12.2 không cấp cho `udp-workload`). Idempotent ở event store: unique index
  một phần trên `(deployment_id, environment_id, event_type)` cho bốn loại sự kiện deploy (provisioning ghi một sự kiện MỖI environment cùng `deploymentId`) — hai worker không ghi
  hai lần SUCCESS.
- **QĐ-6 — Thân webhook là JSON CỦA UDP, chữ ký theo kiểu của từng nhà cung cấp** (đúng mẫu
  `.github/workflows/udp.yml` ở §11): bước cuối của pipeline mà `renderPipelineTemplate` sinh
  dựng body `{environment, status, commitSha, commitTimestamp, imageTag, workloadName,
pipelineId}` rồi ký ĐÚNG chuỗi byte gửi đi — GitHub `X-Hub-Signature-256: sha256=<hmac>`,
  GitLab `X-Gitlab-Token`, CircleCI `circleci-signature: v1=<hmac>`, Jenkins/Tekton/Drone
  `X-UDP-Signature: sha256=<hmac>`. Một bộ phân tích chung cho body; `verifySignature` là phần riêng
  của từng tool. `WebhookDeployEvent` bổ sung `pipelineId`, `status`, `commitTimestamp?`,
  `workloadName` mà §8.3 dùng nhưng kiểu thiếu (sửa §5.2, D-P27).

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | Sáu adapter qua đủ 42 phép + bộ phép CI/CD (chữ ký đúng/sai/độ dài lệch, payload mẫu thật của từng tool, template chứa `registryRef` và nhãn `ff`) |
| AC-2 | AST: mọi `verifySignature` gọi `timingSafeEqual`, không so chữ ký bằng `===`/`!==`; độ dài lệch ⇒ `false` không ném                                |
| AC-3 | Webhook: chữ ký sai ⇒ 401 + audit; trùng `pipelineId` ⇒ 200 không sự kiện mới; thân > 1 MiB ⇒ 413                                                  |
| AC-4 | Deploy thành công ⇒ START + SUCCESS cùng `deploymentId`; quá hạn ⇒ undo + FAILURE + ROLLBACK; `autoDeploy=false` ⇒ PENDING rồi duyệt               |
| AC-5 | Secret webhook: niêm phong, hiện một lần, xoay có audit; không lên dây ở GET                                                                       |
| AC-6 | Không thoái cấp; I25 (S1 không chạm `spec.strategy`)                                                                                               |

## 4. Nợ kiểm chứng

Webhook thật từ sáu CI (payload thật, IP nguồn) và rollout thật trên cluster: gộp `I32-cluster`;
mục mới `cicd-webhook-real` cho sáu nhà cung cấp. Trả `cicd-adapter`.

## Nhật ký v2 (review bản nháp mã, trước khi áp)

1. **QĐ-2:** secret sinh bằng `POST /projects/:id/domains/CICD/webhook-secret` (lần đầu = sinh, sau
   = xoay), không tự sinh lúc bật domain — "hiện một lần" cần một response trả cho người bấm, mà
   `PUT /domains` trả job. Chưa sinh ⇒ mọi webhook là 401. Thêm `GET …/CICD/webhook` (đường, đã
   sinh chưa) và `GET …/CICD/pipeline-template`.
2. **QĐ-4:** `ClusterAccess.patch` là JSON merge patch — nó THAY CẢ MẢNG. Bản nháp gửi
   `containers: [{name, image}]` sẽ xoá port, env, probe của container. Sửa: đọc workload, gửi lại
   NGUYÊN mảng chỉ đổi `image`, kèm `metadata.resourceVersion` (409 ⇒ đọc lại, thử lại). Workload
   là Deployment hoặc `Rollout` của Argo Rollouts (tra lần lượt); container phải cùng tên workload.
3. **QĐ-5:** id job pg-boss = `deploymentId` (gửi lại là không làm gì — cùng cách `udp-jobs`), không
   `singletonKey`. Hạn theo dõi đọc từ `progressDeadlineSeconds` CỦA workload (Kubernetes luôn
   điền, mặc định 600), trần 30 phút; S1 không ghi trường đó. Ảnh để hoàn tác: ảnh đang chạy trên
   cluster, hay (lượt thử lại, ảnh mới đã áp) ảnh của lần SUCCESS gần nhất cùng workload. FAILURE
   và ROLLBACK chung một transaction. Lượt cuối của pg-boss mà vẫn lỗi ⇒ FAILURE "không theo dõi
   được". Đối soát: START chưa kết luận mà pg-boss chưa từng nhận ⇒ gửi lại; pg-boss đã bỏ ⇒ FAILURE.
4. **QĐ-6:** thân `{environment, status, commitSha, commitTimestamp?, imageRef?, workloadName,
pipelineId, repo, ref, actor}` — `imageRef` đầy đủ thay `imageTag` (cột `image_tag` suy từ nó).
   Template gửi tới `$UDP_WEBHOOK_URL` là địa chỉ ĐẦY ĐỦ Portal hiện; `pipelineId` đổi theo lượt
   chạy lại (`run_id-run_attempt`, `CI_PIPELINE_ID-CI_JOB_ID`…). Chống trùng dưới advisory lock
   của `(environment, pipelineId)` — hai lần gửi lại đồng thời không thành hai deploy.

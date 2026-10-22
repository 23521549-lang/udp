# Plan #37 — Infrastructure IaC (7 tool) và Security Scanning (7 tool) — SPEC

Trạng thái: **v1, 26/09/2026**. Nguồn: §5.5 "Infrastructure IaC" (kèm lưu ý thiết kế v4: hai họ
adapter khác bản chất) và "Security Scanning"; §5.2 (`PipelineTemplateParams`), §5.3
(`CapabilityId`); tiền đề: Plan #36 (CI/CD, template pipeline Golden Path, lớp nền mô tả).

## 1. Mục tiêu

1. **Mười bốn adapter** qua đủ 42 phép của bộ hợp đồng:
   - IaC: Terraform, Pulumi, Crossplane, Ansible, AWS ACK, GCP Config Connector, Azure Service
     Operator (dòng gộp ba operator của §5.5 là BA tool).
   - Security: Trivy, Snyk, Aqua Security, Falco, Checkov, OWASP ZAP, Grype.
2. **Hai capability mới** `infra.provision` và `security.scan` (`CapabilityId` 15 ⇒ 17).
3. **Bước pipeline từ domain khác** — Terraform/Pulumi/Ansible và các máy quét chạy trong CI
   (Checkov, Grype, ZAP) góp bước vào template pipeline mà CI/CD adapter sinh (§5.5 "sinh bước
   pipeline … cho CI/CD adapter đang bật").

## 2. Quyết định

- **QĐ-1 — Hai họ theo NƠI chạy, không theo domain.** Chạy trong cluster ⇒ họ Helm: Crossplane,
  ACK, Config Connector, ASO; Trivy (`trivy-operator`), Snyk (`snyk-monitor`), Aqua
  (`kube-enforcer`), Falco. Chạy trong CI ⇒ họ **bước pipeline** trên lớp nền mô tả: Terraform,
  Pulumi, Ansible, Checkov, Grype, ZAP — không cài gì vào cluster, ConfigMap mô tả là đích drift,
  `requires: pipeline.trigger` (không có CI thì bước không có chỗ chạy — validator chặn lúc lưu).
- **QĐ-2 — `pipelineSteps` là export có tên** cạnh export mặc định (cùng cách `metricsSource`,
  `pullCredential`): `(config) => PipelineStep[]`; registry kiểm lúc nạp — adapter xuất nó phải
  `requires: pipeline.trigger`, và ngược lại adapter họ bước pipeline phải xuất nó. Không thêm
  phương thức vào `DomainAdapter` (bề mặt đã đóng băng).
- **QĐ-3 — `PipelineTemplateParams.steps`** (sửa §5.2, **D-P28**): `PipelineStep = { tool, name,
phase: "before-build" | "after-build", image, commands, env, secretEnv }`. `env` là giá trị công
  khai; `secretEnv` chỉ là TÊN biến bí mật của CI (UDP không bao giờ đặt giá trị bí mật vào
  template). Sáu CI adapter dựng bước theo cú pháp của mình, theo thứ tự `phase` rồi theo `tool`.
  Bước hỏng làm pipeline hỏng ⇒ bước "báo UDP" gửi `status: failure` (đường đã có của Plan #36).
- **QĐ-4 — State của Terraform/Pulumi do UDP CẤU HÌNH, bucket do khách chọn.** Cấu hình mang
  loại backend (`s3` | `gcs` | `azurerm`) và tên bucket/container; UDP dựng khối backend với khoá
  `udp/<project>/<environment>` (một state mỗi environment) và khoá chống ghi đồng thời của chính
  backend (S3 `use_lockfile`, GCS và Azure Blob có sẵn). Pulumi dùng backend tự quản
  (`s3://`, `gs://`, `azblob://`), passphrase là biến bí mật của CI. Ansible không có state.
- **QĐ-5 — Operator của cloud chỉ chạy trên đúng cloud, và điều đó bị chặn lúc LƯU.** ACK cần
  EKS + IRSA, Config Connector cần GKE + Workload Identity, ASO cần AKS + Workload Identity.
  Adapter khai `cloud` bằng export có tên (`"AWS" | "GCP" | "AZURE"`, registry kiểm lúc nạp);
  kiểm trạng thái đích của project (`POST /domains/validate`, `PUT /domains`) so nó với cloud của
  credential đang dùng ⇒ lỗi `CLOUD_MISMATCH` (422, có thông điệp tiếng Việt — I37). Không suy
  cloud từ hình của region: `cloudRegionSchema` là MỘT luật chung cho cả ba cloud (bản nháp v0 của
  spec giả định sai điều này). Định danh (role ARN, service account GCP, client ID Azure) là cấu
  hình công khai, không phải bí mật — không có khoá tĩnh nào.
- **QĐ-6 — Config Connector không có Helm chart chính thức** (Google phát hành bundle operator và
  add-on GKE). Adapter đi họ Helm với nguồn cài khai TƯỜNG MINH: `HelmChartRef.installer =
"manifest-bundle"` (bản ghi nói bộ cài áp bundle bằng `kubectl apply`, không giả làm Helm).
  ConfigConnector chạy chế độ `cluster` với service account GCP của cấu hình.
- **QĐ-7 — ASO cần cert-manager**: release đi kèm `cert-manager` của jetstack khai `before: true` và
  `shared: true` (v1.1: một định nghĩa ở `adapter-base/cert-manager.ts` cho mọi operator cần nó —
  K8ssandra ở Plan #38 cũng cần; tắt một domain không gỡ nó)
  (áp TRƯỚC release chính, gỡ SAU nó — mở rộng nhỏ của lớp nền Helm), riêng của ASO; một domain sau này cần cert-manager thì nó thành capability.
- **QĐ-8 — `infra.provision@1`** mang `attributes.provider` và `attributes.mode` (`operator` |
  `pipeline`); không exclusive (Crossplane cho app, Terraform cho nền móng là tổ hợp thật).
  **`security.scan@1`** mang `provider`, `mode` và `kinds` (`image` | `iac` | `runtime` | `dast` |
  `dependencies`); không exclusive.
- **QĐ-9 — ZAP là DAST trên environment ĐANG chạy**: cấu hình mang URL mục tiêu mỗi environment;
  bước `after-build` quét bản đang phục vụ ở đó (deploy là bất đồng bộ, pipeline không chờ nó).
  Nói thẳng trong ghi chú template.

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | 14 adapter qua đủ 42 phép; E1 relaxations vẫn 0                                                                                         |
| AC-2 | `CAPABILITY_IDS` 17, tài liệu §5.3 khớp mã; validator: adapter bước pipeline thiếu CI ⇒ `MISSING_CAPABILITY`                            |
| AC-3 | Registry: `pipelineSteps` sai chỗ hay thiếu ⇒ adapter bị từ chối lúc nạp                                                                |
| AC-4 | Template của MỌI CI adapter chứa bước của mọi tool đang bật, đúng pha, không một giá trị bí mật; backend state có khoá theo environment |
| AC-5 | Operator cloud trên project của cloud khác ⇒ 422 `CLOUD_MISMATCH` lúc kiểm/lưu, không job nào được tạo                                  |
| AC-6 | Không thoái cấp: cổng S1 đầy đủ, Portal, design-lint                                                                                    |

## 4. Nợ kiểm chứng

Chạy thật (operator trên EKS/GKE/AKS, `terraform apply` qua pipeline thật, máy quét trên image
thật): gộp `helm-real`, `cicd-webhook-real`; mục mới `iac-security-real`.

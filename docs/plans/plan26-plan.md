# Plan #26 — PLAN

Đi kèm `plan26-spec.md` (v2). Mỗi pha: làm gì, ở đâu, cổng đóng pha. Pha sau chỉ bắt đầu
khi cổng của pha trước xanh và đã commit.

## P1 — Lõi `@udp/cloud-adapters` và cổng mô phỏng

| Làm gì                                                                                                                                                                                                                                                                                                                                          | Ở đâu                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Package mới, `exports`: `.`, `./aws`, `./gcp`, `./azure`, `./testing`; phụ thuộc `@udp/adapter-core`, `@udp/shared-types`, `@udp/config`, `zod`; KHÔNG `@udp/db`                                                                                                                                                                                | `packages/cloud-adapters/`    |
| `GatewayError` (lớp lỗi đã làm sạch: `class` ∈ not-found/throttled/transient/dependency/permanent/permission/separate-tagging, `message` an toàn) và `classify(err, rules)` — KHÔNG giữ `cause` gốc                                                                                                                                             | `src/core/gateway.ts`         |
| `CloudGateway` (port trung tính, spec QĐ-2)                                                                                                                                                                                                                                                                                                     | `src/core/gateway.ts`         |
| `ProviderPlan`: `StepSpec {name, kind, step, dependsOn[], spec}`, `TagCodec`, `requiredPermissions`, `pricing`, `nodeSizes`, `docUrl`, `kindsWithoutCreateTags`                                                                                                                                                                                 | `src/core/plan.ts`            |
| `createPlannedAdapter(plan, gatewayFor)` — 10 phương thức: lookup ba trạng thái (tag rồi dự phòng theo tên), retry có giới hạn cho throttled/transient, `NOT_FOUND` ở delete = thành công, teardown chín bậc bằng `runTeardown` của adapter-core, `rebuildLedgerFromCloud` hai đường (tag + tên tất định), `listTaggedResources` lỗi ⇒ `FAILED` | `src/core/planned-adapter.ts` |
| `createSimGateway(cloud, codec, label)` trên `SimCloud`: mã hoá → kiểm hợp lệ → giải mã ở biên, map `SimCloudError` ⇒ `GatewayError`                                                                                                                                                                                                            | `src/testing/sim-gateway.ts`  |
| Cổng: bộ hợp đồng Cloud chạy với một kế hoạch tối thiểu dùng chung (đối chứng rằng lõi thay được adapter mô phỏng)                                                                                                                                                                                                                              | `tests/core-contract.test.ts` |

Ràng buộc rút ra từ review plan: lõi KHÔNG tự retry trong `create`/`lookup` (bộ hợp đồng
đếm số lời gọi cloud qua `CloudControl.calls()`; retry là việc của runner), và teardown đi
qua `runTeardown` với cổng `TeardownCloud` — một thứ tự chín bậc, không hai.

**Cổng P1:** 42/38 phép hợp đồng xanh trên lõi; quét sentinel (lỗi không mang credential) xanh;
`package-boundaries` xanh (không `@udp/db`); typecheck/lint.

## P2 — AWS

| Làm gì                                                                                                                                                                                                                                                  | Ở đâu                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Kế hoạch EKS: NETWORK (vpc, subnet×2, internet-gateway, elastic-ip, nat-gateway, route-table×2, security-group), CLUSTER (iam-role×2, cluster, oidc-provider, nodegroup); `nodeSizes` small/medium/large = t3.large/t3.xlarge/m5.2xlarge; bảng giá tĩnh | `src/aws/plan.ts`           |
| Codec tag AWS (nguyên văn, kiểm độ dài 128/256)                                                                                                                                                                                                         | `src/aws/tags.ts`           |
| Cổng AWS: EC2/EKS/IAM/STS/Tagging qua SDK v3; phân loại lỗi theo `name`/`$metadata.httpStatusCode`; `checkPermissions` = SimulatePrincipalPolicy (exact) rồi dự phòng DryRun (heuristic); `kubeToken` = presigned STS GetCallerIdentity (k8s-aws-v1)    | `src/aws/gateway.ts`        |
| `CredentialExchange` AWS: AWS_ROLE (AssumeRole + ExternalId), AWS_KEY                                                                                                                                                                                   | `src/aws/credentials.ts`    |
| Fixture viết tay + bộ hợp đồng trên cổng mô phỏng                                                                                                                                                                                                       | `tests/aws/*.test.ts`       |
| Test cổng AWS: client SDK giả ở tầng command (`send`) — mỗi thao tác đúng command, đúng tham số, lỗi phân loại đúng, không rò credential                                                                                                                | `tests/aws/gateway.test.ts` |

**Cổng P2:** hợp đồng 38/38; test cổng; ghi sổ nợ `cloud-aws-live`.

## P3 — GCP

Như P2 với GKE: NETWORK (vpc, subnet, firewall-rule, cloud-router, nat-gateway như cấu hình
NAT trên router), CLUSTER (service-account, cluster, nodegroup = node pool); codec label
(QĐ-4) có test đi-về cho mọi kind; cổng REST (Compute, Container, IAM, Resource Manager
`testIamPermissions`) qua token của `google-auth-library`; `CredentialExchange` GCP_WIF /
GCP_KEY. **Cổng P3:** như P2 + test đi-về codec; sổ nợ `cloud-gcp-live`.

## P4 — Azure

AKS trong resource group của khách: NETWORK (nsg, vpc = VNet, subnet, elastic-ip = Public
IP, nat-gateway), CLUSTER (managed-identity, cluster, nodegroup = agent pool); cổng ARM REST
qua token của `@azure/identity`; `checkPermissions` = Permissions-List-For-Resource-Group +
khớp wildcard phía client (heuristic); `CredentialExchange` AZURE_FEDERATED / AZURE_SECRET.
**Cổng P4:** như P2; sổ nợ `cloud-azure-live`.

## P5 — UDP là OIDC issuer (Service 1)

`/.well-known/openid-configuration`, `/oidc/jwks` (công khai, ngoài `/api/v1`, không CSRF);
ký RS256 `UDP_OIDC_SIGNING_KEY`, `UDP_OIDC_ISSUER` (tuỳ chọn, cùng có hoặc cùng không —
guard ở `env.ts`); hàm `issueFederationToken(projectId, audience)`. **Cổng:** test thuần
(ký ⇒ kiểm bằng JWKS công bố), test tích hợp hai endpoint, cổng env.

## P6 — Credential Manager + endpoint (Service 1)

| Làm gì                                                                                        | Ở đâu                                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Schema payload theo `authKind` (zod, `.strict()`), schema body `PUT /cloud`                   | `modules/cloud/cloud.types.ts`                              |
| Ghi: mã hoá, fingerprint, một credential active mỗi project, audit chỉ metadata               | `modules/cloud/cloud.repository.ts`, `cloud.service.ts`     |
| Đọc: resolver giải mã → `CredentialExchange` → `ResolvedCredential`; buffer giải mã `fill(0)` | `modules/credential/credential.resolver.ts`                 |
| Registry adapter tiêm qua `createApp({ cloudAdapters })`; mặc định dựng ba adapter thật       | `core/app-deps.ts`                                          |
| Năm route + schema dây + mẫu golden                                                           | `modules/cloud/cloud.controller.ts`, `shared-types/wire.ts` |

**Cổng P6:** test tích hợp (AC-6, AC-7), quét sentinel DB/log, golden, I10.

## P7 — Portal

Bước 2 của wizard (sau khi tạo project: chọn cloud → cơ chế → dữ liệu setup có nút copy →
nhập → lưu → validate → preflight) và thẻ "Cloud" trong Cài đặt. **Cổng:** test Portal với
mẫu golden, I38, design-lint, build.

## P8 — Đóng plan

`docs/UDP_design.md` §10.15 thêm D-P cho những chỗ lệch; sổ nợ: trả `portal-cloud-step`,
thêm ba mục `cloud-*-live`; cập nhật `cred-federation`; bàn giao.

## Rủi ro thực thi

- RAM máy 7,7 GiB: pha nào chạy test tích hợp thì chạy từng tệp, không song song.
- Cài SDK: kiểm dung lượng; ghim chính xác phiên bản như Portal.

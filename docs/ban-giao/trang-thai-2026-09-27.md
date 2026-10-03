# Bàn giao cuối — UDP, 27/09/2026

Tài liệu này đọc được mà không cần phiên làm việc nào. Nó thay `trang-thai-2026-09-25.md` và
`dang-do-2026-09-25.md` ở vai "điểm bắt đầu cho người tiếp theo"; hai tệp đó vẫn giữ nhật ký chi
tiết từng plan. Nguồn sự thật của thiết kế là `docs/UDP_design.md`; của phép đo là
`docs/measurements/` (số thô trong `raw/`, nợ trong `kiem-chung-con-no.md`).

## 1. Đã làm — theo nhóm

| Nhóm             | Plan    | Nội dung                                                                                                                                                                                                                                                           | Commit tiêu biểu                                 |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Nền              | #1–#12  | Monorepo pnpm; auth (CSRF, rate limit, xoay refresh token); schema v4 trên Supabase (Prisma 7); ma trận writer theo role DB có chốt lúc boot; project, thành viên, audit, RBAC; Service 2 với outbox ADR-05, change feed ba tầng, SSE cho SDK                      | `354fcee`, `56f2438`, `2a9cb35`                  |
| Rollout          | #13–#23 | Service 3: reconciler có lease/fencing, canary FLAG_LEVEL, probe hai pha, kill-switch I30(a); tạo rollout ở S1; OFREP + OpenFeature provider; sample-app; phép đo E3/E4/E14/I34; vòng đời flag, telemetry, segment, SDK key                                        | `da0ba9c`, `f39055a`, `6af4709`, `b8a40ed`       |
| Khung adapter    | #14–#24 | `adapter-core` (hợp đồng cloud/domain/cluster/ledger), runner 14 bất biến, lưới khôi phục hai tầng, `ClusterAccess` theo identity, mã hoá credential, capability resolver + oracle độc lập, registry tự phát hiện, tag `adapter-interface-v1`, day-2 drift/upgrade | `b5ee419`, `879e18f`, `abaecef`, `ce96a9f`       |
| Portal           | #25     | SPA trên hợp đồng dây (golden capture), mọi màn hình §10.14 có endpoint                                                                                                                                                                                            | `1f6b8cb`, `78332b8`                             |
| Hạ tầng thật     | #26–#30 | Cloud adapter AWS/GCP/Azure, UDP là OIDC issuer; catalog + drift; hàng đợi pg-boss, provisioning đầu–cuối, teardown, TTL/orphan/drift scan; áp domain cho project đang chạy                                                                                        | `124b086`…`134dde8`, `077c574`                   |
| 72 tool của §5.5 | #31–#38 | Monitoring, Tracing, Logging, Service Mesh, Ingress, Progressive Delivery, GitOps, Policy, Secrets, Container/Artifact Registry, CI/CD (+ Luồng 3 webhook deploy), IaC, Security, Database, Cost — **72/72**, mỗi adapter qua 42 phép hợp đồng, 0 nới lỏng         | `a24b660` … `0739258`                            |
| Hoàn thiện       | #39–#42 | S1 đo metrics thay S3 (D-P30); vòng đời environment + job `ENVIRONMENT_APPLY` (D-P31); SSE cấu hình + phân trang (D-P32); báo cáo E1/E8, route JSON đủ schema                                                                                                      | `cc56437`, `4b8cf92`, `56d2386`, commit Plan #42 |

## 2. Bất biến → nơi cưỡng chế

Bất biến đánh số (I1…I40) ở §13.3 của thiết kế, mỗi dòng nêu phép kiểm. Chốt cấu trúc sống ở
`packages/design-lint/tests/` (24 tệp) — chạy không cần database, đỏ là build đỏ:

| Cổng design-lint                                       | Canh điều gì                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `internal-routes`                                      | Route `/internal/*` của S1 và S2 khớp §9, mục chưa hiện thực phải khai                               |
| `project-route-guard`                                  | Mọi route dưới `/projects/:id` có `requireMinProjectRole` (I10)                                      |
| `adapter-interface-freeze`                             | Bề mặt `CloudAdapter`/`DomainAdapter`/`CicdDomainAdapter` khớp tài liệu (tag `adapter-interface-v1`) |
| `oracle-independence`                                  | Oracle không import resolver, và được viết TRƯỚC resolver                                            |
| `debt-ledger`, `ledger-row-conformance`                | Sổ nợ đủ sáu trường mỗi mục, số mục khai khớp số mục đếm                                             |
| `writer-matrix`, `schema-conformance`, `enum-mirrors`  | Ai được ghi bảng/cột nào; schema và enum khớp §2.2                                                   |
| `package-boundaries`, `type-debt`                      | Ranh giới package, không vòng; nợ kiểu (`as unknown as`) có trần                                     |
| `cicd-signature`, `drift-readonly`, `cluster-identity` | So chữ ký hằng thời gian; quét drift không ghi (I32-c); ba SA §12.2                                  |
| `references`, `constant-relations`, `retention`, …     | Tham chiếu trong tài liệu tồn tại; quan hệ giữa hằng số; thời hạn lưu                                |

Trong mã ứng dụng, các chốt đáng nhớ nhất: `wire-golden.test.ts` (mọi route JSON có schema
`.strict()` + mẫu thật + đủ theo mã), `i38-query-keys.test.ts` (key phạm vi env chứa `envId`),
contract suite 42 phép của mỗi adapter, lưới khôi phục `grid-tier1`/`grid-tier2`.

## 3. Còn nợ — 39 mục, đều cần hạ tầng hoặc người thật

Chi tiết từng mục (vì sao, tiền đề, lệnh, đạt/không đạt): `docs/measurements/kiem-chung-con-no.md`.
Theo thứ cần có:

| Cần có                         | Mục                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cluster Kubernetes (kind/k3d)  | `I32-cluster`, `clusteraccess-direct`, `helm-real`, `I24-cluster`, `I25-cluster`, `I34-cluster`, `E16`, `quota-lb-webhook`, `agent-mode`, `cicd-webhook-real`, `db-cost-real`, `portal-rollout-create` |
| Tài khoản cloud thật           | `I31-aws`, `I31-gcp`, `I31-azure`, `E15`, `preflight-confidence`, `getkubeauth-that`, `k8s-managed-discovery`, `estimatecost-vs-bill`, `cred-federation`, `iac-security-real`                          |
| Tài khoản SaaS dùng thử        | `saas-metrics-real`, `saas-logs-real`                                                                                                                                                                  |
| Runner CI cùng vùng database   | `E4-ci`, `E4-segment`, `stale-perf`, `segment-cap-perf`, `portal-pagination`                                                                                                                           |
| Máy rảnh / Prometheus / Docker | `E3-quiet`, `E3-stats`, `E5`, `E6`, `E14-prometheus`, `I31-localstack`, `upgrade-rollback-that`                                                                                                        |
| Trình duyệt thật, người thật   | `portal-e2e`, `portal-responsive`, `portal-dx`                                                                                                                                                         |

Không còn mục nào chỉ cần viết mã: `portal-response-schema` là mục cuối loại đó, đã trả ở Plan #42.

## 4. Chạy các cổng trên máy ít RAM (~0,7 GiB trống)

Máy đo có 7,7 GiB RAM nhưng thường chỉ trống dưới 1 GiB; một lượt `pnpm test` đầy đủ bị hệ điều
hành dừng. Chạy theo lô ở TIỀN CẢNH, mỗi lô dưới 10 phút, không chạy hai tiến trình vitest cùng lúc:

1. **Service 1** (`services/core-backend`, `fileParallelism: false`):
   - `src/**/*.test.ts` (72 bộ hợp đồng adapter) — một lô, ~45 giây;
   - `tests/*.test.ts` trừ hai tệp dưới — năm lô 7–17 tệp;
   - `provision-job.integration.test.ts` — hai lô bằng `-t "^(job PROVISION|job TEARDOWN|lịch orphan)"`
     và `-t "^(job DOMAIN_APPLY|job ENVIRONMENT_APPLY|HTTP|bí mật|khoá kéo)"`;
   - `grid-tier2.test.ts` — CẢ TỆP một lượt (~10 phút, ba phép meta cần cả tệp), chạy nền và
     không chạy gì khác cùng lúc.
2. **Service 2**: hai lô 19 tệp (~5–6 phút mỗi lô). **Service 3**: một lượt (~3 phút).
3. **Portal**: `vitest run` ba lô (`admin-deploy`…`i38`; `overview-deploy`…`provisioning`; `rollout`…
   `variants`; lô lớn hơn đỏ ô đầu của vài tệp vì hết hạn chờ khi nhiều worker jsdom chạy song song —
   Plan #44, #46) + `vite build`.
   **design-lint**, `shared-types`, `http`, `config`, `adapter-core`, `experiments`: mỗi package một lượt.
4. `eslint` và `prettier --check` CHỈ trên tệp đã đổi — `prettier --write` cả thư mục `tests/` gây
   thay đổi định dạng không liên quan.
5. Mẫu golden: xoá đúng tệp cần ghi lại rồi `UDP_CAPTURE_WIRE=1` chạy tệp test sinh ra nó; hoàn
   nguyên mọi mẫu khác bị ghi đè ngoài ý muốn.

Commit chỉ ở máy; người dùng tự đẩy lên GitHub. Không đọc hay commit `.env*`.

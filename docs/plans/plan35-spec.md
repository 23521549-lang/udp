# Plan #35 — Container Registry (6), Artifact & Package Registry (3) — SPEC

Trạng thái: **v1, 26/09/2026 — XONG**. Nguồn: §5.5 Container Registry (Tier 1) và Artifact & Package
Registry (Tier 3), §5.3 (`registry.oci`), §8.3 (`PipelineTemplateParams.registryRef`), §12.2
(quyền của ba ServiceAccount), Plan #31 (bí mật của tool).

## 1. Mục tiêu

1. **Container Registry:** AWS ECR, GCP Artifact Registry, Azure Container Registry, Docker Hub,
   GHCR, Harbor — `provides: registry.oci`.
2. **Artifact & Package Registry:** JFrog Artifactory, Nexus Repository, GitHub Packages —
   `provides: packages.store` (capability MỚI — đúng một tệp ngoài thư mục adapter, C2) và
   `registry.oci` (cả ba phục vụ được image OCI).
3. **Kéo image riêng tư từ cluster** mà không nới §12.2 thành "secrets ở mọi namespace".
4. Mỗi adapter qua đủ 42 phép, 0 nới lỏng.

## 2. Quyết định

- **QĐ-1 — Registry của cloud kéo bằng định danh của node:** ECR/Artifact Registry/ACR cùng cloud
  với cluster dùng quyền của node (Cloud Adapter gắn khi dựng nodegroup); token ECR hết hạn sau
  12 giờ nên một pull secret tĩnh là sai về bản chất. Adapter chỉ khai binding (+ ConfigMap mô
  tả), không bí mật nào vào cluster.
- **QĐ-2 — Registry cần khoá để kéo (Docker Hub, GHCR, Harbor riêng tư, Artifactory, Nexus,
  GitHub Packages) dùng MỘT Secret có tên cố định mỗi namespace environment:**
  `udp-registry-pull` (`kubernetes.io/dockerconfigjson`). Bootstrap (token admin, lúc
  CLUSTER_ACCESS) tạo nó RỖNG; `udp-tooling` chỉ được `get`/`update`/`patch` đúng tên đó
  (`resourceNames`) ở namespace environment — không `create`, `list`, `watch`, `delete`, không
  Secret nào khác. Bộ kiểm RBAC mở đúng ngoại lệ này và vẫn đỏ với mọi dạng rộng hơn (sửa §12.2,
  D-P26). Luồng deploy §8.3 (Plan #36) luôn gắn `imagePullSecrets: [udp-registry-pull]`.
- **QĐ-3 — Adapter khai CÁCH tạo khoá kéo, nền tảng PHÂN PHỐI nó.** Adapter registry nào cần
  khoá xuất `pullCredential(config) → { server, username, password } | null` cạnh export mặc
  định (cùng kiểu `metricsSource` của Plan #31; registry kiểm hình lúc nạp). Pha DOMAINS (và job
  `DOMAIN_APPLY`) — sau khi provider `registry.oci` đã chọn deploy xong — dựng
  `.dockerconfigjson` từ cấu hình ĐÃ MỞ bí mật và patch `udp-registry-pull` của MỌI environment
  bằng `udp-tooling`; tắt hay đổi registry ⇒ trả về rỗng. Lý do tách: adapter họ Helm (Harbor,
  Artifactory, Nexus) là cluster-scoped và bộ hợp đồng (d7) cấm nó chạm namespace environment;
  một cơ chế cho mọi registry thay vì hai. Quét drift so `udp-registry-pull` với khoá mong muốn
  bằng băm, chi tiết không in giá trị.
- **QĐ-3b — Lớp nền thứ ba `RegistryAdapter`** cho registry dịch vụ (ECR, Artifact Registry, ACR,
  Docker Hub, GHCR, GitHub Packages): cluster-scoped, không cài gì, ghi ConfigMap mô tả registry
  trong `udp-system` (đích của drift) và trả binding `registry.oci`. Harbor, Artifactory, Nexus tự
  lưu trữ đi họ Helm.
- **QĐ-4 — `packages.store@1` mang `attributes.formats`** (`npm,maven,pypi,helm,…`) — CI/CD
  (Plan #36) `recommends` nó để phát hành thư viện.
- **QĐ-5 — Khoá kéo là bí mật của tool** (Plan #31): niêm phong ở UDP, chỉ ghi ra
  `udp-registry-pull` dưới dạng `.dockerconfigjson`; drift so băm, không in giá trị.

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | Chín adapter qua đủ 42 phép, 0 nới lỏng                                                                                                      |
| AC-2 | Bootstrap tạo `udp-registry-pull` rỗng ở mọi namespace env; RBAC: `get/update/patch` + `resourceNames` hợp lệ, `create`/`list`/tên khác ⇒ đỏ |
| AC-3 | Docker Hub/GHCR: khoá chỉ trong `udp-registry-pull` (dockerconfigjson); ECR/AR/ACR: không Secret nào được ghi                                |
| AC-4 | `packages.store` có trong union `CapabilityId` và validator; Artifactory/Nexus/GitHub Packages cung cấp cả hai capability                    |
| AC-5 | Không thoái cấp                                                                                                                              |

## 4. Nợ kiểm chứng

Kéo image thật từ từng registry: gộp vào `I32-cluster` (cluster thật) và `I31-*` (quyền node
của từng cloud). Harbor/Artifactory/Nexus thật: `helm-real`.

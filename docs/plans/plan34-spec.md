# Plan #34 — GitOps (2), Policy (2), Secrets Management (6) — SPEC

Trạng thái: **v1, 26/09/2026 — XONG**. Nguồn: §5.5 GitOps / Policy & Governance / Secrets Management,
§5.3 (`gitops.sync` EXCLUSIVE, `policy.admission`, `secrets.store`), §12.2 (namespace của
`udp-system`), Plan #31 (bí mật của tool), Plan #32 (`companions`, `readsSecretValues`).

## 1. Mục tiêu

1. **GitOps:** Argo CD, Flux CD — `provides: gitops.sync` (EXCLUSIVE); mỗi tool đồng bộ MỘT
   repo Git của project (URL, nhánh, đường dẫn), token là bí mật của tool.
2. **Policy:** OPA Gatekeeper, Kyverno — `provides: policy.admission`; mức Pod Security mặc
   định và chế độ Audit/Enforce là cấu hình.
3. **Secrets:** HashiCorp Vault, Sealed Secrets, AWS Secrets Manager, GCP Secret Manager, Azure
   Key Vault, External Secrets Operator — `provides: secrets.store`.
4. Mỗi adapter qua đủ 42 phép, 0 nới lỏng.

## 2. Quyết định

- **QĐ-1 — Policy không bao giờ chặn chính UDP:** cả hai adapter policy miễn trừ
  `udp-system` và `kube-system` ở tầng webhook (không phải từng policy) — một policy "không
  chạy root" áp lên controller mà UDP cài là tự khoá đường cài đặt của chính nền tảng.
- **QĐ-2 — Binding `secrets.store` mang `attributes.provider`** (`vault`, `sealed-secrets`,
  `aws`, `gcp`, `azure`, `external-secrets`) và khi có, `attributes.address` — workload và
  adapter khác (ví dụ CI/CD ở Plan #36) biết lấy bí mật bằng cơ chế nào.
- **QĐ-3 — Ba kho của cloud đi Secrets Store CSI Driver + provider của cloud**, định danh qua
  workload identity của chính cloud đó (IRSA role ARN, GCP service account, Azure client id) —
  không khoá tĩnh nào trong cluster. Driver là release chính, provider là release đi kèm
  (Azure: chart của Azure đã gồm driver).
- **QĐ-4 — Vault init/unseal là việc của người vận hành:** adapter cài Vault standalone + Raft
  trên PVC, injector và CSI provider; không giữ unseal key (giữ nó là giữ chìa khoá của mọi bí
  mật khách). Healthcheck báo release, không báo "đã unseal" — ghi rõ trong mô tả tool.
- **QĐ-5 — Flux GitOps là `flux2` + `flux2-sync`:** release đi kèm tạo `GitRepository` +
  `Kustomization` cho repo của project, đọc token qua `readsSecretValues`. Cơ chế cài của UDP là
  `helm upgrade --install` (§5.2) — độc lập với Flux; đối tượng `HelmRelease` trong mô hình mô
  phỏng chỉ là bản ghi của release.
- **QĐ-6 — URL repo Git chỉ nhận `https://`** — `ssh://` cần known_hosts và khoá riêng, là cấu
  hình khác hẳn; `http://` là gửi token qua kênh trần.

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | Mười adapter qua đủ 42 phép, 0 nới lỏng                                                                                      |
| AC-2 | Hai provider `gitops.sync` trong một tổ hợp ⇒ `CONFLICT` (exclusive) — chốt ở validator, không chỉ nhờ "mỗi domain một tool" |
| AC-3 | Gatekeeper, Kyverno: `udp-system` và `kube-system` có trong danh sách miễn trừ của webhook                                   |
| AC-4 | Token Git, token Vault (nếu có) chỉ trong `Secret`; binding `secrets.store` nói provider                                     |
| AC-5 | Không thoái cấp                                                                                                              |

## 4. Nợ kiểm chứng

Controller thật trên cluster: `helm-real` / `I32-cluster`. Kho bí mật của ba cloud qua workload
identity thật: gộp vào `cred-federation` (cùng cơ chế federation đã ghi nợ).

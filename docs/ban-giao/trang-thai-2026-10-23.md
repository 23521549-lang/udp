# Bàn giao - UDP, 23/10/2026

Tài liệu này đọc được mà không cần phiên làm việc nào. Nó thay `trang-thai-2026-10-22.md` ở vai "điểm bắt đầu cho
người tiếp theo"; tệp đó giữ nguyên phần Plan #66. Nguồn sự thật của thiết kế là `docs/UDP_design.md`; của phép đo là
`docs/measurements/` (nợ trong `kiem-chung-con-no.md`); của từng plan là `docs/plans/`.

**Trạng thái một câu:** Plan #67 (nhánh `p67-token-review`, PR #4) thêm lớp ứng dụng của T12: bên gọi `/internal/*`
gửi token chiếu của ServiceAccount riêng, bên nhận hỏi `TokenReview`, và ValidatingAdmissionPolicy
`udp-internal-identity` khoá ba ServiceAccount đó. **Lượt `39847476997` (`e8fb784`) xanh cả 8 job** sau ba lượt đỏ
(mục 3), **PR #4 đã gộp vào `p61-dong-goi` (`498055c`)**. PR #1 (`p61-dong-goi` → `main`) chờ chủ repo gộp (mục 4). **53 mục nợ kiểm chứng**, Plan #67 không thêm mục nào.

Quyền của phiên: được push các nhánh và gộp PR giữa các nhánh không phải `main`; **không** merge vào `main`.

---

## 1. Nhánh và PR

| Nhánh              | Đỉnh      | Vai                                                 |
| ------------------ | --------- | --------------------------------------------------- |
| `main` (remote)    | `46a1049` | Plan #15 (12/09) - lượt đêm vẫn chạy trên đây       |
| `p61-dong-goi`     | `498055c` | Plan #16-#67, PR #1 vào `main` - chờ chủ repo gộp   |
| `p67-token-review` | `e8fb784` | Plan #67, PR #4 - ĐÃ GỘP vào `p61-dong-goi` (23/10) |
| `p66-cong-noi-bo`  | `dcdf9cf` | Plan #66, PR #3 - ĐÃ GỘP vào `p61-dong-goi` (22/10) |

## 2. Plan #67 - danh tính bên gọi `/internal/*` (spec, plan: `docs/plans/plan67-*.md`)

| Commit    | Nội dung                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `cd6f81a` | 67a `requireInternalIdentity`, `CallerVerifier` (`@udp/http`)                                           |
| `c99623b` | 67b `@udp/cluster-access/in-cluster`: dò API server trong cụm, `tokenReviewVerifier`                    |
| `472f494` | 67c `INTERNAL_AUTH_MODE`, `INTERNAL_TOKEN_DIR`; bốn client nội bộ gửi token chiếu theo đích             |
| `babbe12` | 67d Service 1 và Service 2 mount lớp danh tính; `flag-service` phụ thuộc `@udp/cluster-access`          |
| `b5ee191` | 67e manifest: ServiceAccount, volume projected, RBAC `tokenreviews`, policy, Pod Security; E2E năm nhóm |
| `d132be1` | 67f thiết kế: T12, §9, §12.2, §13.5, §15.1, §16, D-P39, D-P59                                           |
| `f26e0f3` | sửa sau lượt CI 1: policy đọc `subResource`, `name` qua `request.?`                                     |
| `897dc34` | sửa sau lượt CI 2: biến của policy giữ map, không optional                                              |
| `e8fb784` | sửa sau lượt CI 3: phép thử `auth can-i` đọc đúng dòng trả lời (kubectl in kèm cảnh báo ra stderr)      |

Những gì giờ đúng:

- Mọi lời gọi `/internal/*` trong cụm mang `Authorization: Bearer` - token chiếu, audience theo đích
  (`udp:internal:core-backend`, `udp:internal:flag-service`). Bên nhận đòi `authenticated`, audience đúng, username
  thuộc `INTERNAL_CALLERS`; nhớ dương 10 giây, dùng bản nhớ tới 60 giây CHỈ khi API server vắng.
- Production bắt buộc `INTERNAL_AUTH_MODE=token-review`; dev và test giữ `secret`. Bên nhận ngoài cụm không khởi động;
  bên gọi đọc thử token từng đích trước khi mở cổng.
- Policy `udp-internal-identity`: workload mang ba SA (hay nhãn ba tên) chỉ do người có `escalate` trên `clusterroles`
  hoặc đúng controller tạo, đổi template hay image; khoá `exec`, `attach`, ephemeral container, TokenRequest, Secret
  token dài hạn, ConfigMap `udp-config-*`, Secret `udp-secrets`, năm Service và EndpointSlice. Pod Security `baseline`
  cho namespace `udp`.
- E2E kind và k3s (`deploy/e2e/internal-identity-probe.ts`): dương đúng mã của route; thiếu token, thiếu bí mật, sai
  audience ⇒ 401; pod mạo nhãn ⇒ 401; kẻ có quyền trong namespace bị policy từ chối ở mọi đường, đối chứng được.

## 3. Hai lượt CI đỏ, và cách thử policy không cần CI

Cả hai lỗi nằm ở biểu thức CEL của policy, và cả hai lọt qua bước kiểm kiểu của API server (`status.typeChecking`):

1. `request.subResource`, `request.name` VẮNG MẶT khi rỗng - truy cập thẳng là lỗi, `failurePolicy: Fail` biến lỗi
   thành từ chối: cert-manager không tạo được Secret TLS, job-controller không gỡ được finalizer của pod migrate.
2. `variables.x.?trường` trên một biến kiểu optional luôn trả rỗng: policy đọc SA của mọi pod là `default`, nên luật
   SA không bao giờ kích hoạt.

Lượt 3: cả năm nhóm phép thử danh tính xanh ở kind và k3s; ô đỏ duy nhất là của chính phép thử (`auth can-i` in kèm
cảnh báo ra stderr). Mỗi lỗi của policy có một cổng manifest riêng (đỏ trên bản lỗi, xanh trên bản sửa). Lỗi 2 tìm ra bằng `kube-apiserver` 1.35.0 chạy
ở máy (envtest, `go run sigs.k8s.io/controller-runtime/tools/setup-envtest@latest use 1.35.x`), không cần Docker: 19 ca
(kẻ có quyền trong namespace, người cài, ba controller, Secret `generateName`, `exec`, đổi image) đúng cả 19 với bản sửa,
bản lỗi trượt sáu. Sửa policy lần sau thì thử ở đó trước - một lượt CI mất khoảng 40 phút.

## 4. Chưa chứng minh được, và việc tiếp

1. **Chủ repo gộp PR #1 vào `main`** (mô tả cập nhật tới Plan #67). Rồi pha 2 của `ci-github-green`: lượt `push` của
   `main` chạy `build-smoke`; chạy tay `toolchain.yml` và `publish-rehearsal.yml`.
2. **Supabase dev vẫn hỏng** (`tenant/user ... not found`): khôi phục rồi chạy `pnpm db:verify-chain`; ba tệp
   design-lint cần database chỉ chạy trên CI.
3. Nâng Node trên máy dev lên `>=22.22.2`.
4. `sdk-publish-real` (tài khoản npm, PyPI của chủ repo), E5 (bằng chứng của C1, cần cụm có Prometheus).
5. Phần còn lại của T12 (§16): chiếm node, quyền cấp cụm, Pod Security chưa đặt cho namespace khác, bên gọi chưa xác
   thực bên nhận (mTLS).

## 5. Máy này

7,71 GiB RAM. Node 22.20.0 (repo đòi `>=22.22.2`). ESLint toàn repo hết bộ nhớ: lint theo tệp đã đổi. Không có cụm
kind ở máy (Docker không chạy); context kubectl mặc định là cụm của một dự án KHÁC - đừng chạy lệnh vào đó.

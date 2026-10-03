# Plan #52 — SPEC v1: UDP chạy công khai trên máy ảo Oracle Cloud Always Free, chi phí 0

Nguồn: yêu cầu của người dùng 29/09/2026 — hạ tầng của dự án KHÔNG chạy trên máy của họ, chi phí ĐÚNG 0 (yêu
cầu cứng, D-P37), chọn Oracle Cloud Always Free sau khi đã cân Vercel và AWS Lambda; §15.1 (môi trường), §15.3
("PostgreSQL trong cụm K8s — mặc định của bản triển khai demo"), §13.5 (CI/CD), §4.3 (KEK ở ngoài database),
§12.2 (bề mặt công khai), ADR-06 (issuer OIDC cho federation BYOC).

## 1. Phạm vi

| Thiết kế hứa / người dùng cần                       | Hôm nay                                             | Plan này                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| UDP chạy ở một nơi không phải máy người dùng        | Chỉ cụm `kind` ở máy (#49) và trong runner CI (#50) | Máy ảo Oracle Always Free (Ampere A1, arm64) chạy k3s một node, CÙNG base Kustomize của #49, overlay `vm`                 |
| Truy cập từ Internet, HTTPS                         | Cổng `localhost`, HTTP                              | Traefik có sẵn của k3s + cert-manager (Let's Encrypt), một host, route theo tiền tố; chỉ bề mặt công khai của §9 ra ngoài |
| Federation BYOC GCP/Azure cần issuer OIDC công khai | Issuer tuỳ chọn, chưa có nơi phơi                   | `https://<host>/oidc` — khoá ký sinh trên máy ảo                                                                          |
| Flagger trong cluster tenant gọi gate của S3        | `PD_CONTROLLER_WEBHOOK_URL` chưa có giá trị         | `https://<host>`, route `/webhooks/flagger` → Service 3                                                                   |
| Push lên GitHub là triển khai (CD)                  | Không có                                            | Workflow `Deploy`: sau khi CI xanh trên `main`, SSH vào máy ảo, build image tại chỗ, áp bản phát hành                     |
| Dữ liệu sống lâu                                    | PVC của cụm kind — huỷ cụm là mất                   | Sao lưu hằng ngày sang Object Storage Always Free; lệnh khôi phục; KEK giữ riêng (§4.3)                                   |
| Kiểm được trước khi chạm máy thật                   | —                                                   | Job CI `vm`: chạy CHÍNH `bootstrap.sh` và `release.sh` trên runner, E2E qua HTTPS (route, TLS, SSE, sao lưu → khôi phục)  |
| Supabase cho hosted                                 | Hai project free đã dùng: dev và CI                 | **Không dùng** cho bản công khai (QĐ-2)                                                                                   |

Ngoài phạm vi: Vercel, Lambda (cần viết lại ba service thành serverless — đã cân và loại); MANAGED mode (vẫn tắt,
`MANAGED_CLOUDS=`); tên miền trả phí.

## 2. Quyết định

### QĐ-1: Một máy ảo Oracle Always Free, k3s một node, cùng manifest với kind

Ba service là tiến trình chạy liên tục (worker pg-boss, watcher change feed + SSE, vòng reconcile của S3 —
§1, `UDP_design.md:136`), nên một máy ảo chạy chúng đúng như thiết kế, không viết lại. k3s thay vì docker compose:
giữ Kubernetes như thiết kế và dùng lại `deploy/k8s/base` đã có test và đã chạy ở CI (#50) — kind (máy dev, CI) và
máy ảo khác nhau ở overlay, không ở manifest. Máy: VM.Standard.A1.Flex, Ubuntu 24.04 aarch64, 2 OCPU / 12 GB
(hạn mức Always Free của tài khoản tạo sau 06/2026), boot volume 100 GB (trong 200 GB miễn phí).

### QĐ-2: PostgreSQL trong cụm, không Supabase

§15.3 đã chọn "PostgreSQL trong cụm — mặc định của bản triển khai demo", và base của #49 đã có nó. Supabase bị
loại cho bản công khai vì: (1) gói free cho HAI project đang hoạt động, cả hai đã dùng (dev, CI) — dùng chung
project dev nghĩa là bộ test chạy ở máy dev ghi và xoá trên dữ liệu thật; (2) kết nối trực tiếp của Supabase free
chỉ có IPv6; (3) cùng máy thì `LISTEN/NOTIFY` (hai đường tăng tốc) chạy với độ trễ mạng bằng 0. Cái giá: sao
lưu phải tự làm — QĐ-7.

### QĐ-3: Image build NGAY trên máy ảo, tag theo commit

Máy A1 là arm64: build tại chỗ bằng Docker cho image arm64 gốc, rồi `docker save | k3s ctr images import` — đúng
mô hình `kind load` của #49, không registry nào (không GHCR, không phụ thuộc chế độ hiển thị của package). Tag là
12 ký tự đầu của commit, bất biến: bản mới hỏng thì pod của ReplicaSet cũ khởi động lại vẫn có image cũ, và
`kubectl rollout undo` dùng được — tag `local` dùng lại (như kind) sẽ trỏ pod cũ sang image mới hỏng. Image đã
nạp thì xoá khỏi kho của Docker (không giữ hai bản); cache build giữ lại. Bộ image của máy ảo = bộ của #49 trừ
`sample-app`.

### QĐ-4: Cấu hình theo máy trong `~/udp/vm.env`; bản phát hành sinh bằng hàm thuần

`~/udp/vm.env` (quyền 0600, do `bootstrap.sh` tạo mẫu, người dùng điền): `UDP_PUBLIC_HOST`, `ACME_EMAIL`,
`UDP_BACKUP_UPLOAD_URL`, `TLS_ISSUER` (`letsencrypt` mặc định | `letsencrypt-staging` | `self-signed`), và hai
khoá khôi phục tuỳ chọn `UDP_KEK_V1`, `UDP_OIDC_SIGNING_KEY` (QĐ-7). Đọc bằng một schema zod — sai là dừng trước
khi chạm cụm. Từ nó và commit, `releaseKustomization()` (hàm thuần) sinh một kustomization trong thư mục bị
gitignore `deploy/k8s/release/`: tag image, gộp ConfigMap (`CORS_ORIGIN`, `COOKIE_DOMAIN`, `UDP_OIDC_ISSUER`,
`PD_CONTROLLER_WEBHOOK_URL`), thay host của Ingress và email ACME (JSON 6902 trên giá trị giữ chỗ `udp.invalid`
của overlay), và kèm ĐÚNG MỘT component issuer — Let's Encrypt, hay CA tự ký khi `TLS_ISSUER=self-signed` (lượt CI không đăng ký tài khoản ACME nào). Bảng route nằm ở
YAML của overlay, không ở TypeScript. Test dựng bản phát hành bằng `kubectl kustomize` THẬT rồi parse cấu hình
từng service bằng CHÍNH `envSchema` (cùng khuôn QĐ-4 của #49).

### QĐ-5: Đường vào công khai — Traefik của k3s + cert-manager, một host, route theo tiền tố

| Tiền tố             | Tới                                   | Vì sao công khai                                                 |
| ------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `/`                 | Portal (SPA; nginx proxy `/api` → S1) | Người dùng; API của Portal cùng origin (cookie httpOnly, §10.10) |
| `/sdk`, `/ofrep`    | Service 2                             | SDK và OFREP trong ứng dụng của khách                            |
| `/oidc`             | Service 1                             | Discovery + JWKS cho federation GCP/Azure (cloud của khách đọc)  |
| `/webhooks/flagger` | Service 3                             | Flagger trong cluster tenant hỏi gate (§7.3, Plan #51)           |

Không route nào tới `/internal/*`, `/metrics`, `/healthz`, `/readyz` hay Prometheus (§9: `/internal` không được
phơi ra Internet) — những đường đó rơi vào Portal và nhận trang SPA. HTTP → HTTPS bằng Middleware `redirectScheme`
(no-op khi đã là https; route thử thách ACME dài hơn nên thắng). TLS do cert-manager cấp qua HTTP-01, chứng chỉ
và khoá tài khoản ACME nằm trong Secret — không PVC cho Traefik. Traefik đặt `externalTrafficPolicy: Local`
(HelmChartConfig của k3s) để giữ IP khách cho rate limit; `TRUST_PROXY_HOPS` theo đúng số hop của từng service:
S1 = 2 (Traefik → nginx), S2 = 1. Tên host: DuckDNS (miễn phí, nằm trong Public Suffix List nên hạn mức Let's
Encrypt là của riêng host) hay tên miền sẵn có; KHÔNG sslip.io/nip.io — không nằm trong PSL, hạn mức Let's Encrypt
dùng chung của cả thế giới và thường cạn.

### QĐ-6: Không dữ liệu demo trên máy công khai

Overlay `vm` không seed: tài khoản seed có mật khẩu nằm công khai trong repo (`seed-constants.ts`), trên Internet
nó là cửa hậu. Không `sample-app` (chaos bật, là đồ thí nghiệm của kind). Người dùng đầu tiên đăng ký qua Portal
như mọi người dùng. MANAGED giữ tắt (`MANAGED_CLOUDS=` của base).

### QĐ-7: Sao lưu hằng ngày ra khỏi máy; KEK giữ riêng

CronJob `udp-backup` (02:30 giờ Việt Nam): `pg_dump --format=custom` bằng owner, rồi `curl -X PUT` lên Object
Storage Always Free qua một Pre-Authenticated Request CHỈ-GHI của bucket, tên theo thứ trong tuần
(`udp-Mon.dump` …) — bảy bản xoay vòng, không cần lifecycle policy, PAR lộ ra cũng không đọc được bản nào. Bản
dump KHÔNG mang KEK (§4.3: "một bản dump database MỘT MÌNH là vô dụng"): người dùng chép `UDP_KEK_V1` vào trình
quản lý mật khẩu một lần; dựng máy mới thì đặt nó vào `vm.env` trước lần phát hành đầu — Secret nhận giá trị đó
thay vì sinh mới, credential BYOC đã mã hoá giải được. Khôi phục: `pnpm --filter @udp/deploy vm-restore <tệp>` —
hạ ba service về 0 bản, `pg_restore --single-transaction` vào một database MỚI rồi đổi tên hoán vị với database
đang dùng trong một câu lệnh; hỏng thì database cũ chưa bị đụng, xong thì bản cũ ở lại dưới tên
`udp_before_restore`.

### QĐ-8: Bí mật sinh trên máy ảo, chỉ được BỔ SUNG, không bao giờ ghi đè

Secret `udp-secrets` sinh lần đầu trên máy (tệp tạm 0600, không qua dòng lệnh — như #49), cộng khoá ký OIDC (RSA
2048). Bản phát hành sau thêm khoá mới thì Secret được bổ sung đúng khoá thiếu (`kubectl patch --patch-file`),
khoá đã có không bao giờ bị ghi đè. Khoá gắn với DỮ LIỆU (mật khẩu role và chuỗi kết nối — gắn với PostgreSQL trên
PVC; KEK — gắn với mọi credential đã mã hoá) mà Secret đang chạy thiếu ⇒ dừng kèm tên khoá, không sinh lại: sinh
lại là khoá database hay làm credential không giải được. Khoá khác (JWT, bí mật nội bộ) thiếu thì sinh — cái giá chỉ
là mọi phiên đăng nhập lại. Cùng hàm áp cho kind (ở đó không có gì để bổ sung).
Secret `udp-backup` (URL của PAR) tách riêng vì người dùng xoay nó.

### QĐ-9: CD — workflow `Deploy` sau khi CI xanh

`.github/workflows/deploy.yml`: `workflow_run` của CI, `completed` + `success`, nhánh `main`, sự kiện `push`; và
chạy tay. Environment `vm` giữ bốn secret (`UDP_VM_HOST`, `UDP_VM_USER`, `UDP_VM_SSH_KEY`,
`UDP_VM_KNOWN_HOSTS`); host key GHIM (không `StrictHostKeyChecking=no`). Thiếu secret ⇒ bỏ qua im lặng (fork, bản
clone). `deploy/vm/ship.sh` gửi mã nguồn của đúng commit bằng `git archive` qua SSH — máy ảo không cần quyền vào
GitHub — rồi chạy `deploy/vm/release.sh <sha>` trên máy, giữ ba bản phát hành gần nhất. Một lượt deploy tại một
thời điểm (`concurrency`, không huỷ lượt đang chạy).

### QĐ-10: Dựng máy một lần bằng `deploy/vm/bootstrap.sh`

Chạy lại được: mở 80/443 trong iptables (image Ubuntu của Oracle chặn mọi cổng trừ 22 bằng luật REJECT) và lưu
luật; Docker từ kho apt chính thức; Node 22 (tarball chính thức, kiểm SHA-256); k3s ghim phiên bản; cert-manager
ghim phiên bản; kubeconfig riêng `~/.kube/udp-vm.yaml`, context `udp-vm` (mọi lệnh kubectl của máy ảo ghim nó —
cùng lý do #50 ghim `kind-udp`); tệp mẫu `~/udp/vm.env`. Phần ngoài máy (tạo tài khoản, máy ảo, security list,
DuckDNS, bucket + PAR, secret GitHub) làm bằng trình duyệt, theo `deploy/README.md`.

### QĐ-11: Kiểm tại CI trước khi chạm máy thật

Job `vm` của `ci.yml` chạy trên runner (x86): CHÍNH `bootstrap.sh`, một `vm.env` cho lượt CI (host `udp.ci.test`
trỏ về IP của node, `TLS_ISSUER=self-signed`, đích sao lưu là một bồn nhận trên runner), CHÍNH `release.sh`, rồi
`e2e:vm` qua HTTPS với chứng chỉ do cert-manager cấp (tin bằng `NODE_EXTRA_CA_CERTS`, kiểm cả tên host): chuyển
hướng HTTP, SPA, đăng ký + đăng nhập qua HTTPS (cookie `Secure`, CSRF), route tới S2/S1-oidc/S3, đường nội bộ
không lộ, SSE qua Traefik sống quá 60 giây, sao lưu → khôi phục khứ hồi. Repo public: phút runner miễn phí.
Phần CI không thay được — arm64, iptables và security list của Oracle, Let's Encrypt thật, IP khách qua
ServiceLB, SSH thật — là một mục sổ nợ.

### QĐ-12: Chi phí 0 do cấu trúc

| Thứ dùng                                                   | Vì sao 0 đồng                                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Máy ảo A1, boot volume, IPv4                               | Always Free của tài khoản Free Tier; tài khoản KHÔNG nâng lên Pay As You Go thì không có đường nào để tính tiền |
| Object Storage (bản sao lưu)                               | 20 GB Always Free; bảy bản dump của một hệ thống demo cỡ MB                                                     |
| Băng thông ra                                              | 10 TB/tháng miễn phí                                                                                            |
| GitHub Actions (CI, Deploy)                                | Repo public — runner chuẩn miễn phí                                                                             |
| Chứng chỉ, tên miền                                        | Let's Encrypt; DuckDNS                                                                                          |
| k3s, Traefik, cert-manager, Docker, PostgreSQL, Prometheus | Mã nguồn mở, chạy trên máy ảo ở trên                                                                            |

Thẻ ngân hàng Oracle đòi lúc đăng ký chỉ để xác minh. Luật duy nhất người dùng phải giữ: không nâng tài khoản.

## 3. Rủi ro đã biết

- **Oracle thu hồi máy rảnh:** chỉ khi TRONG 7 NGÀY cả ba cùng dưới 20% — CPU (p95), mạng, và bộ nhớ (riêng A1).
  Thu hồi là DỪNG máy sau một email báo trước một tuần, không xoá: khởi động lại là chạy tiếp, dữ liệu trên boot
  volume còn nguyên. Mức bộ nhớ thật của UDP trên máy là một phép đo của sổ nợ.
- **Oracle đổi hạn mức** (06/2026 đã hạ A1 xuống 2 OCPU / 12 GB): mọi thứ dựng lại được từ repo + bản sao lưu + KEK.
- **Hết máy A1 ở vùng phổ biến:** chọn vùng khác (Singapore, Tokyo, Seoul…) — README ghi.

## 4. Tiêu chí chấp nhận

- **AC-1** Bản phát hành `vm` dựng được bằng `kubectl kustomize`; cấu hình TỪNG service (ConfigMap + Secret +
  env riêng của container) qua `envSchema`; image đúng bộ của máy ảo với tag của commit; không seed, không
  sample-app; Ingress HTTPS đúng bốn nhóm tiền tố, TLS cho đúng host, HTTP là Ingress riêng chỉ chuyển hướng; không
  `udp.invalid` nào còn sót; đúng một component issuer theo lựa chọn.
- **AC-2** Kế hoạch bổ sung Secret: thêm đúng khoá thiếu, không ghi đè, dừng khi thiếu khoá gắn với dữ liệu; khoá ký
  OIDC qua schema; khoá khôi phục từ `vm.env` được dùng thay khoá sinh, và khác Secret đang chạy thì dừng.
- **AC-3** `bootstrap.sh`, `release.sh`, `ship.sh` qua `bash -n`; phiên bản ghim khớp một nguồn; `release.sh`
  và `ship.sh` từ chối SHA không đúng dạng.
- **AC-4** Nối dây của `deploy.yml` và job `vm` được test (sau CI xanh, chỉ push lên main hay chạy tay, host key
  ghim, SHA qua biến môi trường, thiếu secret thì bỏ qua; `vm` chạy bootstrap → release → E2E, chẩn đoán khi đỏ).
- **AC-5** Job `vm` xanh trên GitHub — lượt đẩy đầu tiên là lần chạy đầu (máy dev không chạy được Docker, như #50).
- **AC-6** Không thoái cấp: `pnpm deploy:up` của kind giữ nguyên hành vi; mọi test của `@udp/deploy` và mọi cổng
  (typecheck, lint, format, design-lint) xanh.

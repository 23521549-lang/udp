# deploy — hạ tầng của UDP, chi phí 0

Hai nơi chạy, CÙNG base Kustomize (`k8s/base`), khác nhau ở overlay:

| Nơi chạy                        | Dùng để                                  | Overlay             | Plan     |
| ------------------------------- | ---------------------------------------- | ------------------- | -------- |
| Cụm `kind` (máy dev, runner CI) | Phát triển, E2E rút gọn và E9 ở CI       | `k8s/overlays/kind` | #49, #50 |
| Máy ảo Oracle Cloud Always Free | UDP công khai qua Internet, CD từ GitHub | `k8s/overlays/vm`   | #52      |

Không registry, không dịch vụ trả phí ở cả hai.

## 1. Cụm kind

```bash
pnpm deploy:up     # dựng cụm kind "udp", build + nạp image, sinh Secret, migrate + seed, chờ sẵn sàng
pnpm deploy:down   # huỷ cụm (cùng dữ liệu PostgreSQL)
```

Cần Docker đang chạy (≥ 4 GiB RAM cho Docker), `kind` và `kubectl` trên PATH. Sau khi dựng:

| Thành phần             | Truy cập                                                                          |
| ---------------------- | --------------------------------------------------------------------------------- |
| Portal                 | http://localhost:8080 — tài khoản seed `dev@udp.local` / `udp12345678`            |
| Service 2 (SDK, OFREP) | http://localhost:3002 — SERVER key seed `udp_sk_dev_0000000000000000000000000000` |
| Prometheus             | `kubectl --context kind-udp -n udp port-forward svc/prometheus 9090:9090`         |

Mọi lệnh kubectl ghim context `kind-udp`: context hiện tại của máy có thể là một cụm cloud thật.

## 2. Máy ảo Oracle Cloud Always Free

UDP chạy công khai trên một máy ảo Ampere A1 (arm64) với k3s một node: Traefik có sẵn của k3s + cert-manager
(Let's Encrypt), PostgreSQL trong cụm, sao lưu hằng ngày sang Object Storage. Push lên `main` mà CI xanh thì
workflow `Deploy` tự phát hành. Thiết kế: `docs/plans/plan52-spec.md`, D-P41.

**Luật duy nhất để giữ 0 đồng: tài khoản Oracle ở Free Tier, KHÔNG BAO GIỜ nâng lên Pay As You Go.** Thẻ Oracle
đòi lúc đăng ký chỉ để xác minh; tài khoản Free Tier không tạo được thứ gì tính tiền.

### 2.1 Dựng lần đầu — mọi bước làm bằng trình duyệt

1. **Tài khoản:** đăng ký Oracle Cloud Free Tier, chọn home region còn máy A1 (Singapore, Tokyo, Seoul…).
2. **Khoá SSH:** mở Cloud Shell trên Console Oracle, chạy `ssh-keygen -t ed25519 -f ~/.ssh/udp_vm -N ""`.
3. **Máy ảo:** Compute → Instances → Create. Image **Canonical Ubuntu 24.04** (aarch64), shape
   **VM.Standard.A1.Flex** 2 OCPU / 12 GB (mức Always Free), boot volume 100 GB, gán public IPv4, dán nội dung
   `~/.ssh/udp_vm.pub`. Hết máy ở vùng đó thì thử lại sau hay đổi availability domain.
4. **Mở cổng ở VCN:** Networking → VCN của máy → Security List → thêm ingress TCP **80** và **443** từ
   `0.0.0.0/0` (22 đã mở sẵn). Cổng trong iptables của máy do `bootstrap.sh` mở.
5. **Tên miền:** đăng nhập duckdns.org, tạo `<tên>.duckdns.org` trỏ về IP công khai của máy. Không dùng
   sslip.io/nip.io: hạn mức Let's Encrypt của chúng dùng chung cả thế giới và thường cạn.
6. **Bucket sao lưu:** Storage → Buckets → Create (Standard, private) `udp-backup` → Pre-Authenticated
   Requests → Create: target **Bucket**, access **Permit object writes**, hạn xa. Chép URL (kết thúc bằng `/o/`).
7. **Dựng máy:** từ Cloud Shell `ssh -i ~/.ssh/udp_vm ubuntu@<IP>`, rồi:

   ```bash
   git clone https://github.com/23521549-lang/udp.git && bash udp/deploy/vm/bootstrap.sh
   nano ~/udp/vm.env    # UDP_PUBLIC_HOST, ACME_EMAIL, UDP_BACKUP_UPLOAD_URL; nên thử TLS_ISSUER=letsencrypt-staging trước
   echo "<IP> $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"   # dòng known_hosts cho bước 8
   ```

8. **GitHub:** Settings → Environments → New environment `vm`, bốn secret:

   | Secret               | Giá trị                                             |
   | -------------------- | --------------------------------------------------- |
   | `UDP_VM_HOST`        | IP công khai của máy (cùng IP với dòng known_hosts) |
   | `UDP_VM_USER`        | `ubuntu`                                            |
   | `UDP_VM_SSH_KEY`     | nội dung `~/.ssh/udp_vm` trong Cloud Shell          |
   | `UDP_VM_KNOWN_HOSTS` | dòng in ra ở bước 7                                 |

9. **Phát hành:** Actions → Deploy → Run workflow (nhánh `main`). Xong thì mở `https://<tên>.duckdns.org`,
   đăng ký tài khoản đầu tiên. Staging xanh rồi thì đổi `TLS_ISSUER=letsencrypt` và chạy lại.
10. **Giữ KEK:** trên máy ảo chạy lệnh dưới, chép kết quả vào trình quản lý mật khẩu. Bản sao lưu KHÔNG mang
    nó (§4.3) — mất KEK là mất mọi credential BYOC đã mã hoá.

    ```bash
    kubectl --kubeconfig ~/.kube/udp-vm.yaml --context udp-vm -n udp get secret udp-secrets \
      -o jsonpath='{.data.UDP_KEK_V1}' | base64 -d; echo
    ```

### 2.2 Vận hành

- **Mỗi lần phát hành:** image build NGAY trên máy (arm64) với tag là 12 ký tự đầu của commit; Secret chỉ được
  bổ sung khoá mới, không bao giờ ghi đè. Quay về nhanh: `kubectl … rollout undo deployment/<service>` (image
  cũ còn trong k3s); quay về hẳn một commit: Run workflow `Deploy` trên tag hay nhánh của commit đó.
- **Khi có gì đỏ:** `pnpm --filter @udp/deploy diagnose --target vm` (pod, sự kiện, log, Ingress, chứng chỉ,
  thử thách ACME, Traefik, cert-manager, job sao lưu).
- **Khôi phục:** tải một `udp-<thứ>.dump` từ bucket, chép lên máy, rồi
  `pnpm --filter @udp/deploy vm-restore <tệp>` trong thư mục repo — khôi phục vào database mới rồi đổi tên hoán
  vị; bản trước đó ở lại dưới tên `udp_before_restore`.
- **Dựng lại trên máy MỚI:** làm lại 2.1, nhưng trước lần phát hành đầu đặt `UDP_KEK_V1` (và tuỳ chọn
  `UDP_OIDC_SIGNING_KEY`) cũ vào `~/udp/vm.env`, rồi phát hành và khôi phục bản dump.
- **Oracle dừng máy rảnh:** khi 7 ngày liền CPU (p95), mạng và bộ nhớ đều dưới 20%, Oracle gửi thư rồi DỪNG
  máy (không xoá). Start lại trên Console là chạy tiếp; IP đổi thì sửa DuckDNS và secret `UDP_VM_HOST`,
  `UDP_VM_KNOWN_HOSTS`.

## 3. Cấu trúc

- `docker/service.Dockerfile` — một Dockerfile cho S1, S2, S3 và sample-app (`--build-arg PKG`, `DIR`);
  service chạy mã nguồn bằng `tsx`, đúng đường mà dev và bộ test chạy.
- `docker/portal.Dockerfile` + `nginx.conf` — Portal tĩnh, proxy `/api` sang Service 1, nginx không root.
- `docker/migrate.Dockerfile` — job `udp-migrate`: migration, LOGIN + mật khẩu cho `udp_s1…3`, seed.
- `k8s/base` — PostgreSQL 16, Prometheus (khám phá pod, nhãn `namespace` từ pod), S1/S2/S3, Portal, job.
- `k8s/overlays/kind` — tag `local`, NodePort 8080/3002, seed, sample-app trong namespace env dev của seed.
- `k8s/overlays/vm` — Ingress HTTPS với đúng bề mặt công khai (`/`, `/sdk`, `/ofrep`, `/oidc`,
  `/webhooks/flagger`) và Ingress HTTP chỉ chuyển hướng, Traefik giữ IP khách, hop proxy theo service, PVC
  20 GiB, CronJob sao lưu; không seed, không sample-app. Host, email và tag là giá trị giữ chỗ.
- `k8s/components/letsencrypt`, `k8s/components/self-signed-tls` — ClusterIssuer; bản phát hành kèm đúng một.
- `kind/cluster.yaml` — một node, hai cổng ra máy.
- `src/install.ts` — các bước cài dùng chung (kubectl ghim, build image, Secret chỉ bổ sung, áp + migrate + chờ).
- `src/cluster.ts` (kind) và `src/vm.ts` (máy ảo: schema `vm.env`, bộ image, bí mật, `releaseKustomization`);
  `src/up.ts`, `src/down.ts`, `src/vm-up.ts`, `src/vm-restore.ts`, `src/diagnose.ts`.
- `vm/` — `bootstrap.sh` (dựng máy một lần), `release.sh` (một bản phát hành, chạy trên máy), `ship.sh` (gửi
  commit qua SSH, chạy trên runner), `ci-settings.sh` (máy diễn tập của CI), `versions.env` (k3s,
  cert-manager, Node ghim), `vm.env.example`.
- `e2e/` — E2E rút gọn trên cụm kind (Plan #50); `e2e-vm/` — E2E qua HTTPS trên máy diễn tập của CI (Plan #52).

Secret `udp-secrets` sinh trên chính nơi chạy (tệp tạm 0600, không qua dòng lệnh), không bao giờ nằm trong repo;
`.dockerignore` loại mọi `.env*` khỏi image; `~/udp/vm.env` chỉ nằm trên máy ảo.

## 4. Kiểm

`pnpm --filter @udp/deploy test`: overlay kind và bản phát hành của máy ảo dựng bằng `kubectl kustomize` THẬT,
cấu hình từng service qua CHÍNH schema env, image đúng tập build, cổng, probe, không container nào chạy root,
route công khai/nội bộ, TLS, sao lưu; kế hoạch bổ sung Secret; cú pháp và phiên bản ghim của script máy ảo;
nối dây của CI và `Deploy` (`tests/ci-workflow.test.ts`).

Trên một cụm đang chạy:

```bash
pnpm --filter @udp/deploy e2e          # kind: Portal, API qua proxy, khoá CLIENT, OFREP, lan truyền SSE, Prometheus
pnpm --filter @udp/experiments e9      # E9: CPU/RAM khi rỗi và khi 1 000 SDK nối SSE (~8 phút)
pnpm --filter @udp/deploy e2e:vm       # CHỈ máy diễn tập của CI: nó đăng ký người dùng và khôi phục database
pnpm --filter @udp/deploy diagnose     # khi có gì đỏ (thêm --target vm cho máy ảo)
```

CI chạy chúng ở job `kind` (E9 chỉ ở làn đêm và khi chạy tay) và job `vm` (bootstrap → release → E2E qua HTTPS).
Phần runner không thay được máy Oracle thật: sổ nợ `vm-oracle-real`.

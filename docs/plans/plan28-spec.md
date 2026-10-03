# Plan #28 — Hàng đợi job và provisioning đầu–cuối — SPEC

Trạng thái: **v1, 25/09/2026**. Nguồn: ADR-02, ADR-06, ADR-07 (§1.4), §2.2
(`ProvisioningJob`, `ProvisionedResource`, `IdempotencyKey`), §4.2–§4.5, §5.3, §7.1, §8.1
giai đoạn 2, §9 (provision, jobs, preview), §10.5 bước 4–5, §10.14, §12.2 của
`docs/UDP_design.md`; sổ nợ `portal-job-stream`, `portal-preview`, `I32-cluster`.

## 1. Mục tiêu

1. **Hàng đợi** `pg-boss` theo đủ năm điều kiện ADR-02; `ProvisioningJob` là nguồn sự thật,
   pg-boss là cơ chế thực thi; đối soát hai bên là job bắt buộc (đk 4).
2. **Job PROVISION đầu–cuối** chạy trong worker của Service 1: NETWORK → CLUSTER →
   CLUSTER_ACCESS → DOMAINS → DONE (project `ACTIVE`, `DEPLOY_SUCCESS`), thất bại ⇒
   COMPENSATING → FAILED (project `ERROR`, `DEPLOY_FAILURE`), hủy hợp tác
   (`CANCEL_REQUESTED`), resume sau khi worker chết mà không tạo trùng.
3. **CLUSTER_ACCESS** thật (ADR-06, §12.2): namespace `udp-system`, ba ServiceAccount
   `udp-workload` / `udp-traffic` / `udp-tooling` với Role/ClusterRole rời nhau, namespace
   theo environment kèm NetworkPolicy default-deny + ResourceQuota; `Project.cluster_access`
   KHÔNG mang token.
4. **Endpoint:** `GET /projects/:id/preview`, `POST /projects/:id/provision`
   (Idempotency-Key), `GET /projects/:id/jobs`, `GET /projects/:id/jobs/:jobId`,
   `GET /projects/:id/jobs/:jobId/stream` (SSE), `POST /projects/:id/jobs/:jobId/cancel`.
5. **Portal:** bước 4 (xem trước: chi phí ba mục bắt buộc, thứ tự triển khai, xác nhận
   con số cho production) và bước 5 (nhật ký job trực tiếp) của wizard; nhật ký job ở trang
   project.

**Không thuộc plan này** (plan sau, cùng hạ tầng hàng đợi): TEARDOWN + `DELETE /projects`,
`DOMAIN_APPLY` cho project đã ACTIVE, route Day-2, cron drift / TTL / orphan-scan. Chúng
dùng đúng worker và đối soát dựng ở đây.

## 2. Ràng buộc nền

| Mã  | Ràng buộc                                                                                                  | Nguồn              |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------ |
| R1  | Không reaper tự viết; pg-boss polling (không LISTEN/NOTIFY), schema riêng, qua `DATABASE_URL_DIRECT`       | ADR-02 đk 1–3      |
| R2  | Lease + fencing trên `ProvisioningJob`; MỌI ghi của worker kiểm `version`; worker xong việc phải nhả lease | ADR-02 đk 5, v4.10 |
| R3  | Sổ tài nguyên ghi TRƯỚC lời gọi cloud; resume đi qua `lookup`                                              | §4.5, K1..K10      |
| R4  | Token cluster không bao giờ xuống database hay đĩa (I24); `cluster_access` chỉ endpoint + CA + tên SA      | ADR-06             |
| R5  | Mọi response mới: schema dây `.strict()` + golden; SSE chỉ khiến Portal `invalidateQueries`                | D-P8, §10.14       |
| R6  | Không thoái cấp: mọi cổng hiện có giữ xanh, kể cả lưới K1..K10                                             | yêu cầu người dùng |

## 3. Quyết định

### QĐ-1: Outbox là chính `ProvisioningJob`, không `send()` qua role `udp_s1`

ADR-02 cho `send()` trong cùng transaction qua `fromPrisma(tx)`. Làm vậy thì `udp_s1` phải có
quyền trên schema `pgboss` — schema do pg-boss tự tạo LÚC CHẠY, sau mọi migration Prisma,
nên GRANT không có chỗ đứng đúng thứ tự. Thay vào đó: `POST /provision` chỉ ghi hàng
`ProvisioningJob(QUEUED)` trong transaction nghiệp vụ; sau commit, Service 1 gửi job
pg-boss với `id = ProvisioningJob.id` (gửi trùng id là không làm gì — idempotent). Tiến
trình chết giữa commit và gửi ⇒ **đối soát** (đk 4, vốn bắt buộc) gửi lại mọi hàng QUEUED
chưa có job pg-boss. Cùng bảo đảm "không mất job", không đụng quyền của schema lạ.

### QĐ-2: Worker chạy trong tiến trình Service 1, cổng tiêm được

`createJobWorker({boss, prisma, platform, registry, clusterFactory, now, sleep})`. Lease:
`claim` với đồng hồ của DATABASE và lọc trạng thái chưa kết thúc (sửa hai lệch của
`claim()` hiện có), `keepLease` gia hạn mỗi `JOB_LEASE.renewIntervalMs` và `touch()` job
pg-boss cùng nhịp (đk 2), mất lease ⇒ fence hủy, worker dừng TRƯỚC lời gọi cloud kế tiếp.
Tắt êm: `stop()` chờ việc đang chạy nhả lease rồi mới đóng.

### QĐ-3: Tài nguyên pha trước đi vào `prior` của pha sau

Runner giữ `created` theo từng lần `run()` (RUN12); kế hoạch thật (AWS: `cluster` phụ thuộc
subnet) chạy pha CLUSTER riêng sẽ thiếu cha. `RunPlan.inherited` (tài nguyên các pha trước,
khoá theo tên step) được trộn vào `prior`. Nguồn: kết quả pha NETWORK trong cùng lượt,
hoặc SỔ khi resume (hàng READY của pha trước; tên step lấy từ `idempotency_key`). Bộ hợp
đồng không thấy lỗi vì nó tự gom `prior` qua hai pha — thêm phép kiểm chạy hai pha tách
rời trên kế hoạch thật.

### QĐ-4: CLUSTER_ACCESS là một tập manifest thuần + ClusterAccess dựng từ token cloud

`bootstrapManifests(project, envs)` (thuần) ⇒ namespace, ba SA, Role/ClusterRole đúng bảng
§12.2 (không wildcard, không `escalate`/`bind`/`pods/exec`, không `secrets` ngoài
namespace của mình), namespace theo env + NetworkPolicy default-deny + ResourceQuota từ
quota của project. Áp bằng ClusterAccess xác thực bằng token của `getKubeAuthToken` (quyền
admin của credential cloud, chỉ dùng cho bootstrap). Các pha sau dùng bound SA token 1 giờ
xin qua `TokenRequest` (`TokenSource`), không bao giờ token admin. Transport thật: `fetch`
tới API server với CA của cluster (undici `Agent`), qua egress guard. **Chưa có cluster
thật trên máy đo ⇒ phép chạy thật là nợ `I32-cluster`**; logic kiểm bằng transport giả ở
tầng HTTP.

### QĐ-5: DOMAINS theo bậc, binding xuống bảng sau mỗi bậc

Đọc domain đang bật (PENDING) + registry; `validateAndOrder` cho bậc; mỗi bậc chạy song
song `deploy(ctx)` với `ctx.k8s` = ClusterAccess identity `tooling`, `ctx.resolved` NẠP LẠI
TỪ BẢNG. Binding persist ngay sau mỗi bậc; domain → ACTIVE (lỗi ⇒ ERROR, job đi nhánh thất
bại). Không domain nào bật ⇒ pha trống, vẫn đi qua trạng thái.

### QĐ-6: Tiến độ và SSE đọc từ database

SSE không giữ trạng thái trong bộ nhớ worker (worker và request có thể ở hai tiến trình):
stream đọc `ProvisioningJob` + `ProvisionedResource` + domain của project mỗi 1 giây, gửi
`snapshot` khi khác lần trước, `heartbeat` mỗi 15 giây, tự đóng ở trạng thái kết thúc.
Portal chỉ `invalidateQueries` khi nhận sự kiện (§10.14), và polling tự dừng ở DONE/FAILED.

### QĐ-7: Preview và xác nhận chi phí

`GET /preview` = `estimateCost` của adapter cloud (ba mục bắt buộc, `pricingAsOf`) +
`deployOrder` của domain đã lưu + `estimatedTime`. `POST /provision` mang
`confirmedMonthlyUsd`; project có environment production đòi con số ĐÚNG bằng ước tính hiện
tại (428 `CONFIRMATION_REQUIRED` nếu thiếu/lệch, §4.4 lớp 2) và con số được lưu vào
`estimated_cost`.

### QĐ-8: Quyền và tiền điều kiện của `POST /provision`

OWNER (tiêu tiền trong tài khoản của khách). Project phải DRAFT hoặc ERROR (thử lại sau
thất bại); có credential đã `validate` (409 `cloud-not-configured` nếu chưa); không có job
đang chạy (unique index ⇒ 409 `DUPLICATE_RESOURCE`, trừ khi Idempotency-Key trả lại đúng
job cũ). Đổi credential khi có job đang chạy ⇒ 409 (§2.2, hiện chưa cưỡng chế).

## 4. Tiêu chí chấp nhận

| Mã    | Tiêu chí                                                                                                                                                                   | Cách kiểm                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| AC-1  | Kế hoạch thật AWS/GCP/Azure chạy NETWORK rồi CLUSTER ở hai lần `run()` tách rời, kể cả khi resume từ sổ                                                                    | test runner + SimCloud                   |
| AC-2  | pg-boss: gửi trùng id không tạo job thứ hai; đối soát gửi lại hàng QUEUED mất job; job pg-boss `failed` trong khi `ProvisioningJob` chưa kết thúc ⇒ đối soát đưa về FAILED | tích hợp trên DB thật                    |
| AC-3  | Job PROVISION trên SimCloud + cluster giả: DONE, project ACTIVE, `cluster_access` không có token, binding domain trong bảng, `DEPLOY_SUCCESS`                              | tích hợp                                 |
| AC-4  | Lỗi ở CLUSTER ⇒ compensation ngược, FAILED, project ERROR, `DEPLOY_FAILURE`, `last_error` đã redact                                                                        | tích hợp                                 |
| AC-5  | Worker mất lease giữa chừng ⇒ dừng trước lời gọi cloud kế tiếp; worker khác tiếp tục, không tạo trùng                                                                      | tích hợp (lease hết hạn bằng đồng hồ DB) |
| AC-6  | Manifest bootstrap đúng bảng §12.2: không wildcard, không escalate/bind/pods-exec                                                                                          | test thuần + design-lint                 |
| AC-7  | `/provision`: Idempotency-Key trả cùng jobId; production thiếu/lệch xác nhận ⇒ 428; không credential ⇒ 409; VIEWER/MAINTAINER ⇒ 403                                        | tích hợp                                 |
| AC-8  | SSE: snapshot khi đổi, heartbeat, đóng ở trạng thái cuối                                                                                                                   | tích hợp                                 |
| AC-9  | Portal: bước 4 hiện ba mục chi phí + thứ tự; bước 5 cập nhật theo SSE và dừng ở DONE/FAILED                                                                                | test Portal với golden                   |
| AC-10 | Không thoái cấp (K1..K10, golden, I10, I22, I38)                                                                                                                           | lệnh cổng                                |

## 5. Nợ kiểm chứng

`I32-cluster` (đã có) mở rộng: transport + TokenSource + bootstrap trên cluster thật.
`I31-*` giữ nguyên (lưới trên cloud thật). Trả `portal-job-stream`, `portal-preview`.

## 6. Rủi ro

| Rủi ro                                    | Giảm thiểu                                                  |
| ----------------------------------------- | ----------------------------------------------------------- |
| pg-boss 12 đòi Node ≥ 22.12               | CI đã Node 22; nâng `engines` và ghi lý do                  |
| RAM máy đo thấp khi chạy worker + DB thật | test worker dùng một tiến trình, SimCloud, chu kỳ poll ngắn |
| Phiên bản schema pg-boss đổi              | ghim chính xác phiên bản; schema riêng `PGBOSS_SCHEMA`      |

## 7. Nhật ký review

| Vòng | Phát hiện                                                                           | Xử lý                                                   |
| ---- | ----------------------------------------------------------------------------------- | ------------------------------------------------------- |
| v1   | Runner không đưa tài nguyên pha trước vào `prior`; kế hoạch thật vỡ ở pha CLUSTER   | QĐ-3                                                    |
| v1   | `claim()` hiện có dùng đồng hồ ứng dụng, không lọc trạng thái                       | QĐ-2                                                    |
| v1   | Bootstrap namespace + ba SA (ADR-06) chưa ai làm dù `ClusterInfo` đã khai tên SA    | QĐ-4                                                    |
| v1   | `send()` qua `udp_s1` cần GRANT trên schema do pg-boss tạo lúc chạy                 | QĐ-1: outbox là `ProvisioningJob` + đối soát            |
| P4   | Bù trừ của runner gặp hàng `ORPHAN_SUSPECTED` ném lỗi chuyển trạng thái ngoài `try` | Đếm là orphan, không chạm; `compensate()` công khai     |
| P4   | `renew` đua với `transition` (version vừa tăng) ⇒ keeper tưởng mất lease            | Gia hạn và đổi state tuần tự trong một lượt             |
| P4   | Xoá `cluster_access` bằng `{ set: null }` ghi JSON sai                              | `Prisma.DbNull`                                         |
| P4   | Hủy khi QUEUED ghi `DEPLOY_FAILURE` không có `DEPLOY_START`                         | Chỉ khép lượt deploy đã bắt đầu                         |
| P7   | Chạy lại từ ERROR vỡ ở step đầu: hàng `DELETED` giữ khoá tất định                   | Đóng chu kỳ sổ trong transaction tạo job; orphan ⇒ chặn |

-- ============================================================
-- Nhóm C — bốn quyết định thiết kế.
--
-- Viết tay vì hai bước đổi dữ liệu sẵn có mà Prisma không tự sinh được:
-- đổi kiểu cột đang có dữ liệu, và đổi tên cột (Prisma thấy nó là xoá + thêm).
-- ============================================================

-- ------------------------------------------------------------
-- C1 — tập ĐÓNG do UDP sở hữu thì là enum
--
-- Quy tắc §2.4 phát biểu lại cho đúng thứ codebase vẫn làm: enum cho tập đóng
-- do UDP sở hữu, bảng danh mục cho tập mà **Domain Adapter** mở rộng. Đó là lý
-- do `domain_type` là FK tới `domain_catalog` chứ không phải enum — chỉ số
-- "0 file" của C2 (I28) đòi thêm domain không kéo theo migration.
--
-- `auth_kind` KHÔNG thuộc nhóm đó: tập của nó bị chặn trên bởi `CloudProvider`
-- vốn đã là enum, nên thêm một nhà cung cấp đã cần migration rồi — một bảng
-- danh mục riêng không tránh được migration nào mà chỉ thêm một join. Và chỉ số
-- "0 file" nói về Domain Adapter, không nói về Cloud Adapter.
-- ------------------------------------------------------------

CREATE TYPE "DomainTier" AS ENUM ('CORE', 'STANDARD', 'ADVANCED');
ALTER TABLE "domain_catalog"
  ALTER COLUMN "tier" TYPE "DomainTier" USING "tier"::"DomainTier";

CREATE TYPE "CloudAuthKind" AS ENUM (
  'AWS_ROLE', 'AWS_KEY', 'GCP_WIF', 'GCP_KEY', 'AZURE_FEDERATED', 'AZURE_SECRET'
);
ALTER TABLE "cloud_credentials"
  ALTER COLUMN "auth_kind" TYPE "CloudAuthKind" USING "auth_kind"::"CloudAuthKind";

-- ------------------------------------------------------------
-- C2 — environment không tự deploy thì sự kiện vẫn phải được GHI
--
-- Trước đây `auto_deploy = false` chỉ được mô tả là "tạo bản ghi chờ duyệt" mà
-- không có giá trị nào biểu diễn trạng thái đó. Hệ quả nếu để nguyên: webhook
-- tới, UDP im lặng không làm gì và không ghi gì — CI tưởng đã deploy, UDP không
-- có bản ghi, DORA đếm thiếu, và người dùng không có cách nào biết vì sao.
--
-- Dùng lại đúng khuôn `RolloutEvent.is_intent`: ghi ý định, thực thi tách rời.
-- ------------------------------------------------------------

ALTER TYPE "DeploymentEventType" ADD VALUE 'DEPLOY_PENDING' BEFORE 'DEPLOY_START';

-- ------------------------------------------------------------
-- C3 — lưu ĐUÔI khoá, không lưu phần bất biến
--
-- Khoá có dạng `udp_sk_{env}_{random}`. Tám ký tự đầu là `udp_sk_l` cho MỌI
-- khoá server ở live, nên cột `key_prefix` không phân biệt được khoá nào với
-- khoá nào — hỏng đúng mục đích nó sinh ra. Đuôi khoá là thứ Stripe và GitHub
-- cũng hiển thị, nên người dùng đã quen đối chiếu theo nó.
--
-- Giá trị cũ là tám ký tự ĐẦU nên không chuyển thành đuôi được; seed ghi lại.
-- ------------------------------------------------------------

ALTER TABLE "sdk_keys" RENAME COLUMN "key_prefix" TO "key_suffix";

-- ------------------------------------------------------------
-- C4 — nối event thực thi với intent đã sinh ra nó
--
-- Thiếu đường nối này thì quy trách nhiệm phải suy đoán theo thời gian, và
-- `triggered_by` trên event thực thi trở thành nguồn sự thật thứ ba dễ trôi.
-- Có nó: NULL = reconciler tự quyết (AUTO), có giá trị = đang thi hành ý định
-- của người dùng (MANUAL) — `triggered_by` thành suy ra được. Và hiệu hai
-- `created_at` cho thẳng độ trễ từ lúc bấm tới lúc traffic đổi, con số §8.5
-- cần cho E5 mà trước đó không đo được.
--
-- CASCADE: xoá intent thì event thực thi của nó cũng mất nghĩa.
-- ------------------------------------------------------------

ALTER TABLE "rollout_events" ADD COLUMN "caused_by_event_id" UUID;
ALTER TABLE "rollout_events"
  ADD CONSTRAINT "rollout_events_caused_by_event_id_fkey"
  FOREIGN KEY ("caused_by_event_id") REFERENCES "rollout_events"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

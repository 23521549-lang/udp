-- [v4.11] Plan #36 P1 — secret webhook CI/CD và idempotent của sự kiện deploy (§8.3).
--
-- 1. `domain_configs.webhook_secret`: secret HMAC mà pipeline dùng để ký lời báo về UDP. UDP
--    SINH nó (32 byte ngẫu nhiên), không phải người dùng chọn, nên nó không nằm trong
--    `tool_config` (thứ `configSchema` của adapter kiểm). Giá trị là `EncryptedCredential`
--    niêm phong như §4.3 — cột JSONB, chỉ hàng domain CICD dùng. Không bao giờ lên dây ở GET.
--
-- 2. Mỗi (deployment, environment, loại) chỉ MỘT sự kiện cho bốn loại deploy: hàng đợi
--    `udp-deploy` có thể giao một job cho hai worker (hết lease, khởi động lại), và DORA đếm
--    SUCCESS hai lần là Deployment Frequency sai. Khoá có `environment_id` vì provisioning ghi
--    một sự kiện MỖI environment cùng `deployment_id` (đã đo: dữ liệu hiện có không trùng theo
--    khoá này). Người ghi dùng `ON CONFLICT DO NOTHING`.
--
-- Đường lùi:
--   DROP INDEX "deployment_events_once_per_kind";
--   ALTER TABLE "domain_configs" DROP COLUMN "webhook_secret";

ALTER TABLE "domain_configs" ADD COLUMN "webhook_secret" JSONB;

CREATE UNIQUE INDEX "deployment_events_once_per_kind"
  ON "deployment_events" ("deployment_id", "environment_id", "event_type")
  WHERE "event_type" IN ('DEPLOY_PENDING', 'DEPLOY_START', 'DEPLOY_SUCCESS', 'DEPLOY_FAILURE');

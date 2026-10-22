-- [v4.12] Plan #60 QĐ-1 (UX-23) — lý do của sự kiện rollout dưới dạng MÃ + số.
--
-- `reason` (VARCHAR 255) là câu Service 3 viết sẵn bằng tiếng Việt: đúng cho nhật ký máy chủ và lý do gửi Service 2,
-- sai cho giao diện hai ngôn ngữ (bản tiếng Anh hiện câu tiếng Việt). `reason_detail` giữ cùng lý do ở dạng có cấu
-- trúc (`decisionDetailSchema` của @udp/shared-types: mã, ngưỡng, số đo) để Portal viết câu theo ngôn ngữ người xem.
-- NULL được: hàng cũ, và sự kiện không đến từ một vòng phân tích (ý định của người dùng, lỗi vận hành).
--
-- Quyền: S3 có INSERT trên CẢ bảng (20260908083000_service_roles) nên cột mới tự vào; S1 có SELECT cả bảng. Không
-- GRANT gì thêm, I22 không đổi.
--
-- Đường lùi:
--   ALTER TABLE "rollout_events" DROP COLUMN "reason_detail";

ALTER TABLE "rollout_events" ADD COLUMN "reason_detail" JSONB;

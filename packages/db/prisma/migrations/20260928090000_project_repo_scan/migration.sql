-- [v4.11] Plan #48 QĐ-5 — kết quả quét repo của Import Existing (§11.2).
--
-- `projects.repo_scan`: kết quả MỚI NHẤT của `POST /projects/:id/repo-scan` — phát hiện, đề xuất,
-- `flagLevelReady` mà thẻ "Sẵn sàng cho flag-level rollout" ở Tổng quan đọc, không phải quét lại mỗi
-- lần mở trang (API của GitHub giới hạn 60 lượt/giờ khi không có token). Token của repo riêng tư chỉ
-- dùng trong lượt quét, không bao giờ nằm ở đây. S1 đã có UPDATE cấp BẢNG trên `projects`.
--
-- Đường lùi:
--   ALTER TABLE "projects" DROP COLUMN "repo_scan";

ALTER TABLE "projects" ADD COLUMN "repo_scan" JSONB;

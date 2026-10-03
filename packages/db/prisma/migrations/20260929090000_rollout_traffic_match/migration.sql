-- [v4.11] Plan #51 QĐ-7 — ATTRIBUTE_SPLIT ở SERVICE_LEVEL (§7.2).
--
-- `rollout_sessions.traffic_match`: `{ header, value }` — nhóm người dùng đi phiên bản mới là request mang
-- header này (route của Service 3 trong VirtualService với Argo Rollouts; `analysis.match` của Flagger). FLAG_LEVEL
-- lấy nhóm từ điều kiện của rule nên để NULL. S1 chỉ GHI lúc tạo (INSERT cấp bảng); S3 chỉ ĐỌC (SELECT cấp bảng)
-- — không đổi quyền nào.
--
-- Đường lùi:
--   ALTER TABLE "rollout_sessions" DROP COLUMN "traffic_match";

ALTER TABLE "rollout_sessions" ADD COLUMN "traffic_match" JSONB;

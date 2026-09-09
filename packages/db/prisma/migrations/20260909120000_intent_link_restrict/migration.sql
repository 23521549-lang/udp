-- ============================================================
-- `caused_by_event_id`: CASCADE → RESTRICT.
--
-- Phát hiện ở bước kiểm thoái cấp của chính plan này. CASCADE trên một self-FK
-- của BẢNG SỰ KIỆN có nghĩa: xoá một intent thì event thực thi tương ứng cũng
-- biến mất. Nhưng event thực thi là bản ghi rằng traffic ĐÃ đổi thật — nó vẫn
-- đúng kể cả khi ý định sinh ra nó bị xoá. CASCADE ở đây xoá sự thật.
--
-- SET NULL cũng sai, và sai âm thầm hơn: `triggered_by` được thiết kế để suy ra
-- từ cột này (NULL = reconciler tự quyết), nên mất liên kết sẽ biến một hành
-- động thủ công thành AUTO mà không có gì báo.
--
-- RESTRICT nói đúng điều cần nói: không xoá được một ý định đã được thi hành.
-- Xoá cả RolloutSession vẫn chạy trót vì mọi event của nó biến mất trong CÙNG
-- một câu lệnh — Postgres không kích RESTRICT với hàng bị xoá cùng lệnh, đã đo
-- ở ca xoá FeatureFlag (I39e).
-- ============================================================

ALTER TABLE "rollout_events" DROP CONSTRAINT "rollout_events_caused_by_event_id_fkey";
ALTER TABLE "rollout_events"
  ADD CONSTRAINT "rollout_events_caused_by_event_id_fkey"
  FOREIGN KEY ("caused_by_event_id") REFERENCES "rollout_events"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

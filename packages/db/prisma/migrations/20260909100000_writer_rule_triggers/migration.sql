-- ============================================================
-- B1 + B3 — hoàn tất ma trận writer §1.2.
--
-- GRANT diễn đạt được "ai chạm bảng nào, cột nào", nhưng KHÔNG diễn đạt được
-- "ai được ghi GIÁ TRỊ nào". §1.2 có đúng một luật thuộc loại thứ hai:
--
--   Service 1 chỉ ghi RolloutEvent với is_intent = true  (ý định của người dùng)
--   Service 3 chỉ ghi RolloutEvent với is_intent = false (đã thực thi trên cluster)
--
-- Đó là trụ chống race của ADR-01: chỉ tồn tại MỘT writer tới đối tượng điều
-- khiển traffic. Trước migration này, cả hai role có INSERT phẳng nên luật chỉ
-- sống trong văn bản — và tệ hơn, bất biến I22 vẫn xanh vì nó ghi lại đúng cái
-- grant phẳng đó. Một bất biến khẳng định hiện trạng thay vì khẳng định ý đồ.
-- ============================================================

CREATE OR REPLACE FUNCTION udp_check_rollout_event_writer()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- Chỉ ràng buộc khi ghi DƯỚI DANH NGHĨA một service role. Owner của schema
  -- (migration, seed, công cụ vận hành) không đi qua luật này: nó là luật phân
  -- chia giữa ba service, không phải luật về nội dung dữ liệu.
  IF current_user = 'udp_s1' AND NEW.is_intent IS NOT TRUE THEN
    RAISE EXCEPTION 'WRITER_VIOLATION: Service 1 chi duoc ghi RolloutEvent voi is_intent = true (§1.2)'
      USING ERRCODE = 'UDP03';
  END IF;

  IF current_user = 'udp_s3' AND NEW.is_intent IS NOT FALSE THEN
    RAISE EXCEPTION 'WRITER_VIOLATION: Service 3 chi duoc ghi RolloutEvent voi is_intent = false (§1.2)'
      USING ERRCODE = 'UDP03';
  END IF;

  RETURN NEW;
END;
$fn$;

-- UDP03 CỐ Ý không nằm trong ERROR_CATALOG. Vi phạm này không phải lỗi người
-- dùng sửa được mà là bug của service — nó phải ra 500 và vào cảnh báo, không
-- phải thành một thông báo lịch sự trên giao diện. Vẫn dùng SQLSTATE riêng để
-- lọc được trong log và để sau này muốn map thì có sẵn chỗ.
CREATE TRIGGER trg_rollout_event_writer
  BEFORE INSERT OR UPDATE ON "rollout_events"
  FOR EACH ROW
  EXECUTE FUNCTION udp_check_rollout_event_writer();

-- B3 — S3 đọc rule đang rollout, mà rule có thể tham chiếu segment (rule_type
-- = 'SEGMENT'). Thiếu quyền này thì reconciler chết bằng 42501 giữa vòng lặp,
-- ở đúng nhánh ít được chạy nhất.
GRANT SELECT ON segments TO udp_s3;

-- Service 3 đánh dấu intent đã xử lý (§2.2 `rollout_events.processed_at`, §7.6).
--
-- Trước migration này, `udp_s3` chỉ có SELECT + INSERT trên rollout_events (ma
-- trận §1.2 gọi bảng này là append-only). Nhưng §2.2 khai `processed_at` là "thời
-- điểm Service 3 đã nhặt và thực thi ý định", và `idx_rollout_event_pending_intent`
-- lọc theo cột đó — tức thiết kế đã dự tính S3 GHI đúng một cột của một hàng do S1
-- tạo. Đo ngày 12/09/2026: `UPDATE rollout_events SET processed_at = now()` dưới
-- `udp_s3` ⇒ 42501. Không có quyền này, reconciler phải suy "đã xử lý" từ sự tồn
-- tại của event thực thi — được, nhưng lệch tài liệu và bỏ phí index.
--
-- Cấp ĐÚNG MỘT cột. Mọi cột khác của rollout_events vẫn bất biến với S3 (I22 kiểm
-- từng ô; I30 phần luật giá trị có test riêng cho hàng intent).
GRANT UPDATE (processed_at) ON rollout_events TO udp_s3;

-- Trigger writer đang là BEFORE INSERT OR UPDATE và kiểm `NEW.is_intent` cho cả
-- hai: một UPDATE của S3 lên hàng intent (is_intent = true) sẽ bị UDP03 dù chỉ
-- chạm processed_at — hàng rào chặn nhầm chính hành vi thiết kế yêu cầu.
--
-- Tách hai luật theo TG_OP:
--   INSERT: luật cũ — S1 chỉ ghi is_intent = true, S3 chỉ ghi is_intent = false.
--   UPDATE: chỉ S3, chỉ đánh dấu MỘT LẦN (NULL → có), không xoá dấu, không sửa
--           gì khác (GRANT theo cột đã chặn, trigger chặn thêm để luật đọc được
--           ở một chỗ). Owner của schema vẫn không đi qua luật này.
CREATE OR REPLACE FUNCTION udp_check_rollout_event_writer()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user = 'udp_s1' AND NEW.is_intent IS NOT TRUE THEN
      RAISE EXCEPTION 'WRITER_VIOLATION: Service 1 chi duoc ghi RolloutEvent voi is_intent = true (§1.2)'
        USING ERRCODE = 'UDP03';
    END IF;

    IF current_user = 'udp_s3' AND NEW.is_intent IS NOT FALSE THEN
      RAISE EXCEPTION 'WRITER_VIOLATION: Service 3 chi duoc ghi RolloutEvent voi is_intent = false (§1.2)'
        USING ERRCODE = 'UDP03';
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE
  IF current_user = 'udp_s1' THEN
    RAISE EXCEPTION 'WRITER_VIOLATION: Service 1 khong duoc sua RolloutEvent (§1.2)'
      USING ERRCODE = 'UDP03';
  END IF;

  IF current_user = 'udp_s3' THEN
    IF OLD.is_intent IS NOT TRUE THEN
      RAISE EXCEPTION 'WRITER_VIOLATION: Service 3 chi danh dau processed_at tren hang intent (§2.2)'
        USING ERRCODE = 'UDP03';
    END IF;
    IF OLD.processed_at IS NOT NULL OR NEW.processed_at IS NULL THEN
      RAISE EXCEPTION 'WRITER_VIOLATION: processed_at chi duoc dat MOT lan, khong duoc xoa (§2.2)'
        USING ERRCODE = 'UDP03';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

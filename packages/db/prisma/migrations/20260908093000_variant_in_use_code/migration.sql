-- ============================================================
-- Tách VARIANT_IN_USE (UDP02) khỏi ORPHAN_RULE (UDP01).
--
-- Trước đây cả hai chiều của §6.7 cùng ném UDP01, nên tầng application chỉ trả
-- được một mã và một status. Nhưng hai chiều khác nhau đúng ở chỗ quan trọng
-- nhất với người gọi:
--
--   Lưu rule trỏ variant lạ   → request SAI NỘI DUNG, gửi lại vẫn hỏng   → 422, không retryable
--   Xoá variant đang dùng     → request ĐÚNG, trạng thái xung đột        → 409, RETRYABLE
--
-- Gộp chúng làm mất `retryable` và `suggestedAction` — hai trường §9 sinh ra để
-- Portal biết nên hiện nút "Sửa rule" hay nút "Thử lại".
--
-- Tiền tố của thông báo cũng đổi theo mã, vì tầng application cắt đúng tiền tố
-- đó ra khỏi `detail` (`stripCodePrefix`).
-- ============================================================

CREATE OR REPLACE FUNCTION udp_check_variant_not_referenced()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM flag_targeting_rules r
    WHERE r.serve @> jsonb_build_object('variantId', OLD.id::text)
       OR r.serve @> jsonb_build_object(
            'weights', jsonb_build_array(jsonb_build_object('variantId', OLD.id::text))
          )
  ) THEN
    RAISE EXCEPTION 'VARIANT_IN_USE: variant % con duoc rule tham chieu qua serve, go rule do truoc roi thu lai', OLD.id
      USING ERRCODE = 'UDP02';
  END IF;

  RETURN NULL;
END;
$fn$;

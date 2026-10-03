-- [v4.3] trackedFlags lưu ở đâu, và kill-switch của Service 3 đủ điều kiện chạy.
--
-- Đường lùi: DROP INDEX flag_env_configs_tracked_idx; ALTER TABLE flag_env_configs
-- DROP COLUMN is_tracked; REVOKE SELECT (flag_env_config_id) ON rollout_sessions
-- FROM udp_s2; REVOKE UPDATE (updated_at) ON flag_env_configs FROM udp_s3; và
-- CREATE OR REPLACE FUNCTION udp_check_rule_serve_variants() về bản của migration
-- `orphan_rule_hardening`. Migration này chỉ THÊM: không xoá, không sửa dữ liệu.

-- ------------------------------------------------------------
-- 1. Tập tracked (§6.6)
-- ------------------------------------------------------------
-- Theo (flag, environment): "tập tracked của environment" là các hàng
-- `is_tracked` của environment đó. Cột nằm trên flag_env_configs vì Service 2 là
-- writer của bảng này (đổi nó đi qua transaction ADR-05 như mọi cấu hình khác), và
-- câu lệnh snapshot vốn đã join bảng này theo environment.
ALTER TABLE flag_env_configs
  ADD COLUMN is_tracked BOOLEAN NOT NULL DEFAULT false;

-- Trần 3 flag mỗi environment được đếm dưới row-lock của environment, và lưới gỡ
-- nhãn của Service 3 quét đúng các hàng này: cả hai chỉ cần phần nhỏ của bảng.
CREATE INDEX flag_env_configs_tracked_idx
  ON flag_env_configs (environment_id)
  WHERE is_tracked;

-- ------------------------------------------------------------
-- 2. Service 2 đọc cột thứ sáu của rollout_sessions
-- ------------------------------------------------------------
-- Migration `s2_reads_rollout_sessions` cố ý KHÔNG cấp `flag_env_config_id` vì
-- mọi phép kiểm của S2 khi đó đều theo rule. [v4.3] đổi lý do đó:
--   * `POST /internal/rollouts/:sessionId/track|untrack` nhận id session và phải
--     biết flag/environment nào;
--   * `untrack` phải bỏ qua khi config còn session ĐANG CHẠY — không thì lệnh
--     untrack của rollout vừa xong tới muộn sẽ gỡ nhãn của rollout mới (hai
--     session cùng flag khác workload chạy song song được, và index một-active
--     khoá theo cả workload). Phép kiểm đó đọc đúng `status` + `flag_env_config_id`.
-- Vẫn liệt kê tĩnh: cột thêm về sau không tự rơi vào quyền của S2.
GRANT SELECT (flag_env_config_id) ON rollout_sessions TO udp_s2;

-- ------------------------------------------------------------
-- 3. Quyền hẹp thứ tư của kill-switch
-- ------------------------------------------------------------
-- Đường ramp của S2 đẩy `flag_env_configs.updated_at` sau khi đổi trọng số, để
-- người đang mở danh sách rule từ trước nhận 409 thay vì lưu đè phần trăm rollout
-- vừa đặt. Kill-switch ghi `serve` thay S2 (§7.6), nên phải giữ đúng bảo đảm đó:
-- thiếu quyền này thì một lần lưu rule bằng dữ liệu cũ lặng lẽ bật lại traffic
-- mà kill-switch vừa tắt. Đúng MỘT cột; I22 kiểm từng ô.
GRANT UPDATE (updated_at) ON flag_env_configs TO udp_s3;

-- ------------------------------------------------------------
-- 4. Thứ tự `weights` do database cưỡng chế (§6.4, §6.7)
-- ------------------------------------------------------------
-- `pickVariant` cộng dồn theo thứ tự mảng, nên hai thứ tự của cùng một phân phối
-- gán người dùng cho hai nhóm khác nhau (I1). Mọi writer đi qua
-- `canonicalizeServe` (sắp theo `variantId`, so chuỗi của JS); kill-switch là
-- writer đầu tiên đi vòng qua Service 2, nên luật chuyển xuống database.
--
-- Ba chi tiết có chủ đích:
--   * Kiểm thứ tự SAU phép kiểm orphan (UDP01): một serve vừa trỏ variant lạ vừa
--     sai thứ tự phải báo UDP01 — mã có nghĩa với người dùng — chứ không phải UDP04.
--   * So chuỗi `variantId` gốc bằng COLLATE "C": trùng phép so `<` của JS trên
--     UUID (đo 12/09/2026, 300 uuid ngẫu nhiên), không phụ thuộc locale database.
--   * Phép kiểm THỨ TỰ chỉ chạy khi INSERT hoặc khi `serve` THẬT SỰ đổi: hàng cũ
--     ghi trước khi có canonicalizeServe vẫn sửa được priority/condition. Phép kiểm
--     orphan (UDP01) vẫn chạy ở MỌI lần ghi như trước — đổi `flag_env_config_id`
--     mà giữ nguyên `serve` cũng có thể biến một variant hợp lệ thành variant lạ.
--     Không sắp lại hàng cũ ở đây: đổi thứ tự là đổi nhóm người dùng mà
--     `config_version` không tăng.
--
-- UDP04 là lỗi của WRITER, không của người dùng — cùng tiền lệ UDP03: không vào
-- ERROR_CATALOG, tầng ứng dụng để nó thành 500.
CREATE OR REPLACE FUNCTION udp_check_rule_serve_variants()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  bad uuid;
  unsorted boolean;
BEGIN
  SELECT vid INTO bad
  FROM unnest(udp_serve_variant_ids(NEW.serve)) AS vid
  WHERE NOT EXISTS (
    SELECT 1
    FROM flag_variants fv
    JOIN flag_env_configs fec ON fec.flag_id = fv.flag_id
    WHERE fec.id = NEW.flag_env_config_id
      AND fv.id = vid
  )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'ORPHAN_RULE: serve tro toi variant % khong thuoc flag cua rule nay', bad
      USING ERRCODE = 'UDP01';
  END IF;

  IF NEW.serve->>'kind' = 'distribution'
     AND (TG_OP = 'INSERT' OR NEW.serve IS DISTINCT FROM OLD.serve) THEN
    SELECT EXISTS (
      SELECT 1
      FROM (
        SELECT w->>'variantId' AS id,
               lag(w->>'variantId') OVER (ORDER BY ord) AS prev
        FROM jsonb_array_elements(NEW.serve->'weights') WITH ORDINALITY AS t(w, ord)
      ) pairs
      WHERE prev IS NOT NULL
        AND NOT (prev COLLATE "C" < id COLLATE "C")
    ) INTO unsorted;

    IF unsorted THEN
      RAISE EXCEPTION 'SERVE_ORDER: serve.weights phai sap tang dan theo variantId'
        USING ERRCODE = 'UDP04';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

-- Báo cho vận hành biết có bao nhiêu hàng cũ chưa sắp — chúng vẫn phục vụ đúng
-- (thứ tự là một phần của cấu hình đã lưu), nhưng lần sửa `serve` kế tiếp phải
-- đi qua canonicalizeServe.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM flag_targeting_rules r
  WHERE r.serve->>'kind' = 'distribution'
    AND EXISTS (
      SELECT 1
      FROM (
        SELECT w->>'variantId' AS id,
               lag(w->>'variantId') OVER (ORDER BY ord) AS prev
        FROM jsonb_array_elements(r.serve->'weights') WITH ORDINALITY AS t(w, ord)
      ) pairs
      WHERE prev IS NOT NULL
        AND NOT (prev COLLATE "C" < id COLLATE "C")
    );
  IF n > 0 THEN
    RAISE NOTICE 'tracked_flags_killswitch: % rule co weights chua sap theo variantId (van phuc vu dung; lan sua serve ke tiep phai sap)', n;
  END IF;
END;
$$;

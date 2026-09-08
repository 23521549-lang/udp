-- ============================================================
-- Vá ORPHAN_RULE sau QA.
--
-- Bản trong 20260908042500_constraints có bốn lỗ, cả bốn đã tái hiện được
-- bằng SQL thật trên database:
--
--  1. `kind` sai chính tả, `serve` là JSON null, hay thiếu `weights` đều rơi
--     vào nhánh ELSE và trả mảng rỗng, nên trigger IM LẶNG cho qua. Nguy hiểm
--     vì §1.2 cho Service 3 quyền UPDATE thẳng cột `serve` trong nhánh
--     DEPENDENCY_DOWN — đường ghi đó không đi qua zod, trigger là hàng rào duy nhất.
--  2. Một phần tử `variantId: null` làm `NOT EXISTS (... fv.id = vid)` thành
--     TRUE, `SELECT ... INTO bad` gán NULL, và `IF bad IS NOT NULL` cho qua —
--     nuốt luôn mọi variantId lạ đứng sau nó trong mảng.
--  3. `variantId` không phải uuid ném 22P02 thay vì UDP01, nên tầng application
--     sẽ trả 500 thay vì 422.
--  4. FK trên `default_variant_id` chỉ cưỡng chế TỒN TẠI, không cưỡng chế
--     QUYỀN SỞ HỮU: đặt default của flag A bằng variant của flag B vẫn lọt.
--     §6.7 đòi chặn "rule HOẶC default trỏ variant không hợp lệ".
--
-- Nguyên tắc sửa: hàm trích không bao giờ trả về im lặng cho một hình dạng nó
-- không hiểu. Không hiểu thì NÉM, vì "không có variantId nào" và "tôi không
-- đọc nổi cái này" là hai chuyện khác hẳn nhau.
-- ============================================================

CREATE OR REPLACE FUNCTION udp_serve_variant_ids(serve JSONB)
RETURNS uuid[]
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  ids uuid[];
BEGIN
  IF serve IS NULL OR jsonb_typeof(serve) <> 'object' THEN
    RAISE EXCEPTION 'ORPHAN_RULE: serve phai la object, dang la %', COALESCE(jsonb_typeof(serve), 'NULL')
      USING ERRCODE = 'UDP01';
  END IF;

  BEGIN
    CASE serve->>'kind'
      WHEN 'variant' THEN
        ids := ARRAY[(serve->>'variantId')::uuid];
      WHEN 'distribution' THEN
        IF jsonb_typeof(serve->'weights') <> 'array' THEN
          RAISE EXCEPTION 'ORPHAN_RULE: serve.weights phai la mang, dang la %',
            COALESCE(jsonb_typeof(serve->'weights'), 'NULL')
            USING ERRCODE = 'UDP01';
        END IF;
        ids := ARRAY(
          SELECT (w->>'variantId')::uuid
          FROM jsonb_array_elements(serve->'weights') AS w
        );
      ELSE
        RAISE EXCEPTION 'ORPHAN_RULE: serve.kind khong hop le: %', COALESCE(serve->>'kind', '<thieu>')
          USING ERRCODE = 'UDP01';
    END CASE;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'ORPHAN_RULE: serve chua variantId khong phai uuid'
        USING ERRCODE = 'UDP01';
  END;

  IF ids IS NULL OR array_length(ids, 1) IS NULL THEN
    RAISE EXCEPTION 'ORPHAN_RULE: serve khong chua variantId nao'
      USING ERRCODE = 'UDP01';
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(ids) AS x WHERE x IS NULL) THEN
    RAISE EXCEPTION 'ORPHAN_RULE: serve chua variantId rong'
      USING ERRCODE = 'UDP01';
  END IF;

  RETURN ids;
END;
$fn$;

-- Dùng FOUND thay vì `bad IS NOT NULL`: FOUND đúng cả khi giá trị lấy ra là
-- NULL. Hàm trên đã chặn NULL rồi, nhưng điều kiện dừng không nên phụ thuộc
-- vào việc một hàm khác giữ lời hứa.
CREATE OR REPLACE FUNCTION udp_check_rule_serve_variants()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  bad uuid;
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

  RETURN NEW;
END;
$fn$;

-- Đổi sang toán tử chứa `@>` thay vì gọi hàm trên từng hàng.
--
-- Hai lý do. Một, `@>` dùng được GIN index flag_targeting_rules_serve_idx, còn
-- vị từ dạng lời gọi hàm thì buộc quét toàn bảng — mà bảng này chứa rule của
-- MỌI project, và trigger deferred chạy một lần cho MỖI variant bị xóa, dồn
-- hết vào lúc COMMIT. Hai, ở đây ta chỉ hỏi "có ai trỏ tới id này không", một
-- câu hỏi không cần hiểu toàn bộ hình dạng, nên không nên ném lỗi vì hình dạng.
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
    RAISE EXCEPTION 'ORPHAN_RULE: variant % con duoc rule tham chieu qua serve', OLD.id
      USING ERRCODE = 'UDP01';
  END IF;

  RETURN NULL;
END;
$fn$;

-- ------------------------------------------------------------
-- Nửa còn thiếu của §6.7: default variant phải THUỘC chính flag đó.
--
-- FK trên default_variant_id chỉ nói "variant này tồn tại", không nói "variant
-- này là của tôi". Không có hai trigger dưới đây thì đặt default của flag A
-- bằng variant của flag B là hợp lệ với database — evaluator sẽ trả một giá
-- trị thuộc flag khác, đúng loại lỗi §6.5 mô tả.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION udp_check_flag_default_variant()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.default_variant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM flag_variants fv
    WHERE fv.id = NEW.default_variant_id AND fv.flag_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'ORPHAN_RULE: default variant % khong thuoc flag %', NEW.default_variant_id, NEW.id
      USING ERRCODE = 'UDP01';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_flag_default_variant
  BEFORE INSERT OR UPDATE ON "feature_flags"
  FOR EACH ROW
  EXECUTE FUNCTION udp_check_flag_default_variant();

CREATE OR REPLACE FUNCTION udp_check_envconfig_default_variant()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.default_variant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM flag_variants fv
    WHERE fv.id = NEW.default_variant_id AND fv.flag_id = NEW.flag_id
  ) THEN
    RAISE EXCEPTION 'ORPHAN_RULE: default variant % khong thuoc flag % cua env config',
      NEW.default_variant_id, NEW.flag_id
      USING ERRCODE = 'UDP01';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_envconfig_default_variant
  BEFORE INSERT OR UPDATE ON "flag_env_configs"
  FOR EACH ROW
  EXECUTE FUNCTION udp_check_envconfig_default_variant();

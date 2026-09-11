-- Dọn ConfigChangeLog quá hạn (§2.2, I18) — quyền HẸP qua một hàm, không phải DELETE.
--
-- §2.2 nói "job nền xoá dòng cũ hơn 7 ngày", nhưng ma trận §1.2 không cho role nào
-- DELETE trên config_change_log (S1 SELECT, S2 SELECT + INSERT, S3 INSERT). Nên
-- trước migration này, chưa từng có gì dọn bảng: nó phình vô hạn.
--
-- Cấp DELETE phẳng cho udp_s2 là cho nó xoá cả dòng MỚI — tức xoá dấu vết lan truyền
-- mà replica đang cần. Hàm dưới đây cấp ĐÚNG một quyền: xoá dòng quá 7 ngày, theo lô.
-- Retention viết cứng trong thân hàm, không nhận tham số: S2 không thể truyền
-- "0 ngày" để xoá sạch sổ. Con số phải bằng CHANGE_FEED.retentionDays —
-- packages/design-lint/tests/retention.test.ts chốt trôi.
--
-- SECURITY DEFINER chạy bằng quyền owner, nên phòng thủ chiều sâu: search_path cố
-- định (pg_temp đứng CUỐI để không ai chen object tạm lên trước), và mọi tên đều
-- viết đủ schema.
CREATE FUNCTION udp_prune_config_change_log(max_rows integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted integer;
BEGIN
  IF max_rows IS NULL OR max_rows < 1 OR max_rows > 10000 THEN
    RAISE EXCEPTION 'max_rows phải trong [1, 10000], nhận %', max_rows
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.config_change_log
   WHERE id IN (
     SELECT id
       FROM public.config_change_log
      WHERE created_at < pg_catalog.now() - interval '7 days'
      ORDER BY created_at
      LIMIT max_rows
   );

  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END
$$;

-- Hàm mới trong schema public mặc định cho PUBLIC quyền EXECUTE. Đã đo trên
-- Supabase: ngay sau CREATE, anon/authenticated/service_role và cả ba udp_s* đều
-- gọi được — tức gọi được qua REST của nền tảng. Thu hồi TRƯỚC khi cấp.
REVOKE ALL ON FUNCTION udp_prune_config_change_log(integer) FROM PUBLIC;

-- Role của nền tảng: ở instance này quyền của chúng đến qua PUBLIC (đã đo), nhưng
-- một instance khác có thể cấp tường minh bằng default privileges. PostgreSQL
-- thường không có các role này, nên thu hồi có điều kiện thay vì để migration gãy.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION udp_prune_config_change_log(integer) FROM %I', r
      );
    END IF;
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION udp_prune_config_change_log(integer) TO udp_s2;

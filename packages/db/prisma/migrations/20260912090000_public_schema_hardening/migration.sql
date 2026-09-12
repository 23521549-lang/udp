-- Thu hồi quyền MẶC ĐỊNH mà nền tảng cấp cho các role của nó trên schema public
-- (§13.5, I22 [v4.2]).
--
-- Hai phép đo ngày 12/09/2026 trên hai project Supabase:
--   - project dev:  0 dòng pg_default_acl cho schema public; PUBLIC không có USAGE.
--   - project MỚI:  6 dòng — role postgres (và supabase_admin) cấp SẴN toàn quyền
--     (bảng: arwdDxtm, sequence: rwU, hàm: X) cho anon, authenticated,
--     service_role trên MỌI đối tượng mới trong public; PUBLIC và ba role đó có
--     USAGE trên schema.
-- Database dùng-một-lần tạo từ template1 không mang dòng nào trong số đó, nên
-- I22 xanh trên CI trong khi cùng chuỗi migration chạy lên `postgres` của một
-- project mới sẽ mở mọi bảng UDP cho ba role nền tảng — một cửa vào không đi qua
-- ma trận writer §1.2, và không role nào của UDP tạo ra.
--
-- Vì sao là MIGRATION, không phải script hay quy trình: nó chạy ở mọi database
-- được `migrate deploy`, được `verify-chain`/`test:scratch` dựng lại từ số 0, và
-- không ai phải nhớ. Idempotent: REVOKE về mặc định thì PostgreSQL xoá luôn dòng
-- pg_default_acl; chạy lần hai không đổi gì.
--
-- Chốt thật sự là REVOKE USAGE trên schema: đã đo, sau khi thu hồi, hàm THƯỜNG
-- trong public vẫn có EXECUTE cho ba role qua PUBLIC (mặc định của PostgreSQL),
-- nhưng `SET ROLE anon; SELECT public.f()` vẫn bị `42501 permission denied for
-- schema public`. Các REVOKE trên bảng/sequence/hàm là lớp thứ hai, cho ngày
-- ai đó cấp lại USAGE.
--
-- Không đụng default privilege của supabase_admin: nó chỉ áp lên đối tượng do
-- chính supabase_admin tạo, UDP không tạo gì bằng role đó, và role chạy
-- migration cũng không sửa được nó.
--
-- Tự kiểm ở cuối: REVOKE bởi role không phải owner chỉ WARNING ("no privileges
-- could be revoked"), migration vẫn "thành công" mà không làm gì. Nên đọc lại ACL
-- và RAISE nếu còn — gãy to hơn im lặng. Chỉ soi default privilege của những role
-- THẬT SỰ tạo đối tượng trong public (owner của bảng hiện có, và role đang chạy
-- migration): dòng của role khác không có nghĩa với đối tượng của UDP.
--
-- Cách lùi (chỉ khi thật sự cần Data API của nền tảng trên database này):
--   GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
--   (tương tự SEQUENCES, FUNCTIONS) — và chấp nhận I22 đỏ ở đó.

DO $$
DECLARE
  provider_role text;
  leftover text;
BEGIN
  FOREACH provider_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = provider_role) THEN
      CONTINUE;
    END IF;

    -- Default privilege của role đang chạy migration, cả phạm vi schema public
    -- lẫn phạm vi toàn cục — cùng một role có thể có cả hai.
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', provider_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', provider_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', provider_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM %I', provider_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM %I', provider_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM %I', provider_role);

    -- Quyền ĐÃ cấp trên đối tượng hiện có (bảng tạo trước migration này).
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', provider_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', provider_role);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', provider_role);

    -- Chốt: không vào được schema thì không chạm được gì bên trong.
    EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', provider_role);
  END LOOP;

  -- Mặc định PostgreSQL 15+ cho PUBLIC USAGE trên public; udp_s1..3 đã có USAGE
  -- tường minh (migration service_roles) nên không mất gì.
  REVOKE USAGE ON SCHEMA public FROM PUBLIC;

  SELECT string_agg(DISTINCT who, ', ' ORDER BY who) INTO leftover
    FROM (
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS who
        FROM pg_namespace n,
             aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
       WHERE n.nspname = 'public'
         AND (a.grantee = 0
              OR a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role'))
      UNION ALL
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
        FROM pg_default_acl d,
             aclexplode(d.defaclacl) a
       WHERE d.defaclnamespace = 'public'::regnamespace
         AND d.defaclrole IN (
               SELECT c.relowner FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
               UNION SELECT current_user::regrole::oid
             )
         AND (a.grantee = 0
              OR a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role'))
    ) x;

  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'public_schema_hardening: sau khi thu hồi vẫn còn quyền của % trên schema public — role chạy migration không phải owner của schema hay của default privilege', leftover;
  END IF;
END $$;

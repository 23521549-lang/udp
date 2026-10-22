-- [v4.12, Plan #61 61d-2a] Trusted Deploy (AC-11): token OIDC của một lượt chạy CI dùng MỘT lần, và cờ
-- bắt buộc của chế độ đó.
--
-- 1. `domain_configs.oidc_required` — Trusted Deploy đã bắt buộc chưa. Cùng lý lẽ với `webhook_secret`
--    của Plan #36 (UDP quyết, không phải trường `configSchema` của adapter), và còn một lý do cứng hơn:
--    đường ghi DUY NHẤT của `tool_config` là `replaceDomains`, vốn `upsert` với `toolConfig: t.config`
--    tức ghi đè TOÀN PHẦN, và khoá lạc quan của nó đòi project còn ở trạng thái sửa được. Một cờ nằm
--    trong `tool_config` sẽ bị xoá IM LẶNG mỗi lần người dùng lưu cấu hình domain, và không bao giờ tự
--    bật được cho project đang chạy. Để ở cột riêng thì lỗi đó biến mất về mặt cấu trúc, không cần một
--    dòng mã nào.
--
-- 2. `webhook_token_uses` — "dùng một lần" là ràng buộc của DATABASE (I41), không phải một phép kiểm
--    trong mã. Bảng KHÔNG lưu token: chỉ mã định danh của nó (`jti`, hay `oidc.circleci.com/job-id` với
--    CircleCI vì CircleCI không phát `jti` — đã đọc tại tài liệu của họ). I24 cấm token xuống database
--    hay đĩa, và luật "không ghi thân hay header" của §8.3 phủ cả header `Authorization`.
--
--    `body_digest` là thứ phân biệt RETRY với REPLAY. Nó giữ chính chuỗi HMAC hex đã được kiểm, tức một
--    digest CÓ KHOÁ của thân. Lần trình lại với thân giống hệt từng byte là retry của CI (mạng rớt sau
--    khi server đã commit) và phải trả lại kết quả cũ; lần trình lại với thân KHÁC là replay và phải bị
--    từ chối. So theo `pipeline_id` là KHÔNG đủ: phép chống trùng sẵn có tính cả `environment_id`, nên
--    cùng `pipeline_id` mà đổi `environment` sang production sẽ lọt.
--
--    Đường ghi dùng `INSERT ... ON CONFLICT DO NOTHING` chứ không bắt lỗi trùng khoá: `23505` ABORT cả
--    transaction nên sau đó không đọc được hàng cũ để phân biệt retry với replay, và mọi thứ ghi cùng
--    transaction mất theo. Repo đã có tiền lệ viết thành chữ ở `provisioning/prisma-ledger.ts`.
--
--    `used_at` do DATABASE điền bằng `clock_timestamp()`: hàng này là bằng chứng cho một lần cho phép
--    deploy và sẽ bị đối chiếu với `deployment_events.occurred_at` — cột duy nhất do database cấp sau
--    migration `20261002040000_deploy_event_time_from_database`. Với độ lệch đã đo 1 567 ms giữa đồng hồ
--    máy và đồng hồ database, một `used_at` theo đồng hồ máy có thể nằm SAU chính sự kiện nó cho phép.
--    Hàng chỉ sinh đúng lúc dùng nên cột này thay vai `created_at`.
--
--    `expires_at` KHÔNG phải một DEFAULT: nó là `exp` của chính token đã xác minh. Không được nhỏ hơn
--    `exp`, nếu không lượt dọn xoá hàng trong lúc token còn sống và cửa sổ replay mở lại.
--
--    Tên index unique ghim tường minh (`webhook_token_uses_once`): hai chỗ trong repo bắt lỗi trùng bằng
--    cách so TÊN index với một hằng số, nên để Postgres/Prisma tự sinh tên là mở đường cho một lần đổi
--    tên im lặng.
--
-- 3. Hàm dọn. Quyền DELETE không cấp cho role nào — dọn đi qua một hàm `SECURITY DEFINER` với retention
--    viết CỨNG trong thân, đúng khuôn `udp_prune_config_change_log`: bên gọi không truyền được "0 ngày"
--    để xoá sạch cửa sổ chống replay. Chống replay chỉ cần giữ tới `exp` (token sống vài phút), nên
--    7 ngày là để có dấu vết pháp y "lượt chạy nào đã cho phép lần deploy này".
--
-- QUYỀN: `udp_s1` SELECT + INSERT (append-only, không UPDATE — hàng là một sự kiện). `udp_s2` và
-- `udp_s3` KHÔNG một quyền nào, kể cả SELECT: cùng khuôn với mọi bảng chứa vật liệu định danh
-- (`refresh_sessions`, `invitations`, `password_reset_tokens`). Cột mới trên `domain_configs` không cần
-- GRANT gì thêm: quyền của bảng đó cấp ở MỨC BẢNG nên cột mới tự được phủ.
--
-- ĐƯỜNG LÙI (dán chạy được):
--   DROP FUNCTION IF EXISTS udp_prune_webhook_token_uses(integer);
--   DROP TABLE IF EXISTS "webhook_token_uses";
--   ALTER TABLE "domain_configs" DROP COLUMN "oidc_required";
-- Mặc định của cờ là false nên pipeline cũ không đổi hành vi cho tới khi có token hợp lệ đầu tiên.

ALTER TABLE "domain_configs" ADD COLUMN "oidc_required" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "webhook_token_uses" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "issuer" VARCHAR(255) NOT NULL,
    "token_id" VARCHAR(255) NOT NULL,
    "pipeline_id" VARCHAR(255) NOT NULL,
    "environment_id" UUID NOT NULL,
    "body_digest" VARCHAR(64) NOT NULL,
    "deployment_id" UUID,
    "used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webhook_token_uses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_token_uses_once" ON "webhook_token_uses"("issuer", "token_id");
CREATE INDEX "webhook_token_uses_expires_at_idx" ON "webhook_token_uses"("expires_at");
CREATE INDEX "webhook_token_uses_project_id_used_at_idx" ON "webhook_token_uses"("project_id", "used_at" DESC);

ALTER TABLE "webhook_token_uses" ADD CONSTRAINT "webhook_token_uses_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT ON webhook_token_uses TO udp_s1;

-- SECURITY DEFINER chạy bằng quyền owner, nên phòng thủ chiều sâu: search_path cố định (pg_temp đứng
-- CUỐI để không ai chen object tạm lên trước), và mọi tên đều viết đủ schema.
CREATE FUNCTION udp_prune_webhook_token_uses(max_rows integer)
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

  DELETE FROM public.webhook_token_uses
   WHERE id IN (
     SELECT id
       FROM public.webhook_token_uses
      WHERE expires_at < pg_catalog.clock_timestamp() - interval '7 days'
      ORDER BY expires_at
      LIMIT max_rows
   );

  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END
$$;

-- Hàm mới trong schema public mặc định cho PUBLIC quyền EXECUTE (đã đo trên Supabase). Thu hồi TRƯỚC khi cấp.
REVOKE ALL ON FUNCTION udp_prune_webhook_token_uses(integer) FROM PUBLIC;

-- Role của nền tảng: ở instance này quyền của chúng đến qua PUBLIC, nhưng một instance khác có thể cấp
-- tường minh bằng default privileges. PostgreSQL thường không có các role này, nên thu hồi có điều kiện.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION udp_prune_webhook_token_uses(integer) FROM %I', r
      );
    END IF;
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION udp_prune_webhook_token_uses(integer) TO udp_s1;

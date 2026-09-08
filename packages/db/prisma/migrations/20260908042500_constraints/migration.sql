-- ============================================================
-- Ràng buộc mà Prisma không diễn đạt được, nên phải viết tay.
--
-- Ba loại: partial unique index (mệnh đề WHERE), expression index (COALESCE),
-- và trigger. Cả ba đều cưỡng chế ở TẦNG DATABASE, không phụ thuộc việc code
-- có nhớ kiểm tra hay không — mỗi bất biến dưới đây đều là race condition,
-- loại lỗi mà SELECT-rồi-INSERT trong application không chặn được.
-- ============================================================

-- ------------------------------------------------------------
-- A. Partial unique index
-- ------------------------------------------------------------

-- (1) Mỗi project chỉ có ĐÚNG MỘT credential đang hoạt động.
-- Không có nó, hai request PUT /cloud đồng thời tạo hai bản ghi is_active = true
-- và adapter không biết dùng cái nào.
CREATE UNIQUE INDEX "idx_one_active_credential_per_project"
  ON "cloud_credentials" ("project_id")
  WHERE "is_active" = true;

-- (2) Mỗi project chỉ có ĐÚNG MỘT job đang chạy.
-- Chặn bấm Provision hai lần tạo hai cluster trên tài khoản BYOC của developer
-- (ADR-02) — bất biến đắt nhất nếu vỡ.
--
-- COMPENSATION_FAILED PHẢI nằm trong danh sách loại trừ (§2.2 :1364). Job ở
-- state đó đã dừng hẳn và chờ người xử lý; coi nó là "đang chạy" sẽ khóa
-- project vĩnh viễn — không tạo nổi cả job TEARDOWN để dọn tài nguyên mồ côi.
CREATE UNIQUE INDEX "idx_one_active_job_per_project"
  ON "provisioning_jobs" ("project_id")
  WHERE "state" NOT IN ('DONE', 'FAILED', 'COMPENSATION_FAILED');

-- (3) Mỗi target chỉ có ĐÚNG MỘT rollout đang chạy.
-- Target = (environment, workload) với SERVICE_LEVEL,
--        = (environment, flag_env_config) với FLAG_LEVEL.
-- COALESCE vì mỗi loại để NULL ở cột của loại kia, mà trong unique index NULL
-- được coi là khác nhau. Hai reconciler cùng điều khiển một target là đúng thứ
-- ADR-01 sinh ra để tránh.
CREATE UNIQUE INDEX "idx_one_active_rollout_per_target"
  ON "rollout_sessions" (
    "environment_id",
    COALESCE("workload_name", ''),
    COALESCE("flag_env_config_id"::text, '')
  )
  WHERE "status" IN ('PENDING', 'IN_PROGRESS', 'PAUSED');

-- (4) Mỗi project có TỐI ĐA một chủ sở hữu.
-- Nói rõ giới hạn: unique index chỉ chặn được "hai OWNER". Nửa còn lại —
-- "project không có OWNER nào" — là ràng buộc ít-nhất-một, KHÔNG cưỡng chế
-- được bằng index, và phải do tầng application giữ khi xóa/đổi thành viên.
CREATE UNIQUE INDEX "idx_one_owner_per_project"
  ON "project_members" ("project_id")
  WHERE "project_role" = 'OWNER';

-- ------------------------------------------------------------
-- B. Index bổ sung [Plan #5B]
-- ------------------------------------------------------------

-- (5) Idempotency của webhook CI/CD (§2.2 :1447).
-- Điểm quyết định là INSERT ... ON CONFLICT DO NOTHING, không phải SELECT
-- trước rồi INSERT. Không có index này thì ON CONFLICT không có arbiter và
-- webhook retry sẽ nhân đôi Deployment Frequency của DORA.
CREATE UNIQUE INDEX "idx_deploy_pipeline_once"
  ON "deployment_events" ("project_id", "pipeline_id", "event_type")
  WHERE "pipeline_id" IS NOT NULL;

-- (6) Một capability chỉ được bind MỘT lần cho mỗi (domain config, scope).
-- Phải là expression index chứ không phải UNIQUE thường: binding ở phạm vi
-- cluster để environment_id NULL, mà Postgres coi mỗi NULL là khác nhau — hai
-- binding cluster-scoped trùng hệt nhau vẫn lọt qua UNIQUE thường (§2.2 :1048).
CREATE UNIQUE INDEX "idx_binding_unique"
  ON "capability_bindings" (
    "domain_config_id",
    "capability_id",
    COALESCE("environment_id"::text, '')
  );

-- ------------------------------------------------------------
-- C. ORPHAN_RULE — toàn vẹn variantId nằm trong JSONB
-- ------------------------------------------------------------
--
-- Không thể dùng FK: variantId nằm trong cột `serve` (JSONB), và với
-- serve.kind = 'distribution' thì có NHIỀU variantId trong một hàng. §6.7 yêu
-- cầu chặn CẢ HAI chiều. Chiều "default trỏ variant lạ" đã do FK thật trên
-- default_variant_id lo; hai trigger dưới đây lo phần JSONB.
--
-- SQLSTATE 'UDP01' là hợp đồng máy đọc được: tầng application map mã này sang
-- ProblemDetails code ORPHAN_RULE (422). Không khớp bằng nội dung thông báo —
-- thông báo là để người đọc, không phải để code so chuỗi.

CREATE OR REPLACE FUNCTION udp_serve_variant_ids(serve JSONB)
RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE serve->>'kind'
    WHEN 'variant' THEN ARRAY[(serve->>'variantId')::uuid]
    WHEN 'distribution' THEN ARRAY(
      SELECT (w->>'variantId')::uuid
      FROM jsonb_array_elements(serve->'weights') AS w
    )
    ELSE ARRAY[]::uuid[]
  END;
$fn$;

-- Chiều 1: chặn LƯU rule trỏ tới variant không thuộc flag sở hữu rule đó.
-- BEFORE để lỗi hiện ngay tại câu lệnh gây ra, dễ lần ra chỗ sai.
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

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ORPHAN_RULE: serve tro toi variant % khong thuoc flag cua rule nay', bad
      USING ERRCODE = 'UDP01';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_rule_serve_variants
  BEFORE INSERT OR UPDATE ON "flag_targeting_rules"
  FOR EACH ROW
  EXECUTE FUNCTION udp_check_rule_serve_variants();

-- Chiều 2: chặn XÓA variant còn được serve của rule nào tham chiếu.
--
-- PHẢI là CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED, không phải
-- trigger thường. Lý do: xóa một FeatureFlag sẽ cascade xóa CẢ variant lẫn
-- rule, và thứ tự giữa hai nhánh cascade không được đảm bảo. Trigger thường có
-- thể chạy khi variant đã mất còn rule chưa, rồi chặn nhầm một thao tác hợp lệ.
-- Hoãn tới lúc COMMIT thì cả hai nhánh đã xong: xóa cả flag sẽ qua, còn xóa
-- riêng variant mà rule vẫn còn thì bị chặn — đúng như §6.7 muốn.
CREATE OR REPLACE FUNCTION udp_check_variant_not_referenced()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM flag_targeting_rules r
    WHERE OLD.id = ANY (udp_serve_variant_ids(r.serve))
  ) THEN
    RAISE EXCEPTION 'ORPHAN_RULE: variant % con duoc rule tham chieu qua serve', OLD.id
      USING ERRCODE = 'UDP01';
  END IF;

  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER trg_variant_not_referenced
  AFTER DELETE ON "flag_variants"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION udp_check_variant_not_referenced();

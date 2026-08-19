-- ============================================================
-- Partial unique index — Prisma không diễn đạt được mệnh đề WHERE,
-- nên phải viết tay. Bốn index này cưỡng chế bất biến ở TẦNG DATABASE,
-- không phụ thuộc vào việc code có nhớ kiểm tra hay không.
-- ============================================================

-- (1) Mỗi project chỉ có ĐÚNG MỘT credential đang hoạt động.
-- Không có index này, hai request PUT /cloud đồng thời sẽ tạo hai bản ghi
-- is_active = true, và adapter không biết dùng cái nào.
CREATE UNIQUE INDEX "idx_one_active_credential_per_project"
  ON "cloud_credentials" ("project_id")
  WHERE "is_active" = true;

-- (2) Mỗi project chỉ có ĐÚNG MỘT job đang chạy.
-- Chặn kịch bản bấm nút Provision hai lần tạo ra hai cluster
-- trên tài khoản BYOC của developer (ADR-02).
CREATE UNIQUE INDEX "idx_one_active_job_per_project"
  ON "provisioning_jobs" ("project_id")
  WHERE "state" NOT IN ('DONE', 'FAILED');

-- (3) Mỗi target chỉ có ĐÚNG MỘT rollout đang chạy.
-- Target = (environment, workload) với SERVICE_LEVEL,
--        = (environment, flag_env_config) với FLAG_LEVEL.
-- COALESCE vì mỗi loại rollout để NULL ở cột của loại kia; NULL trong
-- unique index được coi là khác nhau nên không chặn được nếu không ép về ''.
CREATE UNIQUE INDEX "idx_one_active_rollout_per_target"
  ON "rollout_sessions" (
    "environment_id",
    COALESCE("workload_name", ''),
    COALESCE("flag_env_config_id"::text, '')
  )
  WHERE "status" IN ('PENDING', 'IN_PROGRESS', 'PAUSED');

-- (4) Mỗi project có ĐÚNG MỘT chủ sở hữu.
-- Chặn cả hai hướng sai: project không có OWNER (mồ côi, không ai xóa được)
-- và project có hai OWNER (tranh chấp quyền).
CREATE UNIQUE INDEX "idx_one_owner_per_project"
  ON "project_members" ("project_id")
  WHERE "project_role" = 'OWNER';
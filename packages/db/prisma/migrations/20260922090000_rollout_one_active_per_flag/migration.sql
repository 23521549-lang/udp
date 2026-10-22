-- [v4.4] Mỗi flag (env-config) có TỐI ĐA một rollout đang sống, bất kể workload.
--
-- Đường lùi: DROP INDEX idx_one_active_rollout_per_flag. Migration này chỉ THÊM
-- một index: không đổi dữ liệu, không đổi quyền.
--
-- `idx_one_active_rollout_per_target` (migration `constraints`) khoá theo
-- (environment, workload, env-config), nên hai session cùng flag khác workload
-- hợp lệ. Với FLAG_LEVEL điều đó sai theo HAI cách, đều không tách được ở tầng
-- ứng dụng:
--   * nhãn `ff` là theo FLAG (§6.6: `ff="<flagKey>=<variant>"`), không theo
--     workload — hai rollout cùng flag đo cùng một cặp series, quyết định của
--     cái này là nhiễu của cái kia;
--   * Service 2 kiểm fencing theo lease của CHÍNH session gọi (`ramp.service.ts`)
--     — hai session cùng giữ một rule sẽ PATCH `serve.weights` xen kẽ về hai mức.
-- Chặn ở tầng database (không chỉ kiểm trong code) vì hai request tạo đồng thời
-- đều qua được phép kiểm đọc-rồi-ghi; unique index là lớp duy nhất không có khe.
--
-- Cùng tập status với index cũ và với `ACTIVE_ROLLOUT_STATUSES`
-- (`packages/config/src/constants.ts`) — vị từ "rollout đang sống" duy nhất.
CREATE UNIQUE INDEX "idx_one_active_rollout_per_flag"
  ON "rollout_sessions" ("flag_env_config_id")
  WHERE "flag_env_config_id" IS NOT NULL
    AND "status" IN ('PENDING', 'IN_PROGRESS', 'PAUSED');

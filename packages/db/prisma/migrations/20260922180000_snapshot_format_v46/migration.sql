-- [v4.6] Định dạng snapshot đổi MỘT lần (§6.5, §6.7, §9): segment có hình chốt,
-- flag DRAFT không còn xuống SDK.
--
-- Đường lùi: DROP CONSTRAINT "segments_conditions_shape"; dữ liệu segment đổi
-- được về mảng bằng UPDATE ... SET conditions = conditions->'all'. `config_hash`
-- không cần lùi — script rehash tính lại từ code đang chạy.
--
-- TRIỂN KHAI: dừng CẢ Service 2 lẫn Service 3 (cùng tính `config_hash` bằng
-- `@udp/flag-snapshot`) → migrate → `pnpm --filter @udp/flag-service rehash` →
-- khởi động cả hai. Ngoại lệ có chủ đích của "replica trước, writer sau" (§16):
-- một writer bản cũ còn sống sẽ ghi hash định dạng cũ, và replica mới đo ra lệch.

-- 1. Segment: mảng điều kiện (hình cũ của §2.2 và seed) ⇒ { all, userIds }.
UPDATE "segments"
   SET "conditions" = jsonb_build_object('all', "conditions", 'userIds', '[]'::jsonb)
 WHERE jsonb_typeof("conditions") = 'array';

-- 2. Hình được giữ ở tầng database: builder snapshot đọc chặt, và một segment
--    sai hình làm hỏng snapshot của CẢ project — mọi lần ghi, `/sdk/config`, và
--    kill-switch của Service 3 (I30). Vi phạm bị chặn lúc ghi, không lúc đọc.
ALTER TABLE "segments"
  ADD CONSTRAINT "segments_conditions_shape" CHECK (
    jsonb_typeof("conditions") = 'object'
    AND jsonb_typeof("conditions"->'all') = 'array'
    AND jsonb_typeof("conditions"->'userIds') = 'array'
    AND "conditions" - 'all' - 'userIds' = '{}'::jsonb
  );

-- 3. Mốc hash cũ tính theo định dạng cũ: xoá về "chưa có mốc" (`verifyHash` bỏ
--    qua `''`, không đếm lệch). Script rehash đặt mốc mới ngay sau migration;
--    nếu nó chưa chạy, mốc xuất hiện ở lần ghi kế tiếp của từng environment.
UPDATE "environments" SET "config_hash" = '';

-- [v4.6] Siết `segments_conditions_shape` (QA code Plan #20): CHECK trước chỉ
-- kiểm HÌNH (object có `all` và `userIds` là mảng) mà không kiểm PHẦN TỬ. Builder
-- snapshot đọc `userIds` như mảng chuỗi — một segment `userIds: [123]` làm hỏng
-- snapshot của CẢ project: mọi lần ghi, `/sdk/config`, và kill-switch của
-- Service 3 (I30). Và với `conditions` vô hướng, `conditions - 'all'` ném 22023
-- thay vì vi phạm CHECK — nên phép kiểm nằm sau một `CASE` theo kiểu.
--
-- Toàn biểu thức bọc `IS TRUE`: CHECK trả NULL được coi là ĐẠT, và
-- `jsonb_typeof(conditions->'userIds')` là NULL khi thiếu khoá — bản trước để lọt
-- đúng ca `{"all": []}` (test `segment-conditions-check` bắt được).
--
-- Đường lùi: trả CHECK về bản của migration `snapshot_format_v46`.
ALTER TABLE "segments" DROP CONSTRAINT "segments_conditions_shape";

ALTER TABLE "segments"
  ADD CONSTRAINT "segments_conditions_shape" CHECK ((
    CASE
      WHEN jsonb_typeof("conditions") = 'object' THEN
        jsonb_typeof("conditions"->'all') = 'array'
        AND jsonb_typeof("conditions"->'userIds') = 'array'
        AND "conditions" - 'all' - 'userIds' = '{}'::jsonb
        AND NOT jsonb_path_exists("conditions", '$.userIds[*] ? (@.type() != "string")')
        AND NOT jsonb_path_exists("conditions", '$.all[*] ? (@.type() != "object")')
      ELSE false
    END
  ) IS TRUE);

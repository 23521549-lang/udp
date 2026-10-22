-- [v4.9] Mốc kích hoạt của flag (§2.2, L2 của Plan #23): `activated_at` = thời
-- điểm lần chuyển sang ACTIVE GẦN NHẤT. Cảnh báo stale UNUSED/SETTLED (§6.7) đo
-- tuổi flag từ mốc này — `updated_at` đổi cả khi sửa mô tả, còn `created_at` sai
-- với flag nằm nháp lâu rồi mới bật.
--
-- Mốc do TRIGGER đặt, không do code: mọi writer (S2 bản cũ trong cửa sổ rolling
-- deploy, seed, fixture, công cụ vận hành) đều có mốc mà không phải "nhớ" ghi
-- cột. CHECK ở cuối là lưới cứng: trigger hỏng thì ghi ACTIVE bị chặn (23514),
-- không bao giờ có flag ACTIVE thiếu mốc.
--
-- Thứ tự: cột → hàm + trigger → backfill → CHECK. Prisma chạy cả file trong MỘT
-- transaction, và `ADD COLUMN` giữ ACCESS EXCLUSIVE trên `feature_flags` tới lúc
-- COMMIT, nên không writer nào chen vào giữa các bước — thứ tự nào cũng đúng.
-- Trigger đặt trước backfill để file vẫn an toàn nếu sau này bị tách thành nhiều
-- transaction. Backfill chỉ chạm hàng đang ACTIVE (OLD = ACTIVE) nên trigger
-- không ghi đè giá trị backfill. CHECK thêm SAU backfill vì trước đó mọi hàng
-- ACTIVE đều còn NULL.
--
-- Đường lùi:
--   ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_active_has_activated_at;
--   DROP TRIGGER trg_flag_activated_at ON feature_flags;
--   DROP FUNCTION udp_set_flag_activated_at();
--   ALTER TABLE feature_flags DROP COLUMN activated_at;
-- Lưu ý khi chạy (tiến hay lùi): migration giữ khoá bảng `feature_flags` suốt
-- lúc backfill, nên snapshot và PATCH của Service 2 phải chờ tới COMMIT. Bảng
-- nhỏ nên thời gian chờ ngắn, nhưng đừng chạy giữa lúc đang có rollout dày.

-- 1. Cột. NULL: flag DRAFT chưa từng kích hoạt thì chưa có mốc.
ALTER TABLE "feature_flags" ADD COLUMN "activated_at" TIMESTAMPTZ(3) NULL;

-- 2. Trigger đặt mốc khi hàng CHUYỂN sang ACTIVE (INSERT thẳng ACTIVE, hoặc
--    UPDATE từ DRAFT/ARCHIVED). ACTIVE → ACTIVE (sửa mô tả, stickiness) giữ mốc.
--
--    SECURITY INVOKER (mặc định, ghi tường minh), KHÔNG DEFINER:
--    - thân hàm không đọc hay ghi bảng nào, chỉ gán `NEW.activated_at`; Postgres
--      kiểm quyền cột theo danh sách cột CÓ TRONG CÂU LỆNH, không theo giá trị
--      trigger BEFORE gán vào NEW — `udp_s2` không cần quyền gì thêm;
--    - DEFINER sẽ lọt vào truy vấn `pg_proc … WHERE prosecdef` của I22 và làm đỏ
--      "mọi hàm definer đều được khai" mà không đem lại gì.
--    Hàm `RETURNS trigger` không gọi trực tiếp được, và EXECUTE chỉ được kiểm lúc
--    CREATE TRIGGER (owner), nên không cần `SET search_path` hay REVOKE — giống
--    hai hàm trigger INVOKER có sẵn.
CREATE OR REPLACE FUNCTION udp_set_flag_activated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
BEGIN
  IF NEW.lifecycle_status = 'ACTIVE'
     AND (TG_OP = 'INSERT' OR OLD.lifecycle_status IS DISTINCT FROM 'ACTIVE') THEN
    NEW.activated_at := now();
  END IF;
  RETURN NEW;
END;
$fn$;

-- Trigger BEFORE chạy theo thứ tự tên: `trg_flag_activated_at` trước
-- `trg_flag_default_variant` (orphan_rule_hardening). Hàm kia chỉ ĐỌC
-- `default_variant_id`/`id`, nên hai trigger độc lập, thứ tự không đổi kết quả.
CREATE TRIGGER trg_flag_activated_at
  BEFORE INSERT OR UPDATE ON "feature_flags"
  FOR EACH ROW
  EXECUTE FUNCTION udp_set_flag_activated_at();

-- 3. Backfill cho flag đang ACTIVE: lần kích hoạt gần nhất theo audit (có từ
--    v4.5); không có audit thì `updated_at`. Mọi lần kích hoạt đều đẩy
--    `updated_at`, nên `updated_at` ≥ mốc thật — mốc chỉ có thể MUỘN hơn sự
--    thật (UNUSED đến trễ), không bao giờ sinh cảnh báo sai. `created_at` thì sớm
--    hơn, và báo UNUSED sai đúng loại flag cần bảo vệ.
--    Truy vấn con lọc theo `(target_type, target_id)` — dùng được index có sẵn
--    của `audit_logs` trên cặp cột đó; bảng nhỏ nên quét một lần lúc migration
--    cũng chấp nhận được.
UPDATE "feature_flags" f
   SET "activated_at" = COALESCE(
     (SELECT max(a."occurred_at")
        FROM "audit_logs" a
       WHERE a."target_type" = 'FeatureFlag'
         AND a."target_id" = f."id"::text
         AND a."action" = 'flag.update'
         AND a."after"->>'lifecycleStatus' = 'ACTIVE'
         AND (a."before"->>'lifecycleStatus') IS DISTINCT FROM 'ACTIVE'),
     f."updated_at")
 WHERE f."lifecycle_status" = 'ACTIVE';

-- 4. Lưới cứng (INV-23.1): flag ACTIVE luôn có mốc. Trigger không cứu được
--    `UPDATE … SET activated_at = NULL` trên hàng đã ACTIVE (OLD = ACTIVE nên
--    trigger không gán) — CHECK chặn ca đó.
ALTER TABLE "feature_flags"
  ADD CONSTRAINT "feature_flags_active_has_activated_at"
  CHECK ("lifecycle_status" <> 'ACTIVE' OR "activated_at" IS NOT NULL);

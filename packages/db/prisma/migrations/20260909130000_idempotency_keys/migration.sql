-- ============================================================
-- Lớp lưu của header `Idempotency-Key` (§9), cộng hai ràng buộc mà tài liệu
-- vẫn hứa nhưng database chưa từng giữ.
--
-- Viết tay chứ không để `migrate dev` sinh: hai trong ba thứ dưới đây là
-- PARTIAL index, mà Prisma không biểu diễn được trong schema. Phần CREATE TABLE
-- thì lấy nguyên văn từ `prisma migrate diff` để không lệch một ký tự nào so
-- với thứ Prisma sẽ tự sinh — nếu lệch, mọi lần kiểm drift sau này sẽ đỏ.
-- ============================================================

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" VARCHAR(120) NOT NULL,
    "idempotency_key" VARCHAR(120) NOT NULL,
    "body_hash" CHAR(64) NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idx_idempotency_scope" ON "idempotency_keys"("project_id", "user_id", "endpoint", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "environments_k8s_namespace_key" ON "environments"("k8s_namespace");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- Tên project là duy nhất TRONG PHẠM VI một chủ sở hữu.
--
-- `ERROR_CATALOG.DUPLICATE_RESOURCE` lấy ví dụ mở đầu là "tên project trùng",
-- nhưng trước dòng này không ràng buộc nào cưỡng chế điều đó: tài liệu hứa một
-- thứ database không giữ, và mã 409 kia không bao giờ có thể phát ra.
--
-- Phạm vi là `(owner_id, name)` chứ không phải toàn hệ thống vì tên project là
-- nhãn riêng của người dùng, không phải định danh toàn cầu — hai người xa lạ
-- cùng đặt tên "backend" là chuyện bình thường.
--
-- `WHERE status <> 'DELETED'` để xoá rồi tạo lại cùng tên vẫn được. Không có
-- mệnh đề này, soft-delete sẽ âm thầm chiếm giữ tên vĩnh viễn — người dùng xoá
-- nhầm project rồi không tạo lại được với đúng tên cũ, và thông báo lỗi thì nói
-- về một hàng họ không còn nhìn thấy ở đâu cả.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX "idx_project_name_per_owner"
  ON "projects" ("owner_id", "name")
  WHERE "status" <> 'DELETED';

-- ------------------------------------------------------------
-- `idempotency_keys` thuộc lãnh địa Service 1 (§1.2): mọi endpoint trong bảng
-- Idempotency-Key của §9 đều là endpoint của S1.
--
-- KHÔNG cấp UPDATE, có chủ đích. Một hàng ở đây là bản ghi "lần đầu đã trả về
-- đúng cái này". Cho phép sửa nó nghĩa là một request sau có thể đổi thứ mà
-- request phát lại nhận được — tức là phá đúng tính chất bảng này sinh ra để
-- bảo đảm. Cùng lập luận với `audit_logs`: ghi một lần, không viết lại.
--
-- DELETE thì cần, vì việc dọn hàng quá hạn làm ngay trên đường ghi (§2.2) chứ
-- không chờ một cron chưa có chỗ chạy.
-- ------------------------------------------------------------
GRANT SELECT, INSERT, DELETE ON idempotency_keys TO udp_s1;

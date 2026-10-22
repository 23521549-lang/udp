-- [v4.12] Plan #60 QĐ-6, QĐ-7, QĐ-8 — đồng ý Điều khoản, đặt lại mật khẩu qua email, đăng nhập bằng GitHub.
--
-- 1. `users.terms_version`, `users.terms_accepted_at`: người đăng ký tích ô đồng ý (Nghị định 13/2023/NĐ-CP: im lặng
--    không phải đồng ý), Service 1 ghi phiên bản Điều khoản hiện hành và lúc đồng ý. CHECK: hai cột cùng NULL (tài
--    khoản có trước Điều khoản) hoặc cùng có.
-- 2. `users.password_hash` NULL được: tài khoản tạo bằng GitHub chưa có mật khẩu. Đăng nhập bằng mật khẩu với hash NULL
--    là "sai thông tin" (Service 1 chạy phép so giả để thời gian như email không tồn tại).
-- 3. `password_reset_tokens`: chỉ lưu SHA-256 của token, dùng một lần, có hạn.
-- 4. `user_identities`: liên kết với danh tính GitHub theo id bất biến của GitHub.
-- 5. Quyền: hai bảng mới thuộc lãnh địa Service 1 (vòng đời tài khoản, như refresh_sessions); S2 và S3 không có quyền
--    nào — `password_reset_tokens` chứa hash token. I22 khai hai hàng mới.
--
-- Phần CREATE lấy nguyên văn từ `prisma migrate diff`.
--
-- Đường lùi:
--   DROP TABLE "user_identities";
--   DROP TABLE "password_reset_tokens";
--   DROP TYPE "IdentityProvider";
--   ALTER TABLE "users" DROP CONSTRAINT "users_terms_pair";
--   ALTER TABLE "users" DROP COLUMN "terms_version", DROP COLUMN "terms_accepted_at";
--   ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL;  -- chỉ được khi không còn tài khoản GitHub-only

-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('GITHUB');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "terms_accepted_at" TIMESTAMPTZ(3),
ADD COLUMN     "terms_version" VARCHAR(20),
ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "provider_user_id" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_provider_provider_user_id_key" ON "user_identities"("provider", "provider_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_user_id_provider_key" ON "user_identities"("user_id", "provider");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hai cột đồng ý đi cùng nhau
ALTER TABLE "users" ADD CONSTRAINT "users_terms_pair"
  CHECK (("terms_version" IS NULL) = ("terms_accepted_at" IS NULL));

-- ------------------------------------------------------------
-- Lãnh địa Service 1 (§1.2)
-- ------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens, user_identities TO udp_s1;

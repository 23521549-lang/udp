-- [v4.11] Plan #55 — nhóm dùng chung cho nhiều project, và lời mời bằng đường dẫn (§2.2).
--
-- 1. `teams`, `team_members`: nhóm và thành viên (vai nhóm OWNER/MEMBER). "Luôn còn ít nhất một OWNER" do Service 1
--    giữ trong transaction có khoá — như chủ project, một unique index chỉ nói được "nhiều nhất".
-- 2. `project_team_grants`: project cấp cho nhóm một vai. CHECK cấm OWNER: chủ sở hữu luôn là MỘT người, đổi qua
--    chuyển quyền sở hữu. Vai hiệu lực = vai cao nhất giữa `project_members` và grant của các nhóm người đó thuộc.
-- 3. `invitations`: lời mời vào ĐÚNG MỘT đích (project hoặc nhóm), vai đúng kiểu của đích, chỉ lưu SHA-256 của token,
--    email chữ thường; mỗi (đích, email) chỉ một lời mời ĐANG CHỜ — unique TỪNG PHẦN, thứ Prisma không biểu diễn
--    được nên viết tay ở cuối tệp. Hết hạn không nằm trong điều kiện của index (`now()` không immutable): mời lại
--    là thu hồi lời cũ rồi tạo lời mới trong một transaction (Service 1).
-- 4. Quyền: `udp_s1` đủ bốn quyền trên bốn bảng; S2 và S3 KHÔNG có quyền nào (không nhiệm vụ nào của hai service đó
--    đọc thành viên, và `invitations` chứa hash token) — I22 khai bốn hàng.
--
-- Phần CREATE lấy nguyên văn từ `prisma migrate diff` để không lệch một ký tự với thứ Prisma tự sinh.
--
-- Đường lùi:
--   DROP TABLE "invitations";
--   DROP TABLE "project_team_grants";
--   DROP TABLE "team_members";
--   DROP TABLE "teams";
--   DROP TYPE "TeamRole";

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "team_role" "TeamRole" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_team_grants" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project_role" "ProjectRole" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_team_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "project_id" UUID,
    "team_id" UUID,
    "email" VARCHAR(255) NOT NULL,
    "project_role" "ProjectRole",
    "team_role" "TeamRole",
    "token_hash" CHAR(64) NOT NULL,
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_team_id_user_id_key" ON "team_members"("team_id", "user_id");

-- CreateIndex
CREATE INDEX "project_team_grants_team_id_idx" ON "project_team_grants"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_team_grants_project_id_team_id_key" ON "project_team_grants"("project_id", "team_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_project_id_idx" ON "invitations"("project_id");

-- CreateIndex
CREATE INDEX "invitations_team_id_idx" ON "invitations"("team_id");

-- CreateIndex
CREATE INDEX "invitations_invited_by_idx" ON "invitations"("invited_by");

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_team_grants" ADD CONSTRAINT "project_team_grants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_team_grants" ADD CONSTRAINT "project_team_grants_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ------------------------------------------------------------
-- Ràng buộc mà Prisma không biểu diễn được
-- ------------------------------------------------------------

-- Tên nhóm không rỗng (độ dài tối đa đã ở kiểu VARCHAR(80))
ALTER TABLE "teams" ADD CONSTRAINT "teams_name_not_blank"
  CHECK (length(btrim("name")) > 0);

-- Grant của nhóm không bao giờ là OWNER
ALTER TABLE "project_team_grants" ADD CONSTRAINT "project_team_grants_not_owner"
  CHECK ("project_role" <> 'OWNER');

-- Đúng một đích, và vai đúng kiểu của đích đó; lời mời vào project không mang vai OWNER
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_one_target"
  CHECK (
    ("project_id" IS NOT NULL AND "project_role" IS NOT NULL AND "project_role" <> 'OWNER'
      AND "team_id" IS NULL AND "team_role" IS NULL)
    OR
    ("team_id" IS NOT NULL AND "team_role" IS NOT NULL
      AND "project_id" IS NULL AND "project_role" IS NULL)
  );

-- Email so khớp với `users.email` (đã chữ thường ở cửa vào) bằng phép bằng
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_email_lowercase"
  CHECK ("email" = lower("email"));

-- Một lời mời đang chờ cho mỗi (đích, email): hai OWNER bấm "Mời" cùng lúc thì một người nhận 409
CREATE UNIQUE INDEX "invitations_one_pending_per_project"
  ON "invitations" ("project_id", "email")
  WHERE "project_id" IS NOT NULL AND "accepted_at" IS NULL AND "revoked_at" IS NULL;

CREATE UNIQUE INDEX "invitations_one_pending_per_team"
  ON "invitations" ("team_id", "email")
  WHERE "team_id" IS NOT NULL AND "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- ------------------------------------------------------------
-- Lãnh địa Service 1 (§1.2)
-- ------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON teams, team_members, project_team_grants, invitations TO udp_s1;

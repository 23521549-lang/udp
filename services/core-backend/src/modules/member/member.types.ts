import { z } from "zod";
import type { ProjectRole } from "@udp/db";

/**
 * `OWNER` cố tình KHÔNG nằm trong tập chọn được.
 *
 * Chủ sở hữu chỉ đổi qua `POST /transfer-ownership`, nơi việc hạ người cũ và
 * nâng người mới diễn ra trong một transaction có khoá. Nếu cho phép đặt
 * `projectRole: "OWNER"` ở đây thì mọi lời gọi thêm/sửa thành viên đều là một
 * đường vòng tới cùng bất biến ấy, và `idx_one_owner_per_project` sẽ chặn bằng
 * một lỗi 409 khó hiểu thay vì API nói thẳng rằng phải dùng endpoint khác.
 */
const ASSIGNABLE_ROLES = ["MAINTAINER", "DEVELOPER", "VIEWER"] as const;

export const addMemberSchema = z.object({
  email: z.string().email("Email không hợp lệ").trim().toLowerCase(),
  projectRole: z.enum(ASSIGNABLE_ROLES),
});

export const updateMemberSchema = z.object({
  projectRole: z.enum(ASSIGNABLE_ROLES),
});

export const transferOwnershipSchema = z.object({
  userId: z.string().uuid("userId phải là UUID"),
});

export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;

export interface PublicMember {
  userId: string;
  projectRole: ProjectRole;
  createdAt: Date;
  user: { id: string; email: string; name: string };
}

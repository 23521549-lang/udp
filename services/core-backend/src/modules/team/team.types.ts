import { z } from "zod";
import { ASSIGNABLE_ROLES } from "../member/member.types.js";

/**
 * [v4.11, Plan #55] Đầu vào của nhóm và quyền của nhóm trên project.
 *
 * Vai cấp cho nhóm dùng CÙNG tập với thành viên project (`ASSIGNABLE_ROLES`, không `OWNER`): chủ sở hữu luôn là
 * một người cụ thể, và database giữ thêm bằng CHECK `project_team_grants_not_owner`.
 */

const TEAM_ROLES = ["OWNER", "MEMBER"] as const;

const teamName = z
  .string()
  .trim()
  .min(1, "Tên nhóm không được để trống")
  .max(80, "Tên nhóm tối đa 80 ký tự");

export const createTeamSchema = z.object({ name: teamName });
export const renameTeamSchema = z.object({ name: teamName });

export const addTeamMemberSchema = z.object({
  email: z.string().email("Email không hợp lệ").trim().toLowerCase(),
  teamRole: z.enum(TEAM_ROLES),
});

export const updateTeamMemberSchema = z.object({
  teamRole: z.enum(TEAM_ROLES),
});

export const grantTeamSchema = z.object({
  teamId: z.string().uuid("teamId phải là UUID"),
  projectRole: z.enum(ASSIGNABLE_ROLES),
});

export const updateGrantSchema = z.object({
  projectRole: z.enum(ASSIGNABLE_ROLES),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type RenameTeamInput = z.infer<typeof renameTeamSchema>;
export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;
export type UpdateTeamMemberInput = z.infer<typeof updateTeamMemberSchema>;
export type GrantTeamInput = z.infer<typeof grantTeamSchema>;
export type UpdateGrantInput = z.infer<typeof updateGrantSchema>;

import { z } from "zod";
import { INVITATION_TOKEN_PATTERN } from "@udp/shared-types/wire";
import { ASSIGNABLE_ROLES } from "../member/member.types.js";

/**
 * [v4.11, Plan #55 QĐ-1] Đầu vào của lời mời. Email chữ thường ở cửa vào — cùng luật với đăng ký, nên nhận lời mời
 * so khớp bằng phép bằng (và database giữ thêm bằng CHECK `invitations_email_lowercase`).
 */

const email = z.string().email("Email không hợp lệ").trim().toLowerCase();

export const createProjectInvitationSchema = z.object({
  email,
  projectRole: z.enum(ASSIGNABLE_ROLES),
});

export const createTeamInvitationSchema = z.object({
  email,
  teamRole: z.enum(["OWNER", "MEMBER"]),
});

/**
 * Token đi trong THÂN request, không bao giờ trong URL của API: đường dẫn nằm trong log truy cập, log proxy và
 * header Referer; thân request thì không.
 */
export const invitationTokenSchema = z.object({
  token: z
    .string()
    .regex(INVITATION_TOKEN_PATTERN, "Đường dẫn mời không hợp lệ"),
});

export type CreateProjectInvitationInput = z.infer<
  typeof createProjectInvitationSchema
>;
export type CreateTeamInvitationInput = z.infer<
  typeof createTeamInvitationSchema
>;
export type InvitationTokenInput = z.infer<typeof invitationTokenSchema>;

import type { PublicMemberWire } from "@udp/shared-types/wire";
import type { PublicMember } from "./member.types.js";

/**
 * [v4.11] Thành viên trên dây: `createdAt` là chuỗi ISO. Cùng lý do với
 * `project.view.ts` — `PublicMember` là phép chiếu database và giữ `Date`.
 */
export const memberWire = (member: PublicMember): PublicMemberWire => ({
  userId: member.userId,
  projectRole: member.projectRole,
  createdAt: member.createdAt.toISOString(),
  user: {
    id: member.user.id,
    email: member.user.email,
    name: member.user.name,
  },
});

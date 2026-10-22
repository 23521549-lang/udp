import type {
  ProjectInvitationWire,
  TeamInvitationWire,
} from "@udp/shared-types/wire";
import type { InvitationRow } from "./invitation.service.js";

/**
 * [v4.11, Plan #55] Lời mời đang chờ trên dây — KHÔNG BAO GIỜ mang token hay hash của nó. Vai đúng kiểu của đích do
 * CHECK `invitations_one_target` giữ; hai hàm dưới thu hẹp kiểu và ném nếu CHECK đó từng bị gỡ, thay vì để schema
 * `.strict()` đỏ ở nơi xa nguyên nhân.
 */

const base = (row: InvitationRow) => ({
  id: row.id,
  email: row.email,
  invitedBy: {
    id: row.invitedBy.id,
    email: row.invitedBy.email,
    name: row.invitedBy.name,
  },
  expiresAt: row.expiresAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

export function projectInvitationWire(
  row: InvitationRow,
): ProjectInvitationWire {
  if (row.projectRole === null || row.projectRole === "OWNER") {
    throw new Error(`lời mời ${row.id} không có vai project hợp lệ`);
  }
  return { ...base(row), projectRole: row.projectRole };
}

export function teamInvitationWire(row: InvitationRow): TeamInvitationWire {
  if (row.teamRole === null) {
    throw new Error(`lời mời ${row.id} không có vai nhóm`);
  }
  return { ...base(row), teamRole: row.teamRole };
}

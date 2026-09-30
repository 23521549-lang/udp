import type { TeamRole } from "@udp/db";
import type {
  ProjectTeamWire,
  TeamDetailWire,
  TeamMemberWire,
  TeamSummaryWire,
} from "@udp/shared-types/wire";
import type { ProjectTeamRow } from "./project-team.service.js";
import type { listMine, TeamDetail, TeamMemberRow } from "./team.service.js";

/**
 * [v4.11, Plan #55] Nhóm trên dây: mốc thời gian là chuỗi ISO, vai của người gọi đặt tường minh. Hình của từng hàng
 * là phép chiếu database (giữ `Date`), cùng lý do với `member.view.ts`.
 */

type TeamListRow = Awaited<ReturnType<typeof listMine>>[number];

export const teamSummaryWire = (row: TeamListRow): TeamSummaryWire => {
  const mine = row.members[0];
  // `listMine` lọc `members.some` theo chính người gọi — thiếu hàng là mâu thuẫn dữ liệu, không hạ vai im lặng
  if (mine === undefined) {
    throw new Error(`nhóm ${row.id} không có hàng thành viên của người gọi`);
  }
  return {
    id: row.id,
    name: row.name,
    myRole: mine.teamRole,
    memberCount: row._count.members,
    projectCount: row._count.grants,
    createdAt: row.createdAt.toISOString(),
  };
};

export const teamMemberWire = (member: TeamMemberRow): TeamMemberWire => ({
  userId: member.userId,
  teamRole: member.teamRole,
  createdAt: member.createdAt.toISOString(),
  user: {
    id: member.user.id,
    email: member.user.email,
    name: member.user.name,
  },
});

export const teamDetailWire = (
  team: TeamDetail,
  myRole: TeamRole,
): TeamDetailWire => ({
  id: team.id,
  name: team.name,
  myRole,
  createdAt: team.createdAt.toISOString(),
  members: team.members.map(teamMemberWire),
  projects: team.grants.map((g) => ({
    id: g.project.id,
    name: g.project.name,
    projectRole: grantable(g.projectRole),
  })),
});

export const projectTeamWire = (row: ProjectTeamRow): ProjectTeamWire => ({
  teamId: row.team.id,
  name: row.team.name,
  projectRole: grantable(row.projectRole),
  createdAt: row.createdAt.toISOString(),
  members: row.team.members.map(({ user }) => ({
    id: user.id,
    email: user.email,
    name: user.name,
  })),
});

/**
 * Grant của nhóm không bao giờ là OWNER — database giữ bằng CHECK `project_team_grants_not_owner`. Hàm này thu
 * hẹp kiểu cho dây và ném nếu CHECK đó từng bị gỡ, thay vì để schema `.strict()` đỏ ở nơi xa nguyên nhân.
 */
function grantable(
  role: ProjectTeamRow["projectRole"],
): ProjectTeamWire["projectRole"] {
  if (role === "OWNER") {
    throw new Error("project_team_grants có vai OWNER — CHECK đã bị gỡ?");
  }
  return role;
}

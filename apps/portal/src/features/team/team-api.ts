import {
  projectTeamListResponseWire,
  projectTeamResponseWire,
  teamListResponseWire,
  teamMemberResponseWire,
  teamResponseWire,
  type GrantableProjectRoleWire,
  type TeamRoleWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

/**
 * [Plan #55] Nhóm của người đăng nhập, và quyền của nhóm trên một project. Lời mời (vào project hay nhóm) ở
 * `features/invitation/invitation-api.ts`.
 */

const t = (teamId: string) => `/teams/${teamId}`;
const pt = (projectId: string) => `/projects/${projectId}/teams`;

export const teamApi = {
  list: () => api(teamListResponseWire, "/teams"),
  create: (name: string) =>
    api(teamResponseWire, "/teams", { method: "POST", body: { name } }),
  get: (teamId: string) => api(teamResponseWire, t(teamId)),
  rename: (teamId: string, name: string) =>
    api(teamResponseWire, t(teamId), { method: "PATCH", body: { name } }),
  remove: (teamId: string) => api(null, t(teamId), { method: "DELETE" }),
  addMember: (
    teamId: string,
    body: { email: string; teamRole: TeamRoleWire },
  ) =>
    api(teamMemberResponseWire, `${t(teamId)}/members`, {
      method: "POST",
      body,
    }),
  updateMember: (teamId: string, userId: string, teamRole: TeamRoleWire) =>
    api(teamMemberResponseWire, `${t(teamId)}/members/${userId}`, {
      method: "PATCH",
      body: { teamRole },
    }),
  /** Chủ nhóm gỡ bất kỳ ai; thành viên gỡ chính mình là rời nhóm */
  removeMember: (teamId: string, userId: string) =>
    api(null, `${t(teamId)}/members/${userId}`, { method: "DELETE" }),
};

export const projectTeamApi = {
  list: (projectId: string) => api(projectTeamListResponseWire, pt(projectId)),
  grant: (
    projectId: string,
    body: { teamId: string; projectRole: GrantableProjectRoleWire },
  ) => api(projectTeamResponseWire, pt(projectId), { method: "POST", body }),
  update: (
    projectId: string,
    teamId: string,
    projectRole: GrantableProjectRoleWire,
  ) =>
    api(projectTeamResponseWire, `${pt(projectId)}/${teamId}`, {
      method: "PATCH",
      body: { projectRole },
    }),
  revoke: (projectId: string, teamId: string) =>
    api(null, `${pt(projectId)}/${teamId}`, { method: "DELETE" }),
};

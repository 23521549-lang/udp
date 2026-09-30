import type {
  GrantableProjectRoleWire,
  InvitationTargetWire,
  ProjectInvitationWire,
  TeamDetailWire,
  TeamInvitationWire,
  TeamMemberWire,
  TeamRoleWire,
} from "@udp/shared-types/wire";
import { iso, nowIso } from "../clock";
import { refreshMyAccess } from "../access";
import type { Db, ProjectRecord, TeamGrant, TeamRecord } from "../db";
import {
  bodyOf,
  found,
  HttpProblem,
  noContent,
  ok,
  projectOf,
  type Router,
} from "../router";
import { audit } from "./project";

/**
 * [Plan #55] Nhóm, quyền của nhóm trên project, lời mời bằng đường dẫn — cùng luật với Service 1: người ngoài nhóm
 * nhận 404, nhóm luôn còn một chủ, grant không bao giờ là OWNER, token chỉ hiện một lần, mọi lời mời không dùng
 * được cùng MỘT 404, và nhận lời mời phải đúng email của người đang đăng nhập.
 */

const TTL_MS = 7 * 24 * 3600 * 1000;
const GONE = "Lời mời không còn hiệu lực";
const NO_ACCOUNT = "Chưa có tài khoản nào dùng email này";

const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** `udp_inv_` + 43 ký tự base64url — cùng hình với token thật */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(43));
  return `udp_inv_${Array.from(bytes, (b) => BASE64URL[b % 64] ?? "A").join("")}`;
}

const person = (db: Db) => ({
  id: db.me.id,
  email: db.me.email,
  name: db.me.name,
});

function myTeam(db: Db, teamId: string): TeamRecord {
  const team = db.teams.find(
    (t) => t.id === teamId && t.members.some((m) => m.userId === db.me.id),
  );
  // Người ngoài nhóm và nhóm không tồn tại: CÙNG 404
  return found(team, "nhóm");
}

function roleIn(db: Db, team: TeamRecord): TeamRoleWire {
  const mine = team.members.find((m) => m.userId === db.me.id);
  return found(mine, "nhóm").teamRole;
}

function requireTeamOwner(db: Db, team: TeamRecord): void {
  if (roleIn(db, team) !== "OWNER") {
    throw new HttpProblem(403, "FORBIDDEN", "Chỉ chủ nhóm làm được việc này");
  }
}

function requireProjectOwner(p: ProjectRecord): void {
  if (p.project.myRole !== "OWNER") {
    throw new HttpProblem(403, "FORBIDDEN", "Không đủ quyền trong project này");
  }
}

function assertNotLastOwner(team: TeamRecord, member: TeamMemberWire): void {
  const owners = team.members.filter((m) => m.teamRole === "OWNER").length;
  if (member.teamRole === "OWNER" && owners <= 1) {
    throw new HttpProblem(
      409,
      "CONFLICT",
      "Nhóm phải còn ít nhất một chủ nhóm: giao vai chủ nhóm cho người khác trước",
    );
  }
}

const liveProjects = (db: Db): ProjectRecord[] =>
  db.projects.filter((p) => p.project.status !== "DELETED");

function detailOf(db: Db, team: TeamRecord): TeamDetailWire {
  return {
    id: team.id,
    name: team.name,
    myRole: roleIn(db, team),
    createdAt: team.createdAt,
    members: team.members,
    projects: liveProjects(db).flatMap((p) =>
      p.teamGrants
        .filter((g) => g.teamId === team.id)
        .map((g) => ({
          id: p.project.id,
          name: p.project.name,
          projectRole: g.projectRole,
        })),
    ),
  };
}

function projectTeamOf(db: Db, grant: TeamGrant) {
  const team = found(
    db.teams.find((t) => t.id === grant.teamId),
    "nhóm",
  );
  return {
    teamId: team.id,
    name: team.name,
    projectRole: grant.projectRole,
    createdAt: grant.createdAt,
    members: team.members.map((m) => m.user),
  };
}

function userByEmail(db: Db, email: string) {
  const user = db.users.find((u) => u.email === email.toLowerCase());
  if (user === undefined) throw new HttpProblem(404, "NOT_FOUND", NO_ACCOUNT);
  return user;
}

/** Thu hồi token của một lời mời (mời lại, thu hồi, đã nhận) — đường dẫn cũ hết dùng được */
function forgetToken(db: Db, invitationId: string): void {
  db.invitationTokens = db.invitationTokens.filter(
    (t) => t.invitationId !== invitationId,
  );
}

export function registerTeamRoutes(router: Router, db: Db): void {
  router
    // ---------------------------------------------------------- nhóm
    .on("GET", "/teams", () =>
      ok({
        teams: db.teams
          .filter((t) => t.members.some((m) => m.userId === db.me.id))
          .sort((a, b) => a.name.localeCompare(b.name, "vi"))
          .map((t) => ({
            id: t.id,
            name: t.name,
            myRole: roleIn(db, t),
            memberCount: t.members.length,
            projectCount: liveProjects(db).filter((p) =>
              p.teamGrants.some((g) => g.teamId === t.id),
            ).length,
            createdAt: t.createdAt,
          })),
      }),
    )
    .on("POST", "/teams", (req) => {
      const { name } = bodyOf<{ name: string }>(req);
      const at = nowIso();
      const team: TeamRecord = {
        id: crypto.randomUUID(),
        name: name.trim(),
        createdAt: at,
        members: [
          {
            userId: db.me.id,
            teamRole: "OWNER",
            createdAt: at,
            user: person(db),
          },
        ],
        invitations: [],
      };
      db.teams.push(team);
      return ok({ team: detailOf(db, team) }, 201);
    })
    .on("GET", "/teams/:id", (_req, [id = ""]) =>
      ok({ team: detailOf(db, myTeam(db, id)) }),
    )
    .on("PATCH", "/teams/:id", (req, [id = ""]) => {
      const team = myTeam(db, id);
      requireTeamOwner(db, team);
      team.name = bodyOf<{ name: string }>(req).name.trim();
      return ok({ team: detailOf(db, team) });
    })
    .on("DELETE", "/teams/:id", (_req, [id = ""]) => {
      const team = myTeam(db, id);
      requireTeamOwner(db, team);
      db.teams = db.teams.filter((t) => t.id !== id);
      for (const p of db.projects) {
        p.teamGrants = p.teamGrants.filter((g) => g.teamId !== id);
      }
      for (const inv of team.invitations) forgetToken(db, inv.id);
      refreshMyAccess(db);
      return noContent;
    })
    .on("POST", "/teams/:id/members", (req, [id = ""]) => {
      const team = myTeam(db, id);
      requireTeamOwner(db, team);
      const body = bodyOf<{ email: string; teamRole: TeamRoleWire }>(req);
      const user = userByEmail(db, body.email);
      if (team.members.some((m) => m.userId === user.id)) {
        throw new HttpProblem(
          409,
          "DUPLICATE_RESOURCE",
          `${user.name} đã ở trong nhóm`,
        );
      }
      const member: TeamMemberWire = {
        userId: user.id,
        teamRole: body.teamRole,
        createdAt: nowIso(),
        user: { id: user.id, email: user.email, name: user.name },
      };
      team.members.push(member);
      return ok({ member }, 201);
    })
    .on("PATCH", "/teams/:id/members/:id", (req, [id = "", userId = ""]) => {
      const team = myTeam(db, id);
      requireTeamOwner(db, team);
      const member = found(
        team.members.find((m) => m.userId === userId),
        "thành viên nhóm",
      );
      const { teamRole } = bodyOf<{ teamRole: TeamRoleWire }>(req);
      if (teamRole !== "OWNER") assertNotLastOwner(team, member);
      member.teamRole = teamRole;
      return ok({ member });
    })
    .on("DELETE", "/teams/:id/members/:id", (_req, [id = "", userId = ""]) => {
      const team = myTeam(db, id);
      if (userId !== db.me.id) requireTeamOwner(db, team);
      const member = found(
        team.members.find((m) => m.userId === userId),
        "thành viên nhóm",
      );
      assertNotLastOwner(team, member);
      team.members = team.members.filter((m) => m.userId !== userId);
      refreshMyAccess(db);
      return noContent;
    })

    // ---------------------------------------------------------- lời mời vào nhóm
    .on("GET", "/teams/:id/invitations", (_req, [id = ""]) => {
      const team = myTeam(db, id);
      requireTeamOwner(db, team);
      return ok({ invitations: team.invitations });
    })
    .on("POST", "/teams/:id/invitations", (req, [id = ""]) => {
      const team = myTeam(db, id);
      requireTeamOwner(db, team);
      const body = bodyOf<{ email: string; teamRole: TeamRoleWire }>(req);
      const email = body.email.toLowerCase();
      if (team.members.some((m) => m.user.email === email)) {
        throw new HttpProblem(409, "CONFLICT", "Người này đã ở trong nhóm");
      }
      for (const old of team.invitations.filter((i) => i.email === email)) {
        forgetToken(db, old.id);
      }
      const invitation: TeamInvitationWire = {
        id: crypto.randomUUID(),
        email,
        invitedBy: person(db),
        expiresAt: iso(Date.now() + TTL_MS),
        createdAt: nowIso(),
        teamRole: body.teamRole,
      };
      team.invitations = [
        invitation,
        ...team.invitations.filter((i) => i.email !== email),
      ];
      const token = newToken();
      db.invitationTokens.push({
        token,
        invitationId: invitation.id,
        kind: "TEAM",
        targetId: team.id,
      });
      return ok({ invitation, token }, 201);
    })
    .on(
      "DELETE",
      "/teams/:id/invitations/:id",
      (_req, [id = "", invitationId = ""]) => {
        const team = myTeam(db, id);
        requireTeamOwner(db, team);
        found(
          team.invitations.find((i) => i.id === invitationId),
          "lời mời đang chờ",
        );
        team.invitations = team.invitations.filter(
          (i) => i.id !== invitationId,
        );
        forgetToken(db, invitationId);
        return noContent;
      },
    )

    // ---------------------------------------------------------- lời mời vào project
    .on("GET", "/projects/:id/invitations", (_req, [id = ""]) => {
      const p = projectOf(db, id);
      requireProjectOwner(p);
      return ok({ invitations: p.invitations });
    })
    .on("POST", "/projects/:id/invitations", (req, [id = ""]) => {
      const p = projectOf(db, id);
      requireProjectOwner(p);
      const body = bodyOf<{
        email: string;
        projectRole: GrantableProjectRoleWire;
      }>(req);
      const email = body.email.toLowerCase();
      if (p.members.some((m) => m.user.email === email)) {
        throw new HttpProblem(
          409,
          "CONFLICT",
          "Người này đã là thành viên của project",
        );
      }
      for (const old of p.invitations.filter((i) => i.email === email)) {
        forgetToken(db, old.id);
      }
      const invitation: ProjectInvitationWire = {
        id: crypto.randomUUID(),
        email,
        invitedBy: person(db),
        expiresAt: iso(Date.now() + TTL_MS),
        createdAt: nowIso(),
        projectRole: body.projectRole,
      };
      p.invitations = [
        invitation,
        ...p.invitations.filter((i) => i.email !== email),
      ];
      const token = newToken();
      db.invitationTokens.push({
        token,
        invitationId: invitation.id,
        kind: "PROJECT",
        targetId: p.project.id,
      });
      audit(db, p, "invitation.create", "Invitation", invitation.id, null, {
        email,
        projectRole: body.projectRole,
      });
      return ok({ invitation, token }, 201);
    })
    .on(
      "DELETE",
      "/projects/:id/invitations/:id",
      (_req, [id = "", invitationId = ""]) => {
        const p = projectOf(db, id);
        requireProjectOwner(p);
        found(
          p.invitations.find((i) => i.id === invitationId),
          "lời mời đang chờ",
        );
        p.invitations = p.invitations.filter((i) => i.id !== invitationId);
        forgetToken(db, invitationId);
        audit(
          db,
          p,
          "invitation.revoke",
          "Invitation",
          invitationId,
          null,
          null,
        );
        return noContent;
      },
    )

    // ---------------------------------------------------------- quyền của nhóm trên project
    .on("GET", "/projects/:id/teams", (_req, [id = ""]) => {
      const p = projectOf(db, id);
      return ok({ teams: p.teamGrants.map((g) => projectTeamOf(db, g)) });
    })
    .on("POST", "/projects/:id/teams", (req, [id = ""]) => {
      const p = projectOf(db, id);
      requireProjectOwner(p);
      const body = bodyOf<{
        teamId: string;
        projectRole: GrantableProjectRoleWire;
      }>(req);
      // Người cấp phải thuộc nhóm: nhóm của người khác là 404
      const team = myTeam(db, body.teamId);
      if (p.teamGrants.some((g) => g.teamId === team.id)) {
        throw new HttpProblem(
          409,
          "DUPLICATE_RESOURCE",
          "Nhóm đã có quyền trên project",
        );
      }
      const grant: TeamGrant = {
        teamId: team.id,
        projectRole: body.projectRole,
        createdAt: nowIso(),
      };
      p.teamGrants.push(grant);
      audit(db, p, "team.grant", "Team", team.id, null, {
        projectRole: body.projectRole,
      });
      refreshMyAccess(db);
      return ok({ team: projectTeamOf(db, grant) }, 201);
    })
    .on("PATCH", "/projects/:id/teams/:id", (req, [id = "", teamId = ""]) => {
      const p = projectOf(db, id);
      requireProjectOwner(p);
      const grant = found(
        p.teamGrants.find((g) => g.teamId === teamId),
        "quyền của nhóm",
      );
      const { projectRole } = bodyOf<{ projectRole: GrantableProjectRoleWire }>(
        req,
      );
      audit(
        db,
        p,
        "team.grant.update",
        "Team",
        teamId,
        { projectRole: grant.projectRole },
        { projectRole },
      );
      grant.projectRole = projectRole;
      refreshMyAccess(db);
      return ok({ team: projectTeamOf(db, grant) });
    })
    .on("DELETE", "/projects/:id/teams/:id", (_req, [id = "", teamId = ""]) => {
      const p = projectOf(db, id);
      requireProjectOwner(p);
      const grant = found(
        p.teamGrants.find((g) => g.teamId === teamId),
        "quyền của nhóm",
      );
      p.teamGrants = p.teamGrants.filter((g) => g !== grant);
      audit(
        db,
        p,
        "team.revoke",
        "Team",
        teamId,
        { projectRole: grant.projectRole },
        null,
      );
      refreshMyAccess(db);
      return noContent;
    })

    // ---------------------------------------------------------- người cầm đường dẫn
    .on("POST", "/invitations/lookup", (req) => {
      const { target, invitation } = usable(
        db,
        bodyOf<{ token: string }>(req).token,
      );
      return ok({
        invitation: {
          target,
          email: invitation.email,
          invitedBy: { name: invitation.invitedBy.name },
          expiresAt: invitation.expiresAt,
        },
      });
    })
    .on("POST", "/invitations/accept", (req) => {
      const { token } = bodyOf<{ token: string }>(req);
      const { target, invitation } = usable(db, token);
      if (invitation.email !== db.me.email) {
        throw new HttpProblem(
          403,
          "FORBIDDEN",
          "Lời mời này dành cho một email khác: đăng nhập bằng đúng email được mời",
        );
      }
      const at = nowIso();
      if (target.kind === "TEAM") {
        const team = found(
          db.teams.find((t) => t.id === target.id),
          "nhóm",
        );
        if (!team.members.some((m) => m.userId === db.me.id)) {
          team.members.push({
            userId: db.me.id,
            teamRole: target.teamRole,
            createdAt: at,
            user: person(db),
          });
        }
        team.invitations = team.invitations.filter(
          (i) => i.id !== invitation.id,
        );
      } else {
        const p = projectOf(db, target.id);
        if (!p.members.some((m) => m.userId === db.me.id)) {
          p.members.push({
            userId: db.me.id,
            projectRole: target.projectRole,
            createdAt: at,
            user: person(db),
          });
        }
        p.invitations = p.invitations.filter((i) => i.id !== invitation.id);
      }
      forgetToken(db, invitation.id);
      refreshMyAccess(db);
      return ok({ target });
    });
}

/** Lời mời còn dùng được và đích của nó — mọi trường hợp khác CÙNG một 404, như máy chủ thật */
function usable(
  db: Db,
  token: string,
): {
  target: InvitationTargetWire;
  invitation: TeamInvitationWire | ProjectInvitationWire;
} {
  const entry = db.invitationTokens.find((t) => t.token === token);
  const gone = () => new HttpProblem(404, "NOT_FOUND", GONE);
  if (entry === undefined) throw gone();
  if (entry.kind === "TEAM") {
    const team = db.teams.find((t) => t.id === entry.targetId);
    const invitation = team?.invitations.find(
      (i) => i.id === entry.invitationId,
    );
    if (team === undefined || invitation === undefined) throw gone();
    if (Date.parse(invitation.expiresAt) <= Date.now()) throw gone();
    return {
      target: {
        kind: "TEAM",
        id: team.id,
        name: team.name,
        teamRole: invitation.teamRole,
      },
      invitation,
    };
  }
  const p = db.projects.find(
    (x) => x.project.id === entry.targetId && x.project.status !== "DELETED",
  );
  const invitation = p?.invitations.find((i) => i.id === entry.invitationId);
  if (p === undefined || invitation === undefined) throw gone();
  if (Date.parse(invitation.expiresAt) <= Date.now()) throw gone();
  return {
    target: {
      kind: "PROJECT",
      id: p.project.id,
      name: p.project.name,
      projectRole: invitation.projectRole,
    },
    invitation,
  };
}

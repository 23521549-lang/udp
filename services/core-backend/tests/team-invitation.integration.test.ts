import { createHash, randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  API,
  as,
  PASSWORD,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";

/**
 * [v4.11, Plan #55] Lời mời bằng đường dẫn, nhóm, và vai HIỆU LỰC qua HTTP thật.
 *
 * Trọng tâm là các ô ÂM — đường dẫn lọt sang người khác, token đã dùng/thu hồi/hết hạn, người ngoài nhóm, người
 * vừa rời nhóm — vì một bộ test chỉ đi đường vui thì không nói gì về việc ai VÀO ĐƯỢC project.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_team_invitation_test",
});

const app = createApp();
let world: TestWorld;
let owner: Actor;
let projectId: string;

beforeAll(async () => {
  world = testWorld(app, admin);
  owner = await world.newActor("inv-owner");
  ({ projectId } = await world.newProject(owner));
}, 60_000);

afterAll(async () => {
  await world.cleanup();
  await admin.$disconnect();
});

/** Email chưa có tài khoản — người được mời */
const freshEmail = (): string => `inv-guest-${randomUUID()}@udp.local`;

/** Đăng ký đúng email đó (người được mời tạo tài khoản sau khi mở đường dẫn) */
async function registerAs(email: string): Promise<Actor> {
  const res = await request(app)
    .post(`${API}/auth/register`)
    .send({ email, password: PASSWORD, name: "Khách được mời" })
    .expect(201);
  const raw: unknown = res.get("set-cookie");
  const cookies = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  // `world.cleanup` xoá theo email do CHÍNH nó sinh — người này đăng ký ngoài `world`
  registered.push(email);
  return {
    email,
    userId: res.body.user.id as string,
    cookies,
    csrfToken: res.body.csrfToken as string,
  };
}
const registered: string[] = [];
afterAll(async () => {
  const users = await admin.user.findMany({
    where: { email: { in: registered } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  await admin.team.deleteMany({
    where: { members: { some: { userId: { in: ids } } } },
  });
  await admin.auditLog.deleteMany({
    where: { projectId: null, actorUserId: { in: ids } },
  });
  await admin.user.deleteMany({ where: { id: { in: ids } } });
});

async function inviteToProject(
  email: string,
  projectRole = "DEVELOPER",
  pid = projectId,
): Promise<string> {
  const res = await as(
    owner,
    request(app)
      .post(`${API}/projects/${pid}/invitations`)
      .send({ email, projectRole }),
  ).expect(201);
  return res.body.token as string;
}

const lookup = (token: string): request.Test =>
  request(app).post(`${API}/invitations/lookup`).send({ token });

const accept = (actor: Actor, token: string): request.Test =>
  as(actor, request(app).post(`${API}/invitations/accept`).send({ token }));

const myRoleIn = async (actor: Actor, pid: string): Promise<string | null> => {
  const res = await as(actor, request(app).get(`${API}/projects/${pid}`));
  if (res.status === 404) return null;
  expect(res.status).toBe(200);
  return res.body.project.myRole as string;
};

describe("lời mời vào project", () => {
  it("OWNER tạo lời mời cho email chưa có tài khoản — token hiện MỘT lần, database chỉ giữ hash", async () => {
    const email = freshEmail();
    const res = await as(
      owner,
      request(app)
        .post(`${API}/projects/${projectId}/invitations`)
        .send({ email: email.toUpperCase(), projectRole: "DEVELOPER" }),
    ).expect(201);

    const token = res.body.token as string;
    expect(token).toMatch(/^udp_inv_[A-Za-z0-9_-]{43}$/);
    expect(res.body.invitation).toMatchObject({
      email,
      projectRole: "DEVELOPER",
      invitedBy: { id: owner.userId },
    });

    const row = await admin.invitation.findFirstOrThrow({
      where: { id: res.body.invitation.id as string },
    });
    expect(row.tokenHash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(JSON.stringify(row)).not.toContain(token);

    const list = await as(
      owner,
      request(app).get(`${API}/projects/${projectId}/invitations`),
    ).expect(200);
    const listed = (list.body.invitations as { id: string }[]).find(
      (i) => i.id === row.id,
    );
    expect(listed).toBeDefined();
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  it("chỉ OWNER tạo và xem được; người ngoài nhận 404", async () => {
    const maintainer = await world.newActor("inv-maint");
    await world.addMember(owner, projectId, maintainer, "MAINTAINER");
    const outsider = await world.newActor("inv-out");

    for (const [actor, status] of [
      [maintainer, 403],
      [outsider, 404],
    ] as const) {
      await as(
        actor,
        request(app)
          .post(`${API}/projects/${projectId}/invitations`)
          .send({ email: freshEmail(), projectRole: "VIEWER" }),
      ).expect(status);
      await as(
        actor,
        request(app).get(`${API}/projects/${projectId}/invitations`),
      ).expect(status);
    }
  });

  it("không mời được vai OWNER — chủ sở hữu chỉ đổi qua chuyển quyền", async () => {
    await as(
      owner,
      request(app)
        .post(`${API}/projects/${projectId}/invitations`)
        .send({ email: freshEmail(), projectRole: "OWNER" }),
    ).expect(400);
  });

  it("người cầm đường dẫn xem được lời mời KHÔNG cần phiên hay CSRF", async () => {
    const email = freshEmail();
    const token = await inviteToProject(email, "VIEWER");
    const res = await lookup(token).expect(200);
    expect(res.body.invitation).toMatchObject({
      target: { kind: "PROJECT", id: projectId, projectRole: "VIEWER" },
      email,
      invitedBy: { name: "Test User" },
    });
  });

  it("đăng ký đúng email rồi nhận ⇒ vào project với vai được mời; đường dẫn chỉ dùng MỘT lần", async () => {
    const email = freshEmail();
    const token = await inviteToProject(email, "DEVELOPER");
    const guest = await registerAs(email);

    const res = await accept(guest, token).expect(200);
    expect(res.body.target).toMatchObject({
      kind: "PROJECT",
      id: projectId,
      projectRole: "DEVELOPER",
    });
    expect(await myRoleIn(guest, projectId)).toBe("DEVELOPER");

    await accept(guest, token).expect(404);
    await lookup(token).expect(404);

    const audit = await admin.auditLog.findMany({
      where: { projectId, action: { startsWith: "invitation." } },
    });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["invitation.create", "invitation.accept"]),
    );
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("đường dẫn lọt sang tài khoản KHÁC ⇒ 403, lời mời vẫn chờ đúng người", async () => {
    const email = freshEmail();
    const token = await inviteToProject(email);
    const stranger = await world.newActor("inv-stranger");

    await accept(stranger, token).expect(403);
    expect(await myRoleIn(stranger, projectId)).toBeNull();
    await lookup(token).expect(200);
  });

  it("mời lại cùng email thu hồi đường dẫn cũ; thu hồi tay ⇒ 404; hết hạn ⇒ 404 — cùng MỘT 404", async () => {
    const email = freshEmail();
    const first = await inviteToProject(email);
    const second = await inviteToProject(email);
    const gone = await lookup(first).expect(404);
    await lookup(second).expect(200);

    const pending = await admin.invitation.findFirstOrThrow({
      where: { projectId, email, revokedAt: null, acceptedAt: null },
    });
    await as(
      owner,
      request(app).delete(
        `${API}/projects/${projectId}/invitations/${pending.id}`,
      ),
    ).expect(204);
    const revoked = await lookup(second).expect(404);
    await as(
      owner,
      request(app).delete(
        `${API}/projects/${projectId}/invitations/${pending.id}`,
      ),
    ).expect(404);

    const third = await inviteToProject(email);
    await admin.invitation.updateMany({
      where: { projectId, email, revokedAt: null, acceptedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await lookup(third).expect(404);

    expect(revoked.body.detail).toBe(gone.body.detail);
    expect(expired.body.detail).toBe(gone.body.detail);
    await lookup(`udp_inv_${"x".repeat(43)}`).expect(404);
  });

  it("token sai hình ⇒ 400 trước khi chạm database", async () => {
    await lookup("not-a-token").expect(400);
  });

  it("mời người đã là thành viên ⇒ 409", async () => {
    const member = await world.newActor("inv-member");
    await world.addMember(owner, projectId, member, "VIEWER");
    await as(
      owner,
      request(app)
        .post(`${API}/projects/${projectId}/invitations`)
        .send({ email: member.email, projectRole: "DEVELOPER" }),
    ).expect(409);
  });

  it("nhận lời mời KHÔNG hạ vai người đã có vai cao hơn", async () => {
    const email = freshEmail();
    const token = await inviteToProject(email, "VIEWER");
    const guest = await registerAs(email);
    await as(
      owner,
      request(app)
        .post(`${API}/projects/${projectId}/members`)
        .send({ email, projectRole: "MAINTAINER" }),
    ).expect(201);

    await accept(guest, token).expect(200);
    expect(await myRoleIn(guest, projectId)).toBe("MAINTAINER");
  });

  it("nhận lời mời cần đăng nhập", async () => {
    const token = await inviteToProject(freshEmail());
    await request(app)
      .post(`${API}/invitations/accept`)
      .send({ token })
      .expect((res) => {
        expect([401, 403]).toContain(res.status);
      });
  });
});

async function createTeam(actor: Actor, name = "Nhóm thanh toán") {
  const res = await as(
    actor,
    request(app).post(`${API}/teams`).send({ name }),
  ).expect(201);
  return res.body.team.id as string;
}

async function addToTeam(
  teamOwner: Actor,
  teamId: string,
  member: Actor,
  teamRole: "OWNER" | "MEMBER" = "MEMBER",
): Promise<void> {
  await as(
    teamOwner,
    request(app)
      .post(`${API}/teams/${teamId}/members`)
      .send({ email: member.email, teamRole }),
  ).expect(201);
}

async function grantTeam(
  projectOwner: Actor,
  pid: string,
  teamId: string,
  projectRole: string,
): Promise<request.Response> {
  return as(
    projectOwner,
    request(app)
      .post(`${API}/projects/${pid}/teams`)
      .send({ teamId, projectRole }),
  );
}

describe("nhóm", () => {
  it("người tạo là chủ nhóm; danh sách chỉ có nhóm của mình", async () => {
    const lead = await world.newActor("team-lead");
    const other = await world.newActor("team-other");
    const teamId = await createTeam(lead, "  Nhóm di động  ");

    const mine = await as(lead, request(app).get(`${API}/teams`)).expect(200);
    expect(mine.body.teams).toEqual([
      expect.objectContaining({
        id: teamId,
        name: "Nhóm di động",
        myRole: "OWNER",
        memberCount: 1,
        projectCount: 0,
      }),
    ]);
    const theirs = await as(other, request(app).get(`${API}/teams`)).expect(
      200,
    );
    expect(theirs.body.teams).toEqual([]);
  });

  it("người ngoài nhóm nhận 404 ở mọi route của nhóm; thành viên thường không sửa được nhóm", async () => {
    const lead = await world.newActor("team-lead");
    const member = await world.newActor("team-member");
    const outsider = await world.newActor("team-outsider");
    const teamId = await createTeam(lead);
    await addToTeam(lead, teamId, member);

    await as(outsider, request(app).get(`${API}/teams/${teamId}`)).expect(404);
    await as(
      outsider,
      request(app).patch(`${API}/teams/${teamId}`).send({ name: "x" }),
    ).expect(404);
    await as(
      outsider,
      request(app).get(`${API}/teams/${teamId}/invitations`),
    ).expect(404);

    const seen = await as(
      member,
      request(app).get(`${API}/teams/${teamId}`),
    ).expect(200);
    expect(seen.body.team.myRole).toBe("MEMBER");
    await as(
      member,
      request(app).patch(`${API}/teams/${teamId}`).send({ name: "x" }),
    ).expect(403);
    await as(
      member,
      request(app).delete(`${API}/teams/${teamId}/members/${lead.userId}`),
    ).expect(403);
  });

  it("thêm theo email: chưa có tài khoản ⇒ 404; trùng ⇒ 409", async () => {
    const lead = await world.newActor("team-lead");
    const member = await world.newActor("team-member");
    const teamId = await createTeam(lead);
    await as(
      lead,
      request(app)
        .post(`${API}/teams/${teamId}/members`)
        .send({ email: freshEmail(), teamRole: "MEMBER" }),
    ).expect(404);
    await addToTeam(lead, teamId, member);
    await as(
      lead,
      request(app)
        .post(`${API}/teams/${teamId}/members`)
        .send({ email: member.email, teamRole: "MEMBER" }),
    ).expect(409);
  });

  it("nhóm luôn còn một chủ nhóm: không tự hạ, không tự rời khi là chủ cuối; giao vai rồi rời được", async () => {
    const lead = await world.newActor("team-lead");
    const next = await world.newActor("team-next");
    const teamId = await createTeam(lead);
    await addToTeam(lead, teamId, next);

    await as(
      lead,
      request(app)
        .patch(`${API}/teams/${teamId}/members/${lead.userId}`)
        .send({ teamRole: "MEMBER" }),
    ).expect(409);
    await as(
      lead,
      request(app).delete(`${API}/teams/${teamId}/members/${lead.userId}`),
    ).expect(409);

    await as(
      lead,
      request(app)
        .patch(`${API}/teams/${teamId}/members/${next.userId}`)
        .send({ teamRole: "OWNER" }),
    ).expect(200);
    await as(
      lead,
      request(app).delete(`${API}/teams/${teamId}/members/${lead.userId}`),
    ).expect(204);
    await as(lead, request(app).get(`${API}/teams/${teamId}`)).expect(404);
  });

  it("thành viên thường tự rời được", async () => {
    const lead = await world.newActor("team-lead");
    const member = await world.newActor("team-member");
    const teamId = await createTeam(lead);
    await addToTeam(lead, teamId, member);
    await as(
      member,
      request(app).delete(`${API}/teams/${teamId}/members/${member.userId}`),
    ).expect(204);
    await as(member, request(app).get(`${API}/teams/${teamId}`)).expect(404);
  });

  it("lời mời vào nhóm: chủ nhóm tạo, người được mời đăng ký rồi nhận", async () => {
    const lead = await world.newActor("team-lead");
    const teamId = await createTeam(lead);
    const email = freshEmail();
    const res = await as(
      lead,
      request(app)
        .post(`${API}/teams/${teamId}/invitations`)
        .send({ email, teamRole: "MEMBER" }),
    ).expect(201);
    const token = res.body.token as string;

    const seen = await lookup(token).expect(200);
    expect(seen.body.invitation.target).toMatchObject({
      kind: "TEAM",
      id: teamId,
      teamRole: "MEMBER",
    });
    const listed = await as(
      lead,
      request(app).get(`${API}/teams/${teamId}/invitations`),
    ).expect(200);
    expect(listed.body.invitations).toHaveLength(1);

    const guest = await registerAs(email);
    await accept(guest, token).expect(200);
    const team = await as(
      guest,
      request(app).get(`${API}/teams/${teamId}`),
    ).expect(200);
    expect(team.body.team.myRole).toBe("MEMBER");
  });

  it("đổi tên và xoá nhóm", async () => {
    const lead = await world.newActor("team-lead");
    const teamId = await createTeam(lead);
    const renamed = await as(
      lead,
      request(app).patch(`${API}/teams/${teamId}`).send({ name: "Nền tảng" }),
    ).expect(200);
    expect(renamed.body.team.name).toBe("Nền tảng");
    await as(
      lead,
      request(app).patch(`${API}/teams/${teamId}`).send({ name: "   " }),
    ).expect(400);
    await as(lead, request(app).delete(`${API}/teams/${teamId}`)).expect(204);
    await as(lead, request(app).get(`${API}/teams/${teamId}`)).expect(404);
  });
});

describe("quyền của nhóm trên project — vai hiệu lực", () => {
  it("cấp cho nhóm ⇒ mọi người trong nhóm vào được project với vai của nhóm, ở chi tiết, danh sách và trang chủ", async () => {
    const lead = await world.newActor("grant-lead");
    const dev = await world.newActor("grant-dev");
    const { projectId: pid } = await world.newProject(lead);
    const teamId = await createTeam(lead);
    await addToTeam(lead, teamId, dev);

    expect(await myRoleIn(dev, pid)).toBeNull();
    const granted = await grantTeam(lead, pid, teamId, "DEVELOPER");
    expect(granted.status).toBe(201);
    expect(granted.body.team).toMatchObject({
      teamId,
      projectRole: "DEVELOPER",
    });
    expect(
      (granted.body.team.members as { id: string }[]).map((m) => m.id).sort(),
    ).toEqual([lead.userId, dev.userId].sort());

    expect(await myRoleIn(dev, pid)).toBe("DEVELOPER");
    const list = await as(dev, request(app).get(`${API}/projects`)).expect(200);
    expect(
      (list.body.projects as { id: string; myRole: string }[]).find(
        (p) => p.id === pid,
      )?.myRole,
    ).toBe("DEVELOPER");
    const home = await as(dev, request(app).get(`${API}/home`)).expect(200);
    expect(
      (home.body.home.projects as { id: string; myRole: string }[]).find(
        (p) => p.id === pid,
      )?.myRole,
    ).toBe("DEVELOPER");

    // Vai của nhóm là trần: việc của OWNER vẫn đòi đúng người chủ
    await as(
      dev,
      request(app)
        .post(`${API}/projects/${pid}/invitations`)
        .send({ email: freshEmail(), projectRole: "VIEWER" }),
    ).expect(403);

    const seen = await as(
      dev,
      request(app).get(`${API}/projects/${pid}/teams`),
    ).expect(200);
    expect(seen.body.teams).toHaveLength(1);

    const team = await as(
      dev,
      request(app).get(`${API}/teams/${teamId}`),
    ).expect(200);
    expect(team.body.team.projects).toEqual([
      expect.objectContaining({ id: pid, projectRole: "DEVELOPER" }),
    ]);
  });

  it("vai hiệu lực là vai CAO NHẤT giữa thành viên trực tiếp và nhóm", async () => {
    const lead = await world.newActor("grant-lead");
    const a = await world.newActor("grant-a");
    const b = await world.newActor("grant-b");
    const { projectId: pid } = await world.newProject(lead);
    const teamId = await createTeam(lead);
    await addToTeam(lead, teamId, a);
    await addToTeam(lead, teamId, b);
    await grantTeam(lead, pid, teamId, "DEVELOPER").then((r) =>
      expect(r.status).toBe(201),
    );

    await world.addMember(lead, pid, a, "VIEWER");
    await world.addMember(lead, pid, b, "MAINTAINER");
    expect(await myRoleIn(a, pid)).toBe("DEVELOPER");
    expect(await myRoleIn(b, pid)).toBe("MAINTAINER");
  });

  it("rời nhóm, gỡ quyền của nhóm, hay xoá nhóm ⇒ mất quyền ngay ở request kế tiếp", async () => {
    const lead = await world.newActor("grant-lead");
    const x = await world.newActor("grant-x");
    const y = await world.newActor("grant-y");
    const { projectId: pid } = await world.newProject(lead);
    const teamId = await createTeam(lead);
    await addToTeam(lead, teamId, x);
    await addToTeam(lead, teamId, y);
    await grantTeam(lead, pid, teamId, "VIEWER").then((r) =>
      expect(r.status).toBe(201),
    );
    expect(await myRoleIn(x, pid)).toBe("VIEWER");

    await as(
      x,
      request(app).delete(`${API}/teams/${teamId}/members/${x.userId}`),
    ).expect(204);
    expect(await myRoleIn(x, pid)).toBeNull();

    await as(
      lead,
      request(app)
        .patch(`${API}/projects/${pid}/teams/${teamId}`)
        .send({ projectRole: "MAINTAINER" }),
    ).expect(200);
    expect(await myRoleIn(y, pid)).toBe("MAINTAINER");

    await as(
      lead,
      request(app).delete(`${API}/projects/${pid}/teams/${teamId}`),
    ).expect(204);
    expect(await myRoleIn(y, pid)).toBeNull();

    await grantTeam(lead, pid, teamId, "VIEWER").then((r) =>
      expect(r.status).toBe(201),
    );
    expect(await myRoleIn(y, pid)).toBe("VIEWER");
    await as(lead, request(app).delete(`${API}/teams/${teamId}`)).expect(204);
    expect(await myRoleIn(y, pid)).toBeNull();

    const audit = await admin.auditLog.findMany({
      where: { projectId: pid, action: { startsWith: "team." } },
      select: { action: true },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      "team.grant",
      "team.grant",
      "team.grant.update",
      "team.revoke",
    ]);
  });

  it("chỉ OWNER project cấp; người cấp phải thuộc nhóm; không vai OWNER; không cấp trùng", async () => {
    const lead = await world.newActor("grant-lead");
    const stranger = await world.newActor("grant-stranger");
    const { projectId: pid } = await world.newProject(lead);
    const teamId = await createTeam(lead);
    const foreignTeam = await createTeam(stranger);

    expect((await grantTeam(lead, pid, foreignTeam, "VIEWER")).status).toBe(
      404,
    );
    expect((await grantTeam(lead, pid, teamId, "OWNER")).status).toBe(400);
    expect((await grantTeam(lead, pid, teamId, "VIEWER")).status).toBe(201);
    expect((await grantTeam(lead, pid, teamId, "VIEWER")).status).toBe(409);

    await world.addMember(lead, pid, stranger, "MAINTAINER");
    expect((await grantTeam(stranger, pid, foreignTeam, "VIEWER")).status).toBe(
      403,
    );
  });
});

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inRollback, openClient } from "../helpers/db.js";

/**
 * [v4.11, Plan #55] Ràng buộc của nhóm và lời mời mà Prisma không biểu diễn được — giữ ở tầng database vì mọi
 * đường ghi (API, seed, script quản trị) đều đi qua đó:
 *
 * - grant của nhóm không bao giờ là OWNER (chủ sở hữu luôn là MỘT người);
 * - lời mời có đúng một đích và vai đúng kiểu của đích, email chữ thường;
 * - mỗi (đích, email) chỉ một lời mời đang chờ — lời đã thu hồi hay đã nhận không chiếm chỗ.
 *
 * Mỗi ca chạy trong một transaction rồi lùi — không để lại gì.
 */

let client: Client;

beforeAll(async () => {
  client = await openClient();
});

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  await client?.end();
});

/** Một project, một người dùng và một nhóm mới trong transaction đang mở */
async function fixture(): Promise<{
  projectId: string;
  userId: string;
  teamId: string;
}> {
  const project = await client.query<{ id: string; owner_id: string }>(
    `SELECT id, owner_id FROM projects ORDER BY created_at LIMIT 1`,
  );
  const row = project.rows[0];
  if (row === undefined) throw new Error("database chưa seed project nào");
  const team = await client.query<{ id: string }>(
    `INSERT INTO teams (id, name) VALUES (gen_random_uuid(), 'check-team') RETURNING id`,
  );
  const teamId = team.rows[0]?.id;
  if (teamId === undefined) throw new Error("không tạo được nhóm");
  return { projectId: row.id, userId: row.owner_id, teamId };
}

interface InvitationRow {
  projectId?: string | null;
  teamId?: string | null;
  email?: string;
  projectRole?: string | null;
  teamRole?: string | null;
  revoked?: boolean;
}

async function invite(invitedBy: string, row: InvitationRow): Promise<void> {
  await client.query(
    `INSERT INTO invitations (id, project_id, team_id, email, project_role, team_role, token_hash, invited_by,
                              expires_at, revoked_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4::"ProjectRole", $5::"TeamRole",
             encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $6, now() + interval '7 days',
             CASE WHEN $7 THEN now() END)`,
    [
      row.projectId ?? null,
      row.teamId ?? null,
      row.email ?? "moi@example.com",
      row.projectRole ?? null,
      row.teamRole ?? null,
      invitedBy,
      row.revoked ?? false,
    ],
  );
}

describe("project_team_grants", () => {
  it("nhận MAINTAINER, từ chối OWNER ⇒ 23514", async () => {
    const grant = (role: string) =>
      inRollback(client, async () => {
        const f = await fixture();
        await client.query(
          `INSERT INTO project_team_grants (id, project_id, team_id, project_role)
           VALUES (gen_random_uuid(), $1, $2, $3::"ProjectRole")`,
          [f.projectId, f.teamId, role],
        );
      });
    expect((await grant("MAINTAINER")).error).toBeUndefined();
    expect((await grant("OWNER")).error?.code).toBe("23514");
  });

  it("tên nhóm rỗng ⇒ 23514", async () => {
    const r = await inRollback(client, () =>
      client.query(
        `INSERT INTO teams (id, name) VALUES (gen_random_uuid(), '   ')`,
      ),
    );
    expect(r.error?.code).toBe("23514");
  });
});

describe("invitations", () => {
  it("nhận lời mời vào project và lời mời vào nhóm đúng hình", async () => {
    const r = await inRollback(client, async () => {
      const f = await fixture();
      await invite(f.userId, { projectId: f.projectId, projectRole: "VIEWER" });
      await invite(f.userId, { teamId: f.teamId, teamRole: "MEMBER" });
    });
    expect(r.error).toBeUndefined();
  });

  it.each<
    [string, (f: { projectId: string; teamId: string }) => InvitationRow]
  >([
    ["hai đích", (f) => ({ ...f, projectRole: "VIEWER", teamRole: "MEMBER" })],
    ["không đích", () => ({ projectRole: "VIEWER" })],
    [
      "project kèm vai nhóm",
      (f) => ({ projectId: f.projectId, teamRole: "MEMBER" }),
    ],
    [
      "nhóm kèm vai project",
      (f) => ({ teamId: f.teamId, projectRole: "VIEWER" }),
    ],
    [
      "vai OWNER của project",
      (f) => ({ projectId: f.projectId, projectRole: "OWNER" }),
    ],
    [
      "email chữ hoa",
      (f) => ({
        projectId: f.projectId,
        projectRole: "VIEWER",
        email: "Moi@Example.com",
      }),
    ],
  ])("từ chối %s ⇒ 23514", async (_label, shape) => {
    const r = await inRollback(client, async () => {
      const f = await fixture();
      await invite(f.userId, shape(f));
    });
    expect(r.error?.code).toBe("23514");
  });

  it("mỗi (đích, email) chỉ một lời mời đang chờ ⇒ 23505", async () => {
    const r = await inRollback(client, async () => {
      const f = await fixture();
      await invite(f.userId, { projectId: f.projectId, projectRole: "VIEWER" });
      await invite(f.userId, {
        projectId: f.projectId,
        projectRole: "DEVELOPER",
      });
    });
    expect(r.error?.code).toBe("23505");

    const team = await inRollback(client, async () => {
      const f = await fixture();
      await invite(f.userId, { teamId: f.teamId, teamRole: "MEMBER" });
      await invite(f.userId, { teamId: f.teamId, teamRole: "OWNER" });
    });
    expect(team.error?.code).toBe("23505");
  });

  it("lời mời đã thu hồi không chiếm chỗ của lời mời mới", async () => {
    const r = await inRollback(client, async () => {
      const f = await fixture();
      await invite(f.userId, {
        projectId: f.projectId,
        projectRole: "VIEWER",
        revoked: true,
      });
      await invite(f.userId, { projectId: f.projectId, projectRole: "VIEWER" });
    });
    expect(r.error).toBeUndefined();
  });

  it("xoá nhóm kéo theo thành viên, grant và lời mời của nhóm", async () => {
    const r = await inRollback(client, async () => {
      const f = await fixture();
      await client.query(
        `INSERT INTO team_members (id, team_id, user_id, team_role) VALUES (gen_random_uuid(), $1, $2, 'OWNER')`,
        [f.teamId, f.userId],
      );
      await client.query(
        `INSERT INTO project_team_grants (id, project_id, team_id, project_role)
         VALUES (gen_random_uuid(), $1, $2, 'VIEWER')`,
        [f.projectId, f.teamId],
      );
      await invite(f.userId, { teamId: f.teamId, teamRole: "MEMBER" });
      await client.query(`DELETE FROM teams WHERE id = $1`, [f.teamId]);
      const left = await client.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM team_members WHERE team_id = $1)
              + (SELECT count(*) FROM project_team_grants WHERE team_id = $1)
              + (SELECT count(*) FROM invitations WHERE team_id = $1) AS n`,
        [f.teamId],
      );
      return Number(left.rows[0]?.n);
    });
    expect(r.error).toBeUndefined();
    expect(r.value).toBe(0);
  });
});

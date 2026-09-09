import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/**
 * Lõi đa tenant qua HTTP thật: project, thành viên, phân quyền, audit.
 *
 * Trọng tâm là các phép thử ÂM. Một bộ test chỉ chứng minh "OWNER làm được việc
 * của OWNER" không nói gì về cô lập tenant — thứ duy nhất đáng lo ở đây là
 * người ngoài đọc được project của người khác, hay VIEWER sửa được quota.
 */

const app = createApp();
const API = "/api/v1";
const PASSWORD = "dev-password-12345";

/**
 * Dọn dẹp phải chạy bằng quyền OWNER của database, không phải `udp_s1`.
 *
 * Đó không phải lối tắt mà là hệ quả trực tiếp của thiết kế: `udp_s1` chỉ có
 * `SELECT, INSERT` trên `audit_logs` (bảng append-only, §1.2), còn
 * `AuditLog.project` là `ON DELETE RESTRICT`. Nên ứng dụng KHÔNG thể xoá một
 * project đã từng bị ghi audit — đúng như §2.3 muốn. Việc dọn dữ liệu test vì
 * thế là việc của người vận hành, và test phải nói thật điều đó thay vì cấp
 * thêm quyền cho service để cho tiện.
 */
const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_test_admin",
});

const createdUsers: string[] = [];

interface Actor {
  email: string;
  userId: string;
  cookies: string[];
  csrfToken: string;
}

const setCookies = (res: request.Response): string[] => {
  const raw: unknown = res.get("set-cookie");
  return Array.isArray(raw) ? (raw as string[]) : typeof raw === "string" ? [raw] : [];
};

async function newActor(): Promise<Actor> {
  const email = `test-${randomUUID()}@udp.local`;
  const res = await request(app)
    .post(`${API}/auth/register`)
    .send({ email, password: PASSWORD, name: "Test User" })
    .expect(201);
  createdUsers.push(email);
  return {
    email,
    userId: res.body.user.id as string,
    cookies: setCookies(res),
    csrfToken: res.body.csrfToken as string,
  };
}

const as = (actor: Actor, req: request.Test): request.Test =>
  req.set("Cookie", actor.cookies).set("X-CSRF-Token", actor.csrfToken);

function newProject(owner: Actor, name?: string): request.Test {
  return as(
    owner,
    request(app).post(`${API}/projects`).send({
      name: name ?? `proj-${randomUUID().slice(0, 8)}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
    }),
  );
}

afterAll(async () => {
  if (createdUsers.length > 0) {
    const users = await admin.user.findMany({
      where: { email: { in: createdUsers } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    const projects = await admin.project.findMany({
      where: { ownerId: { in: ids } },
      select: { id: true },
    });
    const projectIds = projects.map((p) => p.id);

    // Thứ tự ngược của quan hệ: audit giữ project, project giữ user.
    await admin.auditLog.deleteMany({ where: { projectId: { in: projectIds } } });
    await admin.project.deleteMany({ where: { id: { in: projectIds } } });
    await admin.user.deleteMany({ where: { id: { in: ids } } });
  }
  await admin.$disconnect();
});

describe("tạo project", () => {
  it("sinh project DRAFT, hàng OWNER và ba environment mặc định", async () => {
    const owner = await newActor();
    const res = await newProject(owner).expect(201);

    expect(res.body.project.status).toBe("DRAFT");
    expect(res.body.project.ownerId).toBe(owner.userId);
    expect(res.body.environments.map((e: { name: string }) => e.name)).toEqual([
      "dev",
      "staging",
      "prod",
    ]);

    // §8.3: production KHÔNG được tự deploy từ webhook. Mặc định của schema là
    // `true`, nên nếu service quên đặt tường minh thì dòng này đỏ.
    const prod = res.body.environments.find((e: { name: string }) => e.name === "prod");
    expect(prod.autoDeploy).toBe(false);
    expect(prod.isProduction).toBe(true);

    // Ba namespace phải PHÂN BIỆT và hợp lệ DNS-1123 — bản sinh namespace cũ
    // cho ba chuỗi giống hệt nhau khi tên project dài.
    const namespaces = res.body.environments.map((e: { k8sNamespace: string }) => e.k8sNamespace);
    expect(new Set(namespaces).size).toBe(3);
    for (const ns of namespaces) {
      expect(ns).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
      expect(ns.length).toBeLessThanOrEqual(63);
    }
  });

  it("tên project dài và có dấu tiếng Việt vẫn ra ba namespace hợp lệ", async () => {
    const owner = await newActor();
    const res = await newProject(
      owner,
      "Dự án quản lý bán hàng trực tuyến cho doanh nghiệp vừa và nhỏ",
    ).expect(201);

    const namespaces = res.body.environments.map((e: { k8sNamespace: string }) => e.k8sNamespace);
    expect(new Set(namespaces).size).toBe(3);
    for (const ns of namespaces) {
      expect(ns).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    }
  });

  it("cùng chủ sở hữu không đặt trùng tên project", async () => {
    const owner = await newActor();
    const name = `dup-${randomUUID().slice(0, 8)}`;
    await newProject(owner, name).expect(201);

    const res = await newProject(owner, name).expect(409);
    expect(res.body.code).toBe("DUPLICATE_RESOURCE");
  });

  it("hai người khác nhau vẫn đặt trùng tên được", async () => {
    const a = await newActor();
    const b = await newActor();
    const name = `shared-${randomUUID().slice(0, 8)}`;

    await newProject(a, name).expect(201);
    await newProject(b, name).expect(201);
  });

  it("IMPORT_EXISTING thiếu repoUrl bị từ chối", async () => {
    const owner = await newActor();
    await as(
      owner,
      request(app).post(`${API}/projects`).send({
        name: `imp-${randomUUID().slice(0, 8)}`,
        creationMode: "IMPORT_EXISTING",
        languageRuntime: "nodejs",
      }),
    ).expect(400);
  });
});

describe("cô lập giữa các tenant", () => {
  it("người ngoài nhận 404 chứ không phải 403 — không dò được project có thật", async () => {
    const owner = await newActor();
    const stranger = await newActor();
    const { body } = await newProject(owner).expect(201);

    await as(stranger, request(app).get(`${API}/projects/${body.project.id}`)).expect(404);
  });

  it("GET /projects chỉ trả project mà mình là thành viên", async () => {
    const owner = await newActor();
    const stranger = await newActor();
    const { body } = await newProject(owner).expect(201);

    const mine = await as(owner, request(app).get(`${API}/projects`)).expect(200);
    expect(mine.body.projects.map((p: { id: string }) => p.id)).toContain(body.project.id);

    const theirs = await as(stranger, request(app).get(`${API}/projects`)).expect(200);
    expect(theirs.body.projects.map((p: { id: string }) => p.id)).not.toContain(body.project.id);
  });

  it("id không phải UUID trả 400, không phải 500", async () => {
    const owner = await newActor();
    await as(owner, request(app).get(`${API}/projects/khong-phai-uuid`)).expect(400);
  });
});

describe("phân quyền theo vai trò", () => {
  it("VIEWER không sửa được quota, OWNER thì được", async () => {
    const owner = await newActor();
    const viewer = await newActor();
    const { body } = await newProject(owner).expect(201);
    const id = body.project.id as string;

    await as(
      owner,
      request(app)
        .post(`${API}/projects/${id}/members`)
        .send({ email: viewer.email, projectRole: "VIEWER" }),
    ).expect(201);

    const quota = {
      resourceQuota: {
        maxNodes: 5,
        maxNodeSize: "large",
        maxDatabases: 3,
        maxStorageGb: 100,
        maxLoadBalancers: 2,
      },
    };

    await as(viewer, request(app).patch(`${API}/projects/${id}/quota`).send(quota)).expect(403);
    await as(owner, request(app).patch(`${API}/projects/${id}/quota`).send(quota)).expect(200);
  });

  it("MAINTAINER vẫn không thêm được thành viên — §2.2 để việc đó cho OWNER", async () => {
    const owner = await newActor();
    const maintainer = await newActor();
    const outsider = await newActor();
    const { body } = await newProject(owner).expect(201);
    const id = body.project.id as string;

    await as(
      owner,
      request(app)
        .post(`${API}/projects/${id}/members`)
        .send({ email: maintainer.email, projectRole: "MAINTAINER" }),
    ).expect(201);

    await as(
      maintainer,
      request(app)
        .post(`${API}/projects/${id}/members`)
        .send({ email: outsider.email, projectRole: "VIEWER" }),
    ).expect(403);
  });

  it("không đặt được vai trò OWNER qua endpoint thành viên", async () => {
    const owner = await newActor();
    const other = await newActor();
    const { body } = await newProject(owner).expect(201);
    const id = body.project.id as string;

    await as(
      owner,
      request(app)
        .post(`${API}/projects/${id}/members`)
        .send({ email: other.email, projectRole: "OWNER" }),
    ).expect(400);
  });
});

describe("chuyển quyền sở hữu", () => {
  it("hạ chủ cũ, nâng chủ mới, và cập nhật cả Project.ownerId", async () => {
    const owner = await newActor();
    const heir = await newActor();
    const { body } = await newProject(owner).expect(201);
    const id = body.project.id as string;

    await as(
      owner,
      request(app)
        .post(`${API}/projects/${id}/members`)
        .send({ email: heir.email, projectRole: "DEVELOPER" }),
    ).expect(201);

    await as(
      owner,
      request(app).post(`${API}/projects/${id}/transfer-ownership`).send({ userId: heir.userId }),
    ).expect(200);

    const members = await admin.projectMember.findMany({
      where: { projectId: id },
      select: { userId: true, projectRole: true },
    });
    const owners = members.filter((m) => m.projectRole === "OWNER");

    expect(owners).toHaveLength(1);
    expect(owners[0]?.userId).toBe(heir.userId);
    expect(members.find((m) => m.userId === owner.userId)?.projectRole).toBe("MAINTAINER");

    // Cột denormalized phải đi cùng — nếu quên, hai nguồn sự thật lệch nhau và
    // không ràng buộc nào trong database phát hiện được.
    const project = await admin.project.findUnique({ where: { id }, select: { ownerId: true } });
    expect(project?.ownerId).toBe(heir.userId);
  });

  it("không xoá được thành viên đang là chủ sở hữu", async () => {
    const owner = await newActor();
    const { body } = await newProject(owner).expect(201);
    const id = body.project.id as string;

    await as(
      owner,
      request(app).delete(`${API}/projects/${id}/members/${owner.userId}`),
    ).expect(409);
  });

  it("người nhận phải đã là thành viên", async () => {
    const owner = await newActor();
    const outsider = await newActor();
    const { body } = await newProject(owner).expect(201);

    await as(
      owner,
      request(app)
        .post(`${API}/projects/${body.project.id}/transfer-ownership`)
        .send({ userId: outsider.userId }),
    ).expect(404);
  });
});

describe("xoá mềm", () => {
  it("project đã xoá không còn đọc được, nhưng hàng vẫn nằm trong database", async () => {
    const owner = await newActor();
    const { body } = await newProject(owner).expect(201);
    const id = body.project.id as string;

    await as(owner, request(app).delete(`${API}/projects/${id}`)).expect(204);
    await as(owner, request(app).get(`${API}/projects/${id}`)).expect(404);

    const row = await admin.project.findUnique({ where: { id }, select: { status: true } });
    expect(row?.status).toBe("DELETED");
  });

  it("xoá rồi vẫn tạo lại được project cùng tên", async () => {
    const owner = await newActor();
    const name = `recycle-${randomUUID().slice(0, 8)}`;
    const first = await newProject(owner, name).expect(201);

    await as(owner, request(app).delete(`${API}/projects/${first.body.project.id}`)).expect(204);
    await newProject(owner, name).expect(201);
  });
});

describe("nhật ký kiểm toán", () => {
  it("ghi lại việc tạo project và đổi quota", async () => {
    const owner = await newActor();
    const { body } = await newProject(owner).expect(201);
    const id = body.project.id as string;

    const res = await as(owner, request(app).get(`${API}/projects/${id}/audit`)).expect(200);
    const actions = res.body.entries.map((e: { action: string }) => e.action);

    expect(actions).toContain("project.create");
    expect(res.body.entries[0].actorUserId).toBe(owner.userId);
  });

  it("limit vượt trần bị từ chối thay vì kéo cả bảng", async () => {
    const owner = await newActor();
    const { body } = await newProject(owner).expect(201);
    const path = `${API}/projects/${body.project.id}/audit`;

    await as(owner, request(app).get(`${path}?limit=1000000000`)).expect(400);
    await as(owner, request(app).get(`${path}?limit=-5`)).expect(400);
    await as(owner, request(app).get(`${path}?limit=`)).expect(400);
  });

  it("from không có offset múi giờ bị từ chối", async () => {
    const owner = await newActor();
    const { body } = await newProject(owner).expect(201);

    await as(
      owner,
      request(app).get(`${API}/projects/${body.project.id}/audit?from=2026-09-09`),
    ).expect(400);
  });
});

describe("Idempotency-Key tren POST /members", () => {
  it("cung key cung body: lan hai phat lai response cu, KHONG them lan nua", async () => {
    const owner = await newActor();
    const invitee = await newActor();
    const { body } = await newProject(owner).expect(201);
    const id = body.project.id as string;
    const key = randomUUID();
    const payload = { email: invitee.email, projectRole: "VIEWER" };

    const first = await as(owner, request(app).post(`${API}/projects/${id}/members`))
      .set("Idempotency-Key", key)
      .send(payload)
      .expect(201);

    const second = await as(owner, request(app).post(`${API}/projects/${id}/members`))
      .set("Idempotency-Key", key)
      .send(payload)
      .expect(201);

    expect(second.get("Idempotency-Replayed")).toBe("true");
    expect(second.body).toEqual(first.body);

    // Phep thu that nam o day: khong co middleware, lan hai se dung
    // @@unique([projectId, userId]) va tra 409 — tuc la nguoi bam hai lan do
    // mang cham bi bao loi, dung thu §9 noi KHONG duoc xay ra.
    const members = await admin.projectMember.count({
      where: { projectId: id, userId: invitee.userId },
    });
    expect(members).toBe(1);
  });

  it("cung key khac body: 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const owner = await newActor();
    const first = await newActor();
    const second = await newActor();
    const { body } = await newProject(owner).expect(201);
    const id = body.project.id as string;
    const key = randomUUID();

    await as(owner, request(app).post(`${API}/projects/${id}/members`))
      .set("Idempotency-Key", key)
      .send({ email: first.email, projectRole: "VIEWER" })
      .expect(201);

    const res = await as(owner, request(app).post(`${API}/projects/${id}/members`))
      .set("Idempotency-Key", key)
      .send({ email: second.email, projectRole: "VIEWER" })
      .expect(422);

    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("khong gui key thi van chay binh thuong", async () => {
    const owner = await newActor();
    const invitee = await newActor();
    const { body } = await newProject(owner).expect(201);

    await as(owner, request(app).post(`${API}/projects/${body.project.id}/members`))
      .send({ email: invitee.email, projectRole: "VIEWER" })
      .expect(201);
  });

  it("key khong phai UUID bi tu choi", async () => {
    const owner = await newActor();
    const invitee = await newActor();
    const { body } = await newProject(owner).expect(201);

    await as(owner, request(app).post(`${API}/projects/${body.project.id}/members`))
      .set("Idempotency-Key", "khong-phai-uuid")
      .send({ email: invitee.email, projectRole: "VIEWER" })
      .expect(400);
  });
});

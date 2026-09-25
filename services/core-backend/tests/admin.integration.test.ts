import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { demotesLastAdmin } from "../src/modules/admin/admin.repository.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";

/**
 * `/admin/*` qua HTTP thật. Tiêu chí của sổ nợ `portal-admin`: một người dùng thường
 * vào được là LỖ PHÂN QUYỀN — nên ô âm đi qua MỌI route, không chỉ một.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_admin_route_test",
});

const app = createApp();
let world: TestWorld;
let root: Actor;
let plain: Actor;

const ROUTES: [string, string][] = [
  ["get", "/admin/users"],
  ["get", "/admin/projects"],
  ["get", "/admin/credentials"],
  ["get", "/admin/jobs"],
  ["get", "/admin/orphan-resources"],
  ["get", "/admin/system/health"],
];

beforeAll(async () => {
  world = testWorld(app, admin);
  root = await world.newActor("admin-root");
  plain = await world.newActor("admin-plain");
  await admin.user.update({
    where: { id: root.userId },
    data: { platformRole: "PLATFORM_ADMIN" },
  });
  await world.newProject(plain);
}, 60_000);

afterAll(async () => {
  await admin.auditLog.deleteMany({
    where: {
      targetType: "User",
      targetId: { in: [root.userId, plain.userId] },
    },
  });
  await world.cleanup();
  await admin.$disconnect();
});

const call = (actor: Actor, method: string, path: string) =>
  as(
    actor,
    (request(app) as unknown as Record<string, (p: string) => request.Test>)[
      method
    ]!(`${API}${path}`),
  );

describe("phân quyền /admin", () => {
  it("chưa đăng nhập ⇒ 401 ở mọi route", async () => {
    for (const [method, path] of ROUTES) {
      const res = await (
        request(app) as unknown as Record<string, (p: string) => request.Test>
      )[method]!(`${API}${path}`);
      expect(res.status, path).toBe(401);
    }
  });

  it("USER ⇒ 403 ở MỌI route, kể cả PATCH đổi vai", async () => {
    for (const [method, path] of ROUTES) {
      const res = await call(plain, method, path);
      expect(res.status, path).toBe(403);
    }
    await as(
      plain,
      request(app)
        .patch(`${API}/admin/users/${plain.userId}/platform-role`)
        .send({ platformRole: "PLATFORM_ADMIN" }),
    ).expect(403);
  });

  it("PLATFORM_ADMIN đọc được mọi route", async () => {
    for (const [method, path] of ROUTES) {
      const res = await call(root, method, path);
      expect(res.status, path).toBe(200);
    }
  });

  it("vai đọc từ DATABASE: hạ quyền có hiệu lực ngay, không đợi token hết hạn", async () => {
    await admin.user.update({
      where: { id: root.userId },
      data: { platformRole: "USER" },
    });
    await call(root, "get", "/admin/users").expect(403);
    await admin.user.update({
      where: { id: root.userId },
      data: { platformRole: "PLATFORM_ADMIN" },
    });
  });
});

describe("dữ liệu /admin", () => {
  it("danh sách project kèm email chủ và số thành viên", async () => {
    const res = await call(root, "get", "/admin/projects?limit=100").expect(
      200,
    );
    const mine = (
      res.body.projects as { owner: { email: string }; memberCount: number }[]
    ).find((p) => p.owner.email === plain.email);
    expect(mine?.memberCount).toBe(1);
  });

  it("orphan: nói rõ chưa quét cloud (cloudScanned = false)", async () => {
    const res = await call(root, "get", "/admin/orphan-resources").expect(200);
    expect(res.body.cloudScanned).toBe(false);
    expect(res.body.pricingAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("system/health: database up, core-backend up", async () => {
    const res = await call(root, "get", "/admin/system/health").expect(200);
    expect(res.body.database).toBe("up");
    expect(res.body.services[0]).toEqual({
      name: "udp-core-backend",
      status: "up",
    });
  });
});

describe("luật admin cuối cùng (hàm thuần)", () => {
  it("chỉ chặn khi hạ một ADMIN xuống USER lúc hệ thống còn đúng một admin", () => {
    expect(demotesLastAdmin("PLATFORM_ADMIN", "USER", 1)).toBe(true);
    expect(demotesLastAdmin("PLATFORM_ADMIN", "USER", 2)).toBe(false);
    expect(demotesLastAdmin("USER", "USER", 1)).toBe(false);
    expect(demotesLastAdmin("PLATFORM_ADMIN", "PLATFORM_ADMIN", 1)).toBe(false);
    expect(demotesLastAdmin("USER", "PLATFORM_ADMIN", 0)).toBe(false);
  });
});

describe("đổi vai toàn hệ thống", () => {
  it("nâng rồi hạ một người, có audit với projectId null", async () => {
    const up = await as(
      root,
      request(app)
        .patch(`${API}/admin/users/${plain.userId}/platform-role`)
        .send({ platformRole: "PLATFORM_ADMIN" }),
    ).expect(200);
    expect(up.body.user.platformRole).toBe("PLATFORM_ADMIN");
    await as(
      root,
      request(app)
        .patch(`${API}/admin/users/${plain.userId}/platform-role`)
        .send({ platformRole: "USER" }),
    ).expect(200);
    const logs = await admin.auditLog.findMany({
      where: { action: "platform.role.update", targetId: plain.userId },
    });
    expect(logs).toHaveLength(2);
    expect(
      logs.every((l) => l.projectId === null && l.actorUserId === root.userId),
    ).toBe(true);
  });

  /**
   * Không sửa vai của ai khác: database dev dùng chung có thể có admin thật. Trên database
   * scratch của CI, root là admin DUY NHẤT nên nhánh 409 chạy; ở nơi có admin khác, hạ
   * root phải THÀNH CÔNG — cả hai nhánh đều khẳng định cùng một luật.
   */
  it("không hạ được quản trị viên CUỐI CÙNG ⇒ 409 (còn admin khác thì hạ được)", async () => {
    const others = await admin.user.count({
      where: { platformRole: "PLATFORM_ADMIN", id: { not: root.userId } },
    });
    const res = await as(
      root,
      request(app)
        .patch(`${API}/admin/users/${root.userId}/platform-role`)
        .send({ platformRole: "USER" }),
    );
    if (others === 0) {
      expect(res.status).toBe(409);
    } else {
      expect(res.status).toBe(200);
      await admin.user.update({
        where: { id: root.userId },
        data: { platformRole: "PLATFORM_ADMIN" },
      });
    }
  });

  it("người dùng không tồn tại ⇒ 404; id sai dạng ⇒ 400", async () => {
    await as(
      root,
      request(app)
        .patch(
          `${API}/admin/users/00000000-0000-4000-8000-000000000000/platform-role`,
        )
        .send({ platformRole: "USER" }),
    ).expect(404);
    await as(
      root,
      request(app)
        .patch(`${API}/admin/users/abc/platform-role`)
        .send({ platformRole: "USER" }),
    ).expect(400);
  });
});

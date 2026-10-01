import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@udp/db";
import type { Express } from "express";
import request from "supertest";

/**
 * Người dùng và project THẬT qua HTTP cho test tích hợp của Service 1 [v4.5] —
 * một bản cho mọi file test mới, thay vì mỗi file chép lại đăng ký/cookie/CSRF.
 */

export const API = "/api/v1";
export const PASSWORD = "dev-password-12345";

export interface Actor {
  email: string;
  userId: string;
  cookies: string[];
  csrfToken: string;
}

export interface ProjectEnv {
  id: string;
  name: string;
  k8sNamespace: string;
  isProduction: boolean;
}

const setCookies = (res: request.Response): string[] => {
  const raw: unknown = res.get("set-cookie");
  return Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === "string"
      ? [raw]
      : [];
};

/** Gắn phiên + CSRF của `actor` vào một request */
export const as = (actor: Actor, req: request.Test): request.Test =>
  req.set("Cookie", actor.cookies).set("X-CSRF-Token", actor.csrfToken);

export interface TestWorld {
  newActor(prefix: string): Promise<Actor>;
  /** Project mới do `owner` tạo — ba environment mặc định dev/staging/prod */
  newProject(
    owner: Actor,
  ): Promise<{ projectId: string; envs: Record<string, ProjectEnv> }>;
  addMember(
    owner: Actor,
    projectId: string,
    member: Actor,
    role: "MAINTAINER" | "DEVELOPER" | "VIEWER",
  ): Promise<void>;
  /** Xoá mọi thứ test đã tạo — bằng owner (audit giữ project, RESTRICT) */
  cleanup(): Promise<void>;
}

export function testWorld(app: Express, admin: PrismaClient): TestWorld {
  const emails: string[] = [];
  return {
    async newActor(prefix) {
      const email = `${prefix}-${randomUUID()}@udp.local`;
      const res = await request(app)
        .post(`${API}/auth/register`)
        .send({
          email,
          password: PASSWORD,
          name: "Test User",
          acceptTerms: true,
        })
        .expect(201);
      emails.push(email);
      return {
        email,
        userId: res.body.user.id as string,
        cookies: setCookies(res),
        csrfToken: res.body.csrfToken as string,
      };
    },
    async newProject(owner) {
      const res = await as(
        owner,
        request(app)
          .post(`${API}/projects`)
          .send({
            name: `p-${randomUUID().slice(0, 8)}`,
            creationMode: "CREATE_NEW",
            languageRuntime: "nodejs",
          }),
      ).expect(201);
      const envs: Record<string, ProjectEnv> = {};
      for (const e of res.body.environments as ProjectEnv[]) envs[e.name] = e;
      return { projectId: res.body.project.id as string, envs };
    },
    async addMember(owner, projectId, member, role) {
      await as(
        owner,
        request(app)
          .post(`${API}/projects/${projectId}/members`)
          .send({ email: member.email, projectRole: role }),
      ).expect(201);
    },
    async cleanup() {
      const users = await admin.user.findMany({
        where: { email: { in: emails } },
        select: { id: true },
      });
      const ids = users.map((u) => u.id);
      const projects = await admin.project.findMany({
        where: { ownerId: { in: ids } },
        select: { id: true },
      });
      const projectIds = projects.map((p) => p.id);
      await admin.auditLog.deleteMany({
        where: { projectId: { in: projectIds } },
      });
      await admin.project.deleteMany({ where: { id: { in: projectIds } } });
      // [Plan #55] Nhóm không có khoá ngoại tới người tạo — xoá người dùng để lại nhóm mồ côi; audit của nhóm là
      // audit nền tảng (`project_id` NULL) nên không đi theo project
      await admin.team.deleteMany({
        where: { members: { some: { userId: { in: ids } } } },
      });
      await admin.auditLog.deleteMany({
        where: { projectId: null, actorUserId: { in: ids } },
      });
      await admin.user.deleteMany({ where: { id: { in: ids } } });
    },
  };
}

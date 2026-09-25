import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import { startFlagService, type RunningService } from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import {
  API,
  as,
  PASSWORD,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";
import {
  inertCloudPlatform,
  noDomainAdapters,
  inertProvisioning,
} from "./helpers/inert-deps.js";

/**
 * [v4.11] Những route Portal gọi mà bộ tích hợp khác chưa từng đi qua đường 2xx.
 *
 * Golden capture (`wire-golden.test.ts`) lộ ra tám route như vậy — `GET /projects/:id`
 * và `GET /auth/me` nằm trong số đó. Tệp này đi qua chúng, và ở mỗi route khẳng định
 * điều mà P0 thêm vào: `myRole` do SERVER tính đúng theo từng đường vào.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_wire_routes_admin",
});

let s2: RunningService | undefined;
let app: ReturnType<typeof createApp>;
let world: TestWorld;
let owner: Actor;
let member: Actor;
let projectId: string;

beforeAll(async () => {
  const started = await startFlagService();
  s2 = started;
  app = createApp({
    metricsFor: () => new FakeMetricsProvider(),
    oidcIssuer: null,
    cloud: inertCloudPlatform,
    domainRegistry: noDomainAdapters,
    provisioning: inertProvisioning,
    flagService: createFlagServiceClient({
      baseUrl: started.baseUrl,
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
  });
  world = testWorld(app, admin);
  owner = await world.newActor("wire-owner");
  member = await world.newActor("wire-member");
  ({ projectId } = await world.newProject(owner));
  await world.addMember(owner, projectId, member, "DEVELOPER");
}, 120_000);

afterAll(async () => {
  await s2?.stop();
  await world.cleanup();
  await admin.$disconnect();
});

describe("auth: login và me", () => {
  it("POST /auth/login rồi GET /auth/me trả đúng người", async () => {
    const login = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: owner.email, password: PASSWORD })
      .expect(200);
    expect(login.body.user.email).toBe(owner.email);
    const me = await as(owner, request(app).get(`${API}/auth/me`)).expect(200);
    expect(me.body.user.id).toBe(owner.userId);
  });
});

describe("myRole do server tính — mỗi đường vào một nguồn", () => {
  it("GET /projects/:id: vai đọc từ middleware — chủ là OWNER, thành viên là DEVELOPER", async () => {
    const a = await as(
      owner,
      request(app).get(`${API}/projects/${projectId}`),
    ).expect(200);
    const b = await as(
      member,
      request(app).get(`${API}/projects/${projectId}`),
    ).expect(200);
    expect(a.body.project.myRole).toBe("OWNER");
    expect(b.body.project.myRole).toBe("DEVELOPER");
    expect(a.body.environments).toHaveLength(3);
  });

  it("GET /projects: vai của TỪNG hàng thuộc về người gọi", async () => {
    const res = await as(member, request(app).get(`${API}/projects`)).expect(
      200,
    );
    const row = (res.body.projects as { id: string; myRole: string }[]).find(
      (p) => p.id === projectId,
    );
    expect(row?.myRole).toBe("DEVELOPER");
  });

  it("PATCH /projects/:id/ttl trả project kèm myRole của người sửa", async () => {
    const expiresAt = new Date(
      Date.now() + 30 * 24 * 3600 * 1000,
    ).toISOString();
    const res = await as(
      owner,
      request(app)
        .patch(`${API}/projects/${projectId}/ttl`)
        .send({ expiresAt }),
    ).expect(200);
    expect(res.body.project.myRole).toBe("OWNER");
    expect(res.body.project.expiresAt).toBe(expiresAt);
  });
});

describe("thành viên", () => {
  it("GET /members và PATCH /members/:userId", async () => {
    const list = await as(
      owner,
      request(app).get(`${API}/projects/${projectId}/members`),
    ).expect(200);
    expect(list.body.members).toHaveLength(2);
    const res = await as(
      owner,
      request(app)
        .patch(`${API}/projects/${projectId}/members/${member.userId}`)
        .send({ projectRole: "MAINTAINER" }),
    ).expect(200);
    expect(res.body.member.projectRole).toBe("MAINTAINER");
    const after = await as(
      member,
      request(app).get(`${API}/projects/${projectId}`),
    ).expect(200);
    expect(after.body.project.myRole).toBe("MAINTAINER");
  });
});

describe("flag: variants và ma trận env", () => {
  it("GET /flags/:id/variants và /envs", async () => {
    const created = await as(
      owner,
      request(app)
        .post(`${API}/projects/${projectId}/flags`)
        .send({ key: `w-${randomUUID().slice(0, 8)}`, flagType: "BOOLEAN" }),
    ).expect(201);
    const flagId = created.body.flag.id as string;
    const variants = await as(
      owner,
      request(app).get(`${API}/projects/${projectId}/flags/${flagId}/variants`),
    ).expect(200);
    expect(
      (variants.body.variants as { key: string }[]).map((v) => v.key).sort(),
    ).toEqual(["off", "on"]);
    const envs = await as(
      owner,
      request(app).get(`${API}/projects/${projectId}/flags/${flagId}/envs`),
    ).expect(200);
    expect(envs.body.envs).toHaveLength(3);
  });
});

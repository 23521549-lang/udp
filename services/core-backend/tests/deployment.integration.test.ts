import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type ProjectEnv,
  type TestWorld,
} from "./helpers/api.js";

/**
 * Deployments và DORA qua HTTP thật trên Event Store thật (§9 "Deployments").
 *
 * Sự kiện được chèn bằng quyền owner của database — đúng như người vận hành chèn dữ liệu
 * đo: webhook CI/CD (§8.3), bên ghi thật của `DEPLOY_*`, chưa tồn tại. `deployment_events`
 * là append-only và `ON DELETE RESTRICT`, nên dọn dữ liệu là việc của owner ở `afterAll`.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_deployment_test_admin",
});

const app = createApp();
let world: TestWorld;
let owner: Actor;
let outsider: Actor;
let projectId: string;
let envs: Record<string, ProjectEnv>;

const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR);

const envNamed = (name: string): ProjectEnv => {
  const e = envs[name];
  if (e === undefined) throw new Error(`thiếu env ${name}`);
  return e;
};

beforeAll(async () => {
  world = testWorld(app, admin);
  owner = await world.newActor("deploy-owner");
  outsider = await world.newActor("deploy-outsider");
  ({ projectId, envs } = await world.newProject(owner));
  const prod = envNamed("prod").id;
  const dev = envNamed("dev").id;
  const d1 = randomUUID();
  const d2 = randomUUID();
  const d3 = randomUUID();
  const base = { projectId, triggeredBy: "WEBHOOK" as const };
  await admin.deploymentEvent.createMany({
    data: [
      {
        ...base,
        environmentId: prod,
        deploymentId: d1,
        eventType: "DEPLOY_START",
        occurredAt: ago(50),
        imageTag: "v1",
      },
      {
        ...base,
        environmentId: prod,
        deploymentId: d1,
        eventType: "DEPLOY_SUCCESS",
        occurredAt: ago(49),
        commitTimestamp: ago(51),
      },
      {
        ...base,
        environmentId: prod,
        deploymentId: d2,
        eventType: "DEPLOY_SUCCESS",
        occurredAt: ago(10),
        commitTimestamp: ago(13),
        commitSha: "abcdef1234567",
      },
      {
        ...base,
        environmentId: prod,
        deploymentId: randomUUID(),
        eventType: "ROLLBACK",
        occurredAt: ago(9),
        restoresDeploymentId: d2,
        triggeredBy: "AUTO",
        rolloutSessionId: randomUUID(),
      },
      {
        ...base,
        environmentId: dev,
        deploymentId: d3,
        eventType: "DEPLOY_SUCCESS",
        occurredAt: ago(1),
      },
    ],
  });
}, 60_000);

afterAll(async () => {
  await admin.deploymentEvent.deleteMany({ where: { projectId } });
  await world.cleanup();
  await admin.$disconnect();
});

describe("GET /deployments", () => {
  it("gom sự kiện theo deploymentId, chỉ của env được hỏi, mới nhất trước", async () => {
    const res = await as(
      owner,
      request(app)
        .get(`${API}/projects/${projectId}/deployments`)
        .query({ envId: envNamed("prod").id }),
    ).expect(200);
    const list = res.body.deployments as {
      status: string;
      imageTag: string | null;
      events: unknown[];
    }[];
    expect(list).toHaveLength(3);
    expect(list.map((d) => d.status)).toEqual([
      "ROLLBACK",
      "DEPLOY_SUCCESS",
      "DEPLOY_SUCCESS",
    ]);
    expect(list[2]?.events).toHaveLength(2);
    expect(list[2]?.imageTag).toBe("v1");
  });

  it("env của project khác ⇒ 404; người ngoài ⇒ 404", async () => {
    const other = await world.newProject(owner);
    const otherProd = other.envs.prod?.id;
    await as(
      owner,
      request(app)
        .get(`${API}/projects/${projectId}/deployments`)
        .query({ envId: otherProd }),
    ).expect(404);
    await as(
      outsider,
      request(app)
        .get(`${API}/projects/${projectId}/deployments`)
        .query({ envId: envNamed("prod").id }),
    ).expect(404);
  });

  it("thiếu envId ⇒ 400", async () => {
    await as(
      owner,
      request(app).get(`${API}/projects/${projectId}/deployments`),
    ).expect(400);
  });
});

describe("GET /metrics/dora", () => {
  it("mặc định tính trên production; bốn chỉ số theo §2.2", async () => {
    const res = await as(
      owner,
      request(app)
        .get(`${API}/projects/${projectId}/metrics/dora`)
        .query({ days: 7 }),
    ).expect(200);
    const dora = res.body.dora;
    expect(dora.environmentId).toBe(envNamed("prod").id);
    expect(dora.deployments).toBe(2);
    expect(dora.leadTimeSeconds).toEqual({ median: 2.5 * 3600, samples: 2 });
    expect(dora.changeFailureRate).toEqual({ value: 0.5, failed: 1, total: 2 });
    expect(dora.recoveryTimeSeconds.samples).toBe(1);
    expect(dora.recoveryTimeSeconds.median).toBeCloseTo(3600, -1);
    expect(dora.rollbacks).toEqual({ auto: 1, manual: 0 });
  });

  it("đổi khoảng thì số đổi: 1 ngày không thấy deploy 49 giờ trước", async () => {
    const res = await as(
      owner,
      request(app)
        .get(`${API}/projects/${projectId}/metrics/dora`)
        .query({ days: 1 }),
    ).expect(200);
    expect(res.body.dora.deployments).toBe(1);
  });

  it("env dev được hỏi rõ ⇒ tính trên dev", async () => {
    const res = await as(
      owner,
      request(app)
        .get(`${API}/projects/${projectId}/metrics/dora`)
        .query({ envId: envNamed("dev").id, days: 7 }),
    ).expect(200);
    expect(res.body.dora.deployments).toBe(1);
    expect(res.body.dora.changeFailureRate.failed).toBe(0);
  });

  it("days vượt 365 ⇒ 400", async () => {
    await as(
      owner,
      request(app)
        .get(`${API}/projects/${projectId}/metrics/dora`)
        .query({ days: 366 }),
    ).expect(400);
  });
});

import { env, k8sNamespaceFor } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { ServiceUnavailableError } from "@udp/http";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import { ENVIRONMENT_ERROR_SLUGS } from "@udp/shared-types/environment-api";
import { startFlagService, type RunningService } from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  createFlagServiceClient,
  type FlagServiceClient,
} from "../src/core/clients/flag-service.client.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";
import {
  noRepoSource,
  inertCloudPlatform,
  inertProvisioning,
  noDomainAdapters,
  outsidePlatform,
} from "./helpers/inert-deps.js";

/**
 * Plan #40 AC-1..4 — vòng đời environment trên project CHƯA có cluster, với Service 2 THẬT: tạo
 * (backfill `FlagEnvConfig` cho flag đã có), luật tên và trần, sửa hai cờ, xoá cứng có điều kiện,
 * và bù trừ khi Service 2 hỏng. Project đang chạy (job `ENVIRONMENT_APPLY`): `provision-job`.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_environment_test_admin",
});

let s2: RunningService | undefined;
let world: TestWorld;
let owner: Actor;
let developer: Actor;

const appWith = (flagService: FlagServiceClient) =>
  createApp({
    metricsFor: () => new FakeMetricsProvider(),
    oidcIssuer: null,
    cloud: inertCloudPlatform,
    repoSource: noRepoSource,
    platform: outsidePlatform,
    domainRegistry: noDomainAdapters,
    provisioning: inertProvisioning,
    flagService,
  });
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  s2 = await startFlagService();
  app = appWith(
    createFlagServiceClient({
      baseUrl: s2.baseUrl,
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
  );
  world = testWorld(app, admin);
  owner = await world.newActor("env-owner");
  developer = await world.newActor("env-dev");
}, 120_000);

afterAll(async () => {
  await s2?.stop();
  await world.cleanup();
  await admin.$disconnect();
});

const url = (projectId: string, suffix = "") =>
  `${API}/projects/${projectId}/environments${suffix}`;

const createEnv = (projectId: string, body: object, actor = owner) =>
  as(actor, request(app).post(url(projectId)).send(body));

const deleteEnv = (projectId: string, environmentId: string) =>
  as(owner, request(app).delete(url(projectId, `/${environmentId}`)));

async function projectWithFlag() {
  const { projectId, envs } = await world.newProject(owner);
  const flag = await as(
    owner,
    request(app)
      .post(`${API}/projects/${projectId}/flags`)
      .send({ key: `checkout-${projectId.slice(0, 6)}`, flagType: "BOOLEAN" }),
  ).expect(201);
  return { projectId, envs, flagId: flag.body.flag.id as string };
}

describe("tạo environment (AC-1, AC-3)", () => {
  it("project nháp: environment mới nhận FlagEnvConfig TẮT cho flag đã có, dùng được ngay; job = null", async () => {
    const { projectId, flagId } = await projectWithFlag();

    const res = await createEnv(projectId, { name: "qa" }).expect(201);
    const qa = res.body.environment as { id: string };
    expect(res.body).toEqual({
      environment: {
        id: qa.id,
        name: "qa",
        rank: 3,
        isProduction: false,
        autoDeploy: true,
        k8sNamespace: k8sNamespaceFor(
          (await admin.project.findUniqueOrThrow({ where: { id: projectId } }))
            .name,
          projectId,
          "qa",
        ),
      },
      job: null,
    });
    const config = await admin.flagEnvConfig.findFirstOrThrow({
      where: { flagId, environmentId: qa.id },
      select: { isEnabled: true },
    });
    expect(config.isEnabled).toBe(false);

    // Dùng được như environment mặc định: danh sách, SDK key
    const listed = await as(owner, request(app).get(url(projectId))).expect(
      200,
    );
    expect(
      (listed.body.environments as { name: string }[]).map((e) => e.name),
    ).toEqual(["dev", "staging", "prod", "qa"]);
    await as(
      owner,
      request(app)
        .post(url(projectId, `/${qa.id}/keys`))
        .send({ keyType: "SERVER" }),
    ).expect(201);

    // Audit của vòng đời KHÔNG mang environment_id — thứ khiến environment "có lịch sử"
    const audit = await admin.auditLog.findFirstOrThrow({
      where: { projectId, action: "environment.create" },
      select: { targetId: true, environmentId: true },
    });
    expect(audit).toEqual({ targetId: qa.id, environmentId: null });
  });

  it("production mà không nói autoDeploy ⇒ autoDeploy tắt (§8.3)", async () => {
    const { projectId } = await world.newProject(owner);
    const res = await createEnv(projectId, {
      name: "prod-eu",
      isProduction: true,
    }).expect(201);
    expect(res.body.environment).toMatchObject({
      isProduction: true,
      autoDeploy: false,
    });
  });

  it("tên sai dạng ⇒ 400; trùng ⇒ 409; quá trần ⇒ 409 environment-limit; DEVELOPER ⇒ 403", async () => {
    const { projectId } = await world.newProject(owner);
    for (const name of ["QA", "2qa", "qa-", "abcdefghijklm", "q_a"]) {
      await createEnv(projectId, { name }).expect(400);
    }
    await createEnv(projectId, { name: "dev" }).expect(409);
    await world.addMember(owner, projectId, developer, "DEVELOPER");
    await createEnv(projectId, { name: "qa" }, developer).expect(403);

    for (const name of ["e4", "e5", "e6", "e7", "e8"]) {
      await createEnv(projectId, { name }).expect(201);
    }
    const over = await createEnv(projectId, { name: "e9" }).expect(409);
    expect(over.body.type).toContain(ENVIRONMENT_ERROR_SLUGS.limit);
  });

  it("Service 2 hỏng khi backfill ⇒ 503 và KHÔNG còn hàng environment, không audit (AC-2)", async () => {
    const failing = appWith({
      ...createFlagServiceClient({
        baseUrl: s2?.baseUrl ?? "",
        secret: env.INTERNAL_SERVICE_SECRET,
      }),
      backfillEnvironment: () =>
        Promise.reject(new ServiceUnavailableError("Service 2 không phản hồi")),
    });
    const { projectId } = await world.newProject(owner);

    await as(
      owner,
      request(failing).post(url(projectId)).send({ name: "qa" }),
    ).expect(503);

    expect(
      await admin.environment.count({ where: { projectId, name: "qa" } }),
    ).toBe(0);
    expect(
      await admin.auditLog.count({
        where: { projectId, action: "environment.create" },
      }),
    ).toBe(0);
  });
});

describe("sửa environment (AC-3)", () => {
  it("bật production ⇒ autoDeploy tắt; tên không đổi được; thân rỗng ⇒ 400", async () => {
    const { projectId, envs } = await world.newProject(owner);
    const staging = envs.staging as { id: string };
    const patch = (body: object) =>
      as(
        owner,
        request(app)
          .patch(url(projectId, `/${staging.id}`))
          .send(body),
      );

    const res = await patch({ isProduction: true }).expect(200);
    expect(res.body.environment).toMatchObject({
      name: "staging",
      isProduction: true,
      autoDeploy: false,
    });
    await patch({ autoDeploy: true }).expect(200);
    await patch({ name: "stg" }).expect(400);
    await patch({}).expect(400);
  });
});

describe("xoá environment (AC-4)", () => {
  it("environment sạch ⇒ xoá được, FlagEnvConfig của nó đi theo; environment cuối ⇒ 409", async () => {
    const { projectId, envs, flagId } = await projectWithFlag();
    const dev = envs.dev as { id: string };

    const res = await deleteEnv(projectId, dev.id).expect(200);
    expect(res.body).toEqual({ job: null });
    expect(await admin.environment.count({ where: { id: dev.id } })).toBe(0);
    expect(
      await admin.flagEnvConfig.count({
        where: { flagId, environmentId: dev.id },
      }),
    ).toBe(0);

    await deleteEnv(projectId, (envs.staging as { id: string }).id).expect(200);
    const last = await deleteEnv(
      projectId,
      (envs.prod as { id: string }).id,
    ).expect(409);
    expect(last.body.type).toContain(ENVIRONMENT_ERROR_SLUGS.last);
  });

  it("còn rollout sống ⇒ 409 environment-rollout-active", async () => {
    const { projectId, envs } = await world.newProject(owner);
    const dev = envs.dev as { id: string };
    await admin.rolloutSession.create({
      data: {
        projectId,
        environmentId: dev.id,
        rolloutScope: "SERVICE_LEVEL",
        strategy: "CANARY",
        controlMode: "UDP_DRIVEN",
        status: "IN_PROGRESS",
        workloadName: "checkout",
        versionOld: "v1",
        versionNew: "v2",
        thresholds: {},
        stepPercent: 10,
        createdById: owner.userId,
      },
    });
    const res = await deleteEnv(projectId, dev.id).expect(409);
    expect(res.body.type).toContain(ENVIRONMENT_ERROR_SLUGS.rolloutActive);
  });

  it("còn flag đang bật ⇒ 409 environment-flags-enabled", async () => {
    const { projectId, envs, flagId } = await projectWithFlag();
    const dev = envs.dev as { id: string };
    await as(
      owner,
      request(app)
        .patch(`${API}/projects/${projectId}/flags/${flagId}/envs/${dev.id}`)
        .send({ isEnabled: true }),
    ).expect(200);
    const res = await deleteEnv(projectId, dev.id).expect(409);
    expect(res.body.type).toContain(ENVIRONMENT_ERROR_SLUGS.flagsEnabled);
  });

  it("đã có lịch sử (SDK key từng phát) ⇒ 409 environment-has-history, không xoá gì", async () => {
    const { projectId, envs } = await world.newProject(owner);
    const dev = envs.dev as { id: string };
    await as(
      owner,
      request(app)
        .post(url(projectId, `/${dev.id}/keys`))
        .send({ keyType: "CLIENT" }),
    ).expect(201);
    const res = await deleteEnv(projectId, dev.id).expect(409);
    expect(res.body.type).toContain(ENVIRONMENT_ERROR_SLUGS.hasHistory);
    expect(await admin.environment.count({ where: { id: dev.id } })).toBe(1);
  });
});

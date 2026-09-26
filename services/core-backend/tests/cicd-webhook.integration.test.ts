import { createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { createRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type ProjectEnv,
  type TestWorld,
} from "./helpers/api.js";
import { inertCloudPlatform } from "./helpers/inert-deps.js";

/**
 * Plan #36 AC-3, AC-5 qua HTTP thật, adapter GitHub Actions THẬT của registry sản phẩm, database
 * thật: secret webhook (sinh, niêm phong, hiện một lần, xoay có audit), webhook (401 đồng nhất,
 * 413, 400, 422, chống trùng, chờ duyệt) và duyệt deploy chờ. Job deploy — hàng đợi giả ghi lại
 * `deploymentId`; phần cluster ở `deploy-job.integration.test.ts`.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_cicd_webhook_admin",
});

const enqueued: string[] = [];
const app = createApp({
  metricsFor: () => new FakeMetricsProvider(),
  flagService: createFlagServiceClient({
    baseUrl: "http://127.0.0.1:9",
    secret: env.INTERNAL_SERVICE_SECRET,
  }),
  oidcIssuer: null,
  cloud: inertCloudPlatform,
  domainRegistry: (() => {
    const loaded = createRegistry({
      root: resolve(import.meta.dirname, "../src/modules"),
    });
    return () => loaded;
  })(),
  provisioning: {
    egressCidrs: [],
    enqueue: null,
    enqueueDeploy: (deploymentId) => {
      enqueued.push(deploymentId);
      return Promise.resolve();
    },
    withCluster: null,
    scanDrift: null,
  },
});

let world: TestWorld;
let owner: Actor;
let maintainer: Actor;
let developer: Actor;
let viewer: Actor;
let projectId: string;
let envs: Record<string, ProjectEnv>;
let secret: string;

const cicdUrl = (path: string) =>
  `${API}/projects/${projectId}/domains/CICD${path}`;
const hookUrl = (project = projectId, provider = "github-actions") =>
  `${API}/webhooks/cicd/${project}/${provider}`;

const body = (over: Record<string, unknown> = {}) => ({
  environment: "dev",
  status: "success",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  commitTimestamp: "2026-09-26T08:00:00+07:00",
  imageRef: "ghcr.io/acme/web:0123456",
  workloadName: "web",
  pipelineId: `run-${String(Math.random()).slice(2, 10)}`,
  repo: "acme/web",
  ref: "refs/heads/dev",
  actor: "dev",
  ...over,
});

/** Gửi như bước "báo UDP" của template: ký ĐÚNG chuỗi byte gửi đi */
function hook(
  payload: unknown,
  opts: { key?: string; url?: string; raw?: string } = {},
) {
  const raw = opts.raw ?? JSON.stringify(payload);
  const sig = createHmac("sha256", opts.key ?? secret)
    .update(raw)
    .digest("hex");
  return request(app)
    .post(opts.url ?? hookUrl())
    .set("content-type", "application/json")
    .set("x-hub-signature-256", `sha256=${sig}`)
    .send(raw);
}

const eventsOf = (deploymentId: string) =>
  admin.deploymentEvent.findMany({
    where: { deploymentId },
    orderBy: { occurredAt: "asc" },
  });

beforeAll(async () => {
  world = testWorld(app, admin);
  owner = await world.newActor("cicd-owner");
  maintainer = await world.newActor("cicd-maintainer");
  developer = await world.newActor("cicd-developer");
  viewer = await world.newActor("cicd-viewer");
  ({ projectId, envs } = await world.newProject(owner));
  await world.addMember(owner, projectId, maintainer, "MAINTAINER");
  await world.addMember(owner, projectId, developer, "DEVELOPER");
  await world.addMember(owner, projectId, viewer, "VIEWER");
  await admin.domainConfig.create({
    data: {
      projectId,
      domainType: "CICD",
      isEnabled: true,
      selectedTool: "github-actions",
      toolConfig: { repository: "acme/web" },
    },
  });
}, 120_000);

afterAll(async () => {
  await admin.deploymentEvent.deleteMany({ where: { projectId } });
  await world.cleanup();
  await admin.$disconnect();
});

describe("secret webhook (AC-5)", () => {
  it("chưa sinh ⇒ trạng thái nói vậy, và mọi webhook là 401", async () => {
    const res = await as(viewer, request(app).get(cicdUrl("/webhook"))).expect(
      200,
    );
    expect(res.body.cicd).toEqual({
      provider: "github-actions",
      webhookPath: `/api/v1/webhooks/cicd/${projectId}/github-actions`,
      secretSet: false,
    });
    await hook(body(), { key: "bat-ky" }).expect(401);
  });

  it("DEVELOPER không sinh được; MAINTAINER sinh ⇒ giá trị CHỈ ở response này, cột niêm phong", async () => {
    await as(developer, request(app).post(cicdUrl("/webhook-secret"))).expect(
      403,
    );
    const res = await as(
      maintainer,
      request(app).post(cicdUrl("/webhook-secret")),
    ).expect(200);
    secret = res.body.secret as string;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    const row = await admin.domainConfig.findFirstOrThrow({
      where: { projectId, domainType: "CICD" },
      select: { webhookSecret: true },
    });
    expect(JSON.stringify(row.webhookSecret)).not.toContain(secret);

    const status = await as(viewer, request(app).get(cicdUrl("/webhook")));
    expect(status.body.cicd.secretSet).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain(secret);

    const audit = await admin.auditLog.findMany({
      where: { projectId, action: { startsWith: "cicd.webhook_secret" } },
    });
    expect(audit.map((a) => a.action)).toEqual(["cicd.webhook_secret.create"]);
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("xoay ⇒ secret cũ chết ngay, audit ghi rotate", async () => {
    const old = secret;
    const res = await as(
      maintainer,
      request(app).post(cicdUrl("/webhook-secret")),
    ).expect(200);
    secret = res.body.secret as string;
    expect(secret).not.toBe(old);
    await hook(body(), { key: old }).expect(401);
    const actions = await admin.auditLog.findMany({
      where: { projectId, action: "cicd.webhook_secret.rotate" },
    });
    expect(actions).toHaveLength(1);
  });
});

describe("webhook (AC-3)", () => {
  it("chữ ký sai, project lạ, provider khác ⇒ CÙNG một 401; chữ ký sai ghi audit", async () => {
    const wrong = await hook(body(), { key: "khac" }).expect(401);
    const unknown = await hook(body(), {
      url: hookUrl("00000000-0000-4000-8000-00000000abcd"),
    }).expect(401);
    const otherTool = await hook(body(), {
      url: hookUrl(projectId, "gitlab-ci"),
    }).expect(401);
    for (const res of [unknown, otherTool]) {
      expect(res.body.detail).toBe(wrong.body.detail);
      expect(res.body.title).toBe(wrong.body.title);
    }
    const rejected = await admin.auditLog.count({
      where: { projectId, action: "cicd.webhook.rejected" },
    });
    expect(rejected).toBeGreaterThanOrEqual(1);
  });

  it("thân > 1 MiB ⇒ 413, không 500", async () => {
    const res = await hook(null, { raw: "x".repeat(1_048_577) });
    expect(res.status).toBe(413);
  });

  it("chữ ký đúng nhưng thân sai hình ⇒ 400; environment lạ ⇒ 422", async () => {
    await hook(null, { raw: '{"environment":"dev"}' }).expect(400);
    await hook(body({ environment: "khong-co" })).expect(422);
  });

  it("thành công ở env tự deploy ⇒ 202 started, DEPLOY_START + job; gửi lại ⇒ 200 duplicate, không sự kiện mới", async () => {
    const payload = body();
    const first = await hook(payload).expect(202);
    expect(first.body.status).toBe("started");
    const id = first.body.deploymentId as string;
    expect(enqueued).toContain(id);

    const events = await eventsOf(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "DEPLOY_START",
      environmentId: envs.dev?.id,
      pipelineId: payload.pipelineId,
      imageTag: "0123456",
      workloadName: "web",
      triggeredBy: "WEBHOOK",
      metadata: { imageRef: payload.imageRef, provider: "github-actions" },
    });

    const again = await hook(payload).expect(200);
    expect(again.body).toEqual({ deploymentId: id, status: "duplicate" });
    expect(await eventsOf(id)).toHaveLength(1);
  });

  /**
   * Hai lần gửi lại đến cùng lúc: lần sau phải CHỜ lần trước commit rồi mới tra trùng. Phép này
   * tất định — giữ đúng khoá `(environment, pipelineId)` ở một transaction khác, gửi webhook, chèn
   * START của "lần trước" giữa chừng rồi mới commit. Không có khoá, webhook tra trùng lúc START
   * chưa commit và tạo lần deploy thứ hai.
   */
  it("khoá (environment, pipelineId): lần gửi đến giữa lúc lần kia chưa commit ⇒ chờ, rồi thấy trùng", async () => {
    const payload = body();
    const key = `${envs.dev!.id}:${payload.pipelineId}`;
    const earlier = randomUUID();
    let pending: Promise<request.Response> | undefined;
    await admin.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        pending = hook(payload).then((r) => r);
        await new Promise((r) => setTimeout(r, 1_500));
        await tx.deploymentEvent.create({
          data: {
            projectId,
            environmentId: envs.dev!.id,
            deploymentId: earlier,
            eventType: "DEPLOY_START",
            workloadName: "web",
            pipelineId: payload.pipelineId,
            triggeredBy: "WEBHOOK",
            metadata: { imageRef: payload.imageRef },
          },
        });
      },
      { timeout: 20_000 },
    );
    const res = await pending!;
    expect(res.body).toEqual({ deploymentId: earlier, status: "duplicate" });
  });

  it("pipeline hỏng ⇒ 200 failure-recorded, DEPLOY_FAILURE, không job", async () => {
    const before = enqueued.length;
    const res = await hook(
      body({ status: "failure", imageRef: undefined }),
    ).expect(200);
    expect(res.body.status).toBe("failure-recorded");
    expect(
      (await eventsOf(res.body.deploymentId as string)).map((e) => e.eventType),
    ).toEqual(["DEPLOY_FAILURE"]);
    expect(enqueued).toHaveLength(before);
  });
});

describe("deploy chờ duyệt (AC-4, §2.2 auto_deploy)", () => {
  let pending: string;

  it("env không tự deploy ⇒ 202 pending, DEPLOY_PENDING, không job", async () => {
    await admin.environment.update({
      where: { id: envs.prod!.id },
      data: { autoDeploy: false },
    });
    const before = enqueued.length;
    const res = await hook(body({ environment: "prod" })).expect(202);
    expect(res.body.status).toBe("pending");
    pending = res.body.deploymentId as string;
    expect(enqueued).toHaveLength(before);
    expect((await eventsOf(pending)).map((e) => e.eventType)).toEqual([
      "DEPLOY_PENDING",
    ]);
  });

  it("DEVELOPER không duyệt được; MAINTAINER duyệt ⇒ START thủ công + job + audit", async () => {
    const url = `${API}/projects/${projectId}/deployments/${pending}/approve`;
    await as(developer, request(app).post(url)).expect(403);
    const res = await as(maintainer, request(app).post(url)).expect(202);
    expect(res.body).toEqual({ deploymentId: pending, status: "started" });
    expect(enqueued).toContain(pending);

    const events = await eventsOf(pending);
    expect(events.map((e) => [e.eventType, e.triggeredBy])).toEqual([
      ["DEPLOY_PENDING", "WEBHOOK"],
      ["DEPLOY_START", "MANUAL"],
    ]);
    expect(events[1]?.metadata).toMatchObject({
      imageRef: "ghcr.io/acme/web:0123456",
    });
    expect(
      await admin.auditLog.count({
        where: { projectId, action: "deployment.approve", targetId: pending },
      }),
    ).toBe(1);

    const twice = await as(maintainer, request(app).post(url)).expect(200);
    expect(twice.body.status).toBe("duplicate");
  });

  it("id lạ ⇒ 404; id sai hình ⇒ 400", async () => {
    await as(
      maintainer,
      request(app).post(
        `${API}/projects/${projectId}/deployments/00000000-0000-4000-8000-000000000000/approve`,
      ),
    ).expect(404);
    await as(
      maintainer,
      request(app).post(
        `${API}/projects/${projectId}/deployments/khong-phai-uuid/approve`,
      ),
    ).expect(400);
  });
});

describe("template pipeline", () => {
  it("chưa có registry.oci ⇒ 409; có ⇒ template của tool đang bật, đúng registry, VIEWER không xem", async () => {
    await as(developer, request(app).get(cicdUrl("/pipeline-template"))).expect(
      409,
    );

    const registry = await admin.domainConfig.create({
      data: {
        projectId,
        domainType: "CONTAINER_REGISTRY",
        isEnabled: true,
        selectedTool: "ghcr",
        toolConfig: { owner: "acme" },
      },
    });
    await admin.capabilityBinding.create({
      data: {
        domainConfigId: registry.id,
        capabilityId: "registry.oci",
        providedBy: "container_registry:ghcr",
        schemaVersion: "1.0.0",
        endpoint: "ghcr.io/acme",
      },
    });

    await as(viewer, request(app).get(cicdUrl("/pipeline-template"))).expect(
      403,
    );
    const res = await as(
      developer,
      request(app).get(cicdUrl("/pipeline-template")),
    ).expect(200);
    expect(res.body.provider).toBe("github-actions");
    const content = res.body.content as string;
    expect(content).toContain("ghcr.io/acme/");
    expect(content).toContain("X-Hub-Signature-256");
    expect(content).toContain("udp-driven");
  });
});

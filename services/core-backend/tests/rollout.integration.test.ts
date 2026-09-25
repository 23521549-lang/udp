import { randomUUID } from "node:crypto";
import { env, ROLLOUT_TIMING } from "@udp/config";
import { createPrismaClient, createSessionConnector } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import {
  parseRolloutIntentNotice,
  ROLLOUT_INTENT_CHANNEL,
} from "@udp/shared-types";
import {
  freePort,
  newFlagTarget,
  startFlagService,
  type FlagTarget,
  type RunningService,
} from "@udp/test-support";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type ProjectEnv,
  type TestWorld,
} from "./helpers/api.js";

/**
 * Luồng 5 ở Service 1 qua HTTP thật (§8.5, §9 "Progressive Delivery") [v4.4].
 *
 * Service 2 là tiến trình THẬT (`track` kiểm được hợp đồng và GRANT cột thứ sáu
 * của S2); nguồn metrics là bản giả (probe pha 1 theo workload). Dữ liệu flag dựng
 * bằng owner — S1 chỉ có SELECT trên bảng flag (§1.2).
 */

const WORKLOAD = "checkout";

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_rollout_test_admin",
});

let s2: RunningService | undefined;
/** beforeAll đã dựng xong — dọn dẹp chỉ chạy khi có gì để dọn */
let ready = false;
let fake: FakeMetricsProvider;
let app: ReturnType<typeof createApp>;
let world: TestWorld;

let owner: Actor;
let developer: Actor;
let projectId: string;
let dev: ProjectEnv;
let staging: ProjectEnv;

const rolloutsUrl = () => `${API}/projects/${projectId}/rollouts`;

const bodyFor = (
  environment: ProjectEnv,
  target: FlagTarget,
  extra: Record<string, unknown> = {},
) => ({
  scope: "FLAG_LEVEL",
  envId: environment.id,
  flagEnvConfigId: target.envConfigId,
  targetingRuleId: target.ruleId,
  targetVariantId: target.on,
  workloadName: WORKLOAD,
  stepPercent: 10,
  ...extra,
});

const create = (
  body: Record<string, unknown>,
  actor: Actor = owner,
  target = app,
) => as(actor, request(target).post(rolloutsUrl()).send(body));

const trackedOf = async (target: FlagTarget): Promise<boolean> =>
  (
    await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: target.envConfigId },
      select: { isTracked: true },
    })
  ).isTracked;

const sessionsOn = (target: FlagTarget) =>
  admin.rolloutSession.count({
    where: { flagEnvConfigId: target.envConfigId },
  });

/**
 * Sau mỗi ca: đóng mọi rollout đang sống của project và gỡ nhãn mọi flag — trả
 * chỗ trong trần 3 flag/environment và chỗ của target cho ca sau. Làm bằng owner,
 * không qua S2/S3: đây là dọn dữ liệu test, không phải hành vi đang kiểm.
 */
afterEach(async () => {
  if (!ready) return; // beforeAll hỏng: không che lỗi gốc bằng lỗi dọn dẹp
  await admin.$executeRaw`UPDATE rollout_sessions SET status = 'DONE' WHERE project_id = ${projectId}::uuid AND status IN ('PENDING','IN_PROGRESS','PAUSED')`;
  await admin.$executeRaw`UPDATE flag_env_configs SET is_tracked = false WHERE environment_id IN (SELECT id FROM environments WHERE project_id = ${projectId}::uuid)`;
});

/** Nguồn metrics giả MỚI mỗi ca — `setWorkload` của ca trước không rò sang ca sau */
beforeEach(() => {
  fake = new FakeMetricsProvider();
  fake.setWorkload(dev.k8sNamespace, WORKLOAD);
  fake.setWorkload(staging.k8sNamespace, WORKLOAD);
});

beforeAll(async () => {
  const started = await startFlagService();
  s2 = started;
  app = createApp({
    metricsFor: () => fake,
    oidcIssuer: null,
    flagService: createFlagServiceClient({
      baseUrl: started.baseUrl,
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
  });
  world = testWorld(app, admin);
  owner = await world.newActor("rollout");
  developer = await world.newActor("rollout");
  const project = await world.newProject(owner);
  projectId = project.projectId;
  const byName = (name: string): ProjectEnv => {
    const found = project.envs[name];
    if (found === undefined) throw new Error(`thiếu env ${name}`);
    return found;
  };
  dev = byName("dev");
  staging = byName("staging");
  await world.addMember(owner, projectId, developer, "DEVELOPER");
  ready = true;
}, 90_000);

afterAll(async () => {
  await s2?.stop();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  await world?.cleanup();
  await admin.$disconnect();
});

describe("tạo rollout FLAG_LEVEL (§8.5)", () => {
  it("201: PENDING, baseline = trọng số hiện tại, traffic khởi tạo = baseline, flag được gắn nhãn qua S2 thật, có lease khai sinh và audit", async () => {
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      30,
    );
    const res = await create(bodyFor(dev, target)).expect(201);

    const rollout = res.body.rollout;
    expect(rollout).toMatchObject({
      status: "PENDING",
      scope: "FLAG_LEVEL",
      controlMode: "udp-driven",
      baselinePercentage: 30,
      currentTrafficPercentage: 30,
      metricWindowSeconds: ROLLOUT_TIMING.metricWindowSeconds,
      environment: { id: dev.id, name: "dev", isProduction: false },
      flag: {
        key: target.flagKey,
        targetVariant: "on",
        targetingRuleId: target.ruleId,
      },
    });
    expect(await trackedOf(target)).toBe(true);
    const row = await admin.rolloutSession.findUniqueOrThrow({
      where: { id: rollout.id },
      select: { claimedBy: true, claimedUntil: true, version: true },
    });
    expect(row.claimedBy).toMatch(/^s1-create:/);
    expect(row.claimedUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(row.version).toBe(0);
    expect(
      await admin.auditLog.count({
        where: { projectId, action: "rollout.create", targetId: rollout.id },
      }),
    ).toBe(1);
  });

  it("flag đã có rollout sống ⇒ 409 ROLLOUT_IN_PROGRESS kèm resourceId — kể cả khác workload", async () => {
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      10,
    );
    const first = await create(bodyFor(dev, target)).expect(201);
    fake.setWorkload(dev.k8sNamespace, "payments");
    const res = await create(
      bodyFor(dev, target, { workloadName: "payments" }),
    ).expect(409);
    expect(res.body).toMatchObject({
      code: "ROLLOUT_IN_PROGRESS",
      resourceId: first.body.rollout.id,
    });
  });

  it("probe pha 1: workload chưa xuất metric ⇒ 422 METRICS_NOT_AVAILABLE, không để lại gì", async () => {
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      0,
    );
    const res = await create(
      bodyFor(dev, target, { workloadName: "no-metrics" }),
    ).expect(422);
    expect(res.body.code).toBe("METRICS_NOT_AVAILABLE");
    expect(await sessionsOn(target)).toBe(0);
    expect(await trackedOf(target)).toBe(false);
  });

  it("cửa sổ metric < 4 × scrape ⇒ 422 nói số tối thiểu; nguồn metrics chết ⇒ 503 PROVIDER_UNAVAILABLE", async () => {
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      0,
    );
    const small = await create(
      bodyFor(dev, target, { metricWindowSeconds: 30 }),
    ).expect(422);
    expect(small.body.detail).toMatch(/≥ 60/);

    fake.setReachable(false);
    try {
      const down = await create(bodyFor(dev, target)).expect(503);
      expect(down.body.code).toBe("PROVIDER_UNAVAILABLE");
    } finally {
      fake.setReachable(true);
    }
    expect(await sessionsOn(target)).toBe(0);
  });

  it("422 cho mọi thứ S3 không chạy được: SERVICE_LEVEL, chiến lược khác CANARY, flag tắt, variant đã 100%", async () => {
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      0,
    );
    await create({ scope: "SERVICE_LEVEL", envId: dev.id }).expect(422);
    await create(bodyFor(dev, target, { strategy: "BLUE_GREEN" })).expect(422);

    const off = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      0,
      { isEnabled: false },
    );
    const disabled = await create(bodyFor(dev, off)).expect(422);
    expect(disabled.body.detail).toMatch(/TẮT/);

    const full = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      100,
    );
    const done = await create(bodyFor(dev, full)).expect(422);
    expect(done.body.detail).toMatch(/100%/);
  });

  it("flag DRAFT hay ARCHIVED ⇒ 422 ngay, không probe, không session — cùng luật với chốt `track` của S2 [v4.5]", async () => {
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      10,
    );
    const { flagId } = await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: target.envConfigId },
      select: { flagId: true },
    });
    for (const status of ["DRAFT", "ARCHIVED"] as const) {
      await admin.featureFlag.update({
        where: { id: flagId },
        data: { lifecycleStatus: status },
      });
      const res = await create(bodyFor(dev, target)).expect(422);
      expect(res.body.detail).toMatch(new RegExp(status));
    }
    expect(await sessionsOn(target)).toBe(0);
  });

  it("rule của environment khác ⇒ 404; stepPercent 3 chữ số thập phân ⇒ 400", async () => {
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      0,
    );
    await create(bodyFor(staging, target)).expect(404);
    await create(bodyFor(dev, target, { stepPercent: 10.125 })).expect(400);
  });

  it("DEVELOPER không tạo được (§2.2: khởi tạo rollout là MAINTAINER+) nhưng probe được", async () => {
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      0,
    );
    await create(bodyFor(dev, target), developer).expect(403);
    const probe = await as(
      developer,
      request(app)
        .post(`${rolloutsUrl()}/probe`)
        .send({ envId: dev.id, workloadName: "no-metrics" }),
    ).expect(200);
    expect(probe.body.probe).toMatchObject({
      reachable: true,
      hasSeries: false,
      minMetricWindowSeconds: 60,
    });
  });

  it("Idempotency-Key: gửi lại cùng key cùng body ⇒ đúng response cũ, không tạo session thứ hai", async () => {
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      0,
    );
    const key = randomUUID();
    const first = await create(bodyFor(dev, target))
      .set("Idempotency-Key", key)
      .expect(201);
    const replay = await create(bodyFor(dev, target))
      .set("Idempotency-Key", key)
      .expect(201);
    expect(replay.get("Idempotency-Replayed")).toBe("true");
    expect(replay.body.rollout.id).toBe(first.body.rollout.id);
    expect(await sessionsOn(target)).toBe(1);
  });
});

describe("bù trừ khi track hỏng — không bao giờ 201 cho flag không được gắn nhãn", () => {
  const compensated = () =>
    admin.auditLog.count({
      where: { projectId, action: "rollout.create.compensated" },
    });

  it("environment đã đủ 3 flag gắn nhãn ⇒ 409 TRACKED_FLAG_LIMIT, session đã xoá, đúng MỘT audit bù trừ", async () => {
    const full = await Promise.all(
      [0, 1, 2].map(() =>
        newFlagTarget(admin, { projectId, environmentId: staging.id }, 0),
      ),
    );
    for (const t of full) {
      await admin.$executeRaw`UPDATE flag_env_configs SET is_tracked = true WHERE id = ${t.envConfigId}::uuid`;
    }
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: staging.id },
      0,
    );
    const before = await compensated();
    const res = await create(bodyFor(staging, target)).expect(409);
    expect(res.body.code).toBe("TRACKED_FLAG_LIMIT");
    expect(res.body).not.toHaveProperty("resourceId");
    expect(await sessionsOn(target)).toBe(0);
    expect(await compensated()).toBe(before + 1);
  });

  it("Service 2 không phản hồi ⇒ 503, session đã xoá, đúng MỘT audit bù trừ", async () => {
    const dead = createApp({
      metricsFor: () => fake,
      oidcIssuer: null,
      flagService: createFlagServiceClient({
        baseUrl: `http://127.0.0.1:${String(await freePort())}`,
        secret: env.INTERNAL_SERVICE_SECRET,
      }),
    });
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      0,
    );
    const before = await compensated();
    const res = await create(bodyFor(dev, target), owner, dead).expect(503);
    expect(res.body.code).toBe("PROVIDER_UNAVAILABLE");
    expect(await sessionsOn(target)).toBe(0);
    expect(await compensated()).toBe(before + 1);
  });

  it("không xoá được (S3 đã chạm hàng) ⇒ rơi sang intent ROLLBACK huỷ; lỗi nói đúng và mang resourceId", async () => {
    // `track` giả: trong lúc S1 chờ, "S3" đã claim (version đẩy lên) rồi S2 không phản hồi
    const touched = createApp({
      metricsFor: () => fake,
      oidcIssuer: null,
      // Client thật, chỉ `track` bị thay — mọi lời gọi khác giữ đúng hợp đồng
      flagService: {
        ...createFlagServiceClient({
          baseUrl: "http://127.0.0.1:9",
          secret: env.INTERNAL_SERVICE_SECRET,
        }),
        track: async (sessionId) => {
          await admin.$executeRaw`UPDATE rollout_sessions SET version = version + 1 WHERE id = ${sessionId}::uuid`;
          return { status: "UNAVAILABLE", message: "hết giờ" };
        },
      },
    });
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      0,
    );
    const res = await create(bodyFor(dev, target), owner, touched).expect(503);
    const [session] = await admin.rolloutSession.findMany({
      where: { flagEnvConfigId: target.envConfigId },
      select: { id: true },
    });
    if (session === undefined) throw new Error("session phải còn — S3 đã chạm");
    expect(res.body.resourceId).toBe(session.id);
    expect(res.body.detail).toMatch(/đã được yêu cầu huỷ/);
    const intents = await admin.rolloutEvent.findMany({
      where: { sessionId: session.id, isIntent: true },
      select: { action: true, reason: true },
    });
    expect(intents).toEqual([
      { action: "ROLLBACK", reason: "track thất bại: hết giờ" },
    ]);
  });
});

describe("intent (§7.6) — 202, ghi có điều kiện, NOTIFY trong transaction", () => {
  it.each(["PAUSE", "RESUME", "PROMOTE"] as const)(
    "PENDING: %s ⇒ 409 (chỉ huỷ được), không ghi intent",
    async (action) => {
      const target = await newFlagTarget(
        admin,
        { projectId, environmentId: dev.id },
        0,
      );
      const created = await create(bodyFor(dev, target)).expect(201);
      const id = created.body.rollout.id as string;
      const res = await as(
        owner,
        request(app).post(`${rolloutsUrl()}/${id}/actions`).send({ action }),
      ).expect(409);
      expect(res.body.detail).toMatch(/chưa bắt đầu/);
      expect(
        await admin.rolloutEvent.count({
          where: { sessionId: id, isIntent: true },
        }),
      ).toBe(0);
    },
  );

  it("PENDING: ROLLBACK (huỷ) ⇒ 202 + ĐÚNG MỘT notice; ROLLBACK lần hai khi còn chờ ⇒ 409 và không notice", async () => {
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      0,
    );
    const created = await create(bodyFor(dev, target)).expect(201);
    const id = created.body.rollout.id as string;
    const actions = `${rolloutsUrl()}/${id}/actions`;

    const listener = createSessionConnector(env.DATABASE_URL_DIRECT)();
    const notices: string[] = [];
    listener.onNotification((channel, payload) => {
      if (channel === ROLLOUT_INTENT_CHANNEL && payload !== undefined) {
        notices.push(parseRolloutIntentNotice(payload)?.sessionId ?? "");
      }
    });
    try {
      await listener.connect(10_000);
      await listener.listen(ROLLOUT_INTENT_CHANNEL, 10_000);
      const accepted = await as(
        owner,
        request(app).post(actions).send({ action: "ROLLBACK" }),
      ).expect(202);
      expect(accepted.body).toMatchObject({ status: "accepted" });
      const deadline = Date.now() + 10_000;
      while (!notices.includes(id) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      const second = await as(
        owner,
        request(app).post(actions).send({ action: "ROLLBACK" }),
      ).expect(409);
      expect(second.body.detail).toMatch(/ý định chờ/);
      // Chờ đủ lâu để một notice thừa (nếu có) kịp tới
      await new Promise((r) => setTimeout(r, 1_500));
      expect(notices.filter((n) => n === id)).toHaveLength(1);
    } finally {
      await listener.close(5_000);
    }

    const rows = await admin.rolloutEvent.findMany({
      where: { sessionId: id, isIntent: true },
      select: {
        action: true,
        trafficPercentage: true,
        triggeredBy: true,
        actorUserId: true,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "ROLLBACK",
      triggeredBy: "MANUAL",
      actorUserId: owner.userId,
    });
    expect(Number(rows[0]?.trafficPercentage)).toBe(0);

    const detail = await as(
      owner,
      request(app).get(`${rolloutsUrl()}/${id}`),
    ).expect(200);
    expect(detail.body.rollout.pendingIntent).toMatchObject({
      action: "ROLLBACK",
      byUser: owner.email,
    });
  });

  it("rollout đã kết thúc ⇒ 409; DEVELOPER bấm override ⇒ 403; rollout của project khác ⇒ 404", async () => {
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      0,
    );
    const created = await create(bodyFor(dev, target)).expect(201);
    const id = created.body.rollout.id as string;
    await admin.rolloutSession.update({
      where: { id },
      data: { status: "FAILED", failReason: "MANUAL" },
    });

    const actions = `${rolloutsUrl()}/${id}/actions`;
    const ended = await as(
      owner,
      request(app).post(actions).send({ action: "PAUSE" }),
    ).expect(409);
    expect(ended.body.detail).toMatch(/đã kết thúc/);
    await as(
      developer,
      request(app).post(actions).send({ action: "PAUSE" }),
    ).expect(403);
    await as(
      owner,
      request(app)
        .post(`${rolloutsUrl()}/${randomUUID()}/actions`)
        .send({ action: "PAUSE" }),
    ).expect(404);
  });
});

describe("đọc — hình dạng §9", () => {
  it("chi tiết đổi epoch ms của last_decision/metricSnapshot sang ISO; danh sách lọc theo env và status; nhật ký keyset", async () => {
    const target = await newFlagTarget(
      admin,
      { projectId, environmentId: dev.id },
      0,
    );
    const created = await create(bodyFor(dev, target)).expect(201);
    const id = created.body.rollout.id as string;
    const at = Date.UTC(2026, 8, 22, 10, 0, 0);
    const branch = {
      requestCount: 100,
      errorCount: 1,
      errorRate: 0.01,
      hasData: true,
    };
    await admin.rolloutSession.update({
      where: { id },
      data: {
        status: "IN_PROGRESS",
        lastDecision: {
          decision: "HOLD",
          reason: "Mới 34/100 request",
          at,
          breach: false,
          breachStreak: 0,
          breachAt: null,
          metricSnapshot: {
            canary: branch,
            baseline: branch,
            zScore: null,
            queries: { canary: ["q1"], baseline: ["q2"] },
            windowSeconds: 60,
            at,
          },
        },
      },
    });

    const detail = await as(
      developer,
      request(app).get(`${rolloutsUrl()}/${id}`),
    ).expect(200);
    expect(detail.body.rollout.lastDecision).toMatchObject({
      decision: "HOLD",
      at: new Date(at).toISOString(),
    });
    expect(detail.body.rollout.latestMetricSnapshot).toMatchObject({
      at: new Date(at).toISOString(),
      queries: { canary: ["q1"] },
    });

    const listed = await as(
      developer,
      request(app)
        .get(rolloutsUrl())
        .query({ envId: dev.id, status: "IN_PROGRESS" }),
    ).expect(200);
    expect(listed.body.rollouts.map((r: { id: string }) => r.id)).toEqual([id]);

    for (const action of ["PAUSE", "RESUME"] as const) {
      await admin.rolloutEvent.create({
        data: {
          sessionId: id,
          action,
          isIntent: true,
          processedAt: new Date(),
          trafficPercentage: 0,
          triggeredBy: "MANUAL",
          actorUserId: owner.userId,
        },
      });
    }
    const page1 = await as(
      developer,
      request(app).get(`${rolloutsUrl()}/${id}/events`).query({ limit: 1 }),
    ).expect(200);
    expect(page1.body.events).toHaveLength(1);
    const page2 = await as(
      developer,
      request(app)
        .get(`${rolloutsUrl()}/${id}/events`)
        .query({ limit: 1, before: page1.body.events[0].id }),
    ).expect(200);
    expect(page2.body.events).toHaveLength(1);
    expect(page2.body.events[0].id).not.toBe(page1.body.events[0].id);
    // Con trỏ không thuộc rollout này ⇒ 400, không lặng lẽ trả lại trang đầu
    await as(
      developer,
      request(app)
        .get(`${rolloutsUrl()}/${id}/events`)
        .query({ limit: 1, before: randomUUID() }),
    ).expect(400);
  });

  it("mặc định của API trùng @default của cột (một nguồn sự thật — ROLLOUT_TIMING)", async () => {
    const rows = await admin.$queryRaw<
      { column_name: string; column_default: string | null }[]
    >`
      SELECT column_name, column_default
        FROM information_schema.columns
       WHERE table_name = 'rollout_sessions'
         AND column_name IN ('step_interval_seconds', 'analysis_interval_seconds',
                             'metric_window_seconds', 'warm_up_requests', 'max_duration_seconds')`;
    const defaults = Object.fromEntries(
      rows.map((r) => [r.column_name, Number(r.column_default)]),
    );
    expect(defaults).toEqual({
      step_interval_seconds: ROLLOUT_TIMING.stepIntervalSeconds,
      analysis_interval_seconds: ROLLOUT_TIMING.analysisIntervalSeconds,
      metric_window_seconds: ROLLOUT_TIMING.metricWindowSeconds,
      warm_up_requests: ROLLOUT_TIMING.warmUpRequests,
      max_duration_seconds: ROLLOUT_TIMING.maxDurationSeconds,
    });
  });
});

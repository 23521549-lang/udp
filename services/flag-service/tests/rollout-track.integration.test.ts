import { randomUUID } from "node:crypto";
import { ACTOR_HEADER, env, MAX_TRACKED_FLAGS_PER_ENV } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { configHashOf } from "@udp/flag-evaluator";
import { snapshotOf } from "@udp/flag-snapshot";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { stableOwner } from "@udp/test-support";

/**
 * `POST /internal/rollouts/:sessionId/track|untrack` và
 * `POST /internal/flag-envs/:id/untrack` qua HTTP thật (§6.6, §9 [v4.3]).
 *
 * Ba điều canh ở đây:
 *   - Tập tracked đi đúng đường ADR-05: một lần đổi là một version, một dòng
 *     outbox mang CẢ tập, và `config_hash` mô tả snapshot có tập đó.
 *   - Gọi lặp không tốn version: lần thứ hai không mở transaction, lần gọi đồng
 *     thời thứ hai lùi transaction của nó.
 *   - `untrack` không gỡ nhãn khi config còn session đang chạy — lệnh untrack tới
 *     muộn của rollout cũ không được tắt dữ liệu của rollout mới.
 */

/** User có thật (FK của audit và outbox) — route ghi của S2 bắt buộc actor [v4.5] */
let actorId = "";
const app = createApp();
const SECRET = env.INTERNAL_SERVICE_SECRET;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_tracktest_${randomUUID()}`,
});

let projectId: string | undefined;
let envId: string;
let ownerId: string;
const suffix = randomUUID().slice(0, 8);

interface Target {
  flagKey: string;
  configId: string;
  sessionId: string;
}
const targets: Target[] = [];

const post = (path: string): request.Test =>
  request(app)
    .post(`/internal${path}`)
    .set("X-Internal-Secret", SECRET)
    .set(ACTOR_HEADER, actorId);

const versionOf = async (): Promise<number> =>
  (
    await admin.environment.findUniqueOrThrow({
      where: { id: envId },
      select: { configVersion: true },
    })
  ).configVersion;

const trackedOf = async (configId: string): Promise<boolean> =>
  (
    await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: configId },
      select: { isTracked: true },
    })
  ).isTracked;

const lastOutbox = () =>
  admin.configChangeLog.findFirstOrThrow({
    where: { environmentId: envId },
    orderBy: { configVersion: "desc" },
    select: { changeType: true, payload: true, configVersion: true },
  });

async function newSession(configId: string): Promise<string> {
  const session = await admin.rolloutSession.create({
    data: {
      projectId: projectId as string,
      environmentId: envId,
      flagEnvConfigId: configId,
      workloadName: "checkout",
      rolloutScope: "FLAG_LEVEL",
      strategy: "CANARY",
      controlMode: "UDP_DRIVEN",
      status: "IN_PROGRESS",
      thresholds: {},
      stepPercent: 10,
      createdById: ownerId,
    },
    select: { id: true },
  });
  return session.id;
}

const finish = (sessionId: string) =>
  admin.rolloutSession.update({
    where: { id: sessionId },
    data: { status: "DONE" },
  });

beforeAll(async () => {
  ownerId = (await stableOwner(admin)).id;
  actorId = ownerId;
  const project = await admin.project.create({
    data: {
      ownerId,
      name: `tracktest-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-track-${suffix}-dev` },
        ],
      },
    },
    select: { id: true, environments: { select: { id: true } } },
  });
  projectId = project.id;
  envId = project.environments[0]!.id;

  // Một flag hơn trần, key có dấu '-' để thứ tự của tập đi qua đúng phép so chuỗi
  for (let i = 0; i <= MAX_TRACKED_FLAGS_PER_ENV; i += 1) {
    const flagKey = `t-${String(i)}-${suffix}`;
    const created = await post("/flags")
      .send({ projectId, key: flagKey, flagType: "BOOLEAN" })
      .expect(201);
    // Chỉ flag ACTIVE được gắn nhãn [v4.5]; flag mới tạo ở DRAFT
    await admin.featureFlag.update({
      where: { id: created.body.flag.id as string },
      data: { lifecycleStatus: "ACTIVE" },
    });
    const { id: configId } = await admin.flagEnvConfig.findFirstOrThrow({
      where: { flagId: created.body.flag.id as string, environmentId: envId },
      select: { id: true },
    });
    targets.push({ flagKey, configId, sessionId: await newSession(configId) });
  }
});

afterAll(async () => {
  if (projectId !== undefined) {
    await admin.configChangeLog.deleteMany({ where: { environmentId: envId } });
    await admin.auditLog.deleteMany({ where: { projectId: projectId } });
    await admin.project.deleteMany({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

describe("track — tập tracked đi đúng đường ADR-05", () => {
  it("một lần track = một version, outbox mang cả tập, hash mô tả snapshot có tập đó", async () => {
    const t = targets[0]!;
    const stampBefore = await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: t.configId },
      select: { updatedAt: true },
    });
    const before = await versionOf();

    const res = await post(`/rollouts/${t.sessionId}/track`).expect(200);

    expect(res.body).toEqual({
      flagKey: t.flagKey,
      environmentId: envId,
      tracked: true,
      changed: true,
    });
    expect(await versionOf()).toBe(before + 1);
    expect(await trackedOf(t.configId)).toBe(true);

    const row = await lastOutbox();
    expect(row).toEqual({
      changeType: "rollout.tracked",
      configVersion: before + 1,
      payload: { trackedFlags: [t.flagKey] },
    });

    const snapshot = await snapshotOf(admin, envId);
    expect(snapshot.trackedFlags).toEqual([t.flagKey]);
    const stored = await admin.environment.findUniqueOrThrow({
      where: { id: envId },
      select: { configHash: true },
    });
    expect(stored.configHash).toBe(configHashOf(snapshot));

    // Track không phải lần sửa cấu hình của người dùng: mốc optimistic lock đứng yên
    const stampAfter = await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: t.configId },
      select: { updatedAt: true },
    });
    expect(stampAfter.updatedAt).toEqual(stampBefore.updatedAt);
  });

  it("track lần hai ⇒ 200, không đổi gì, không tốn version", async () => {
    const t = targets[0]!;
    const before = await versionOf();
    const res = await post(`/rollouts/${t.sessionId}/track`).expect(200);
    expect(res.body).toMatchObject({
      changed: false,
      skipped: "already-tracked",
    });
    expect(await versionOf()).toBe(before);
  });

  it("hai lời gọi đồng thời ⇒ đúng MỘT version — bên thua lùi transaction của nó", async () => {
    const t = targets[1]!;
    const before = await versionOf();
    const results = await Promise.all([
      post(`/rollouts/${t.sessionId}/track`).expect(200),
      post(`/rollouts/${t.sessionId}/track`).expect(200),
    ]);
    const changed = results.filter((r) => r.body.changed === true);
    expect(changed).toHaveLength(1);
    expect(await versionOf()).toBe(before + 1);
  });

  it(`flag thứ ${String(MAX_TRACKED_FLAGS_PER_ENV + 1)} ⇒ 409 TRACKED_FLAG_LIMIT, version đứng yên`, async () => {
    await post(`/rollouts/${targets[2]!.sessionId}/track`).expect(200);
    const extra = targets[MAX_TRACKED_FLAGS_PER_ENV]!;
    const before = await versionOf();

    const res = await post(`/rollouts/${extra.sessionId}/track`).expect(409);

    expect(res.body.code).toBe("TRACKED_FLAG_LIMIT");
    expect(await versionOf()).toBe(before);
    expect(await trackedOf(extra.configId)).toBe(false);
    expect((await snapshotOf(admin, envId)).trackedFlags).toEqual(
      targets
        .slice(0, MAX_TRACKED_FLAGS_PER_ENV)
        .map((x) => x.flagKey)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
});

describe("untrack — không gỡ nhãn của rollout còn đang chạy", () => {
  it("session vẫn IN_PROGRESS ⇒ bỏ qua, nhãn giữ nguyên, không tốn version", async () => {
    const t = targets[0]!;
    const before = await versionOf();
    const res = await post(`/flag-envs/${t.configId}/untrack`).expect(200);
    expect(res.body).toMatchObject({
      changed: false,
      tracked: true,
      skipped: "active-session",
    });
    expect(await versionOf()).toBe(before);
  });

  it("rollout cũ xong nhưng rollout MỚI cùng config đang chạy ⇒ lệnh untrack muộn của rollout cũ không gỡ nhãn", async () => {
    const t = targets[0]!;
    await finish(t.sessionId);
    const successor = await admin.rolloutSession.create({
      data: {
        projectId: projectId as string,
        environmentId: envId,
        flagEnvConfigId: t.configId,
        workloadName: "payments",
        rolloutScope: "FLAG_LEVEL",
        strategy: "CANARY",
        controlMode: "UDP_DRIVEN",
        status: "PENDING",
        thresholds: {},
        stepPercent: 10,
        createdById: ownerId,
      },
      select: { id: true },
    });

    // S1 gọi track cho rollout mới — đã track sẵn nên không đổi
    await post(`/rollouts/${successor.id}/track`).expect(200);
    const late = await post(`/flag-envs/${t.configId}/untrack`).expect(200);

    expect(late.body.skipped).toBe("active-session");
    expect(await trackedOf(t.configId)).toBe(true);
    await finish(successor.id);
  });

  it("không còn session chạy ⇒ gỡ, một version, outbox mang tập còn lại", async () => {
    const t = targets[0]!;
    const before = await versionOf();
    const res = await post(`/flag-envs/${t.configId}/untrack`).expect(200);
    expect(res.body).toMatchObject({ changed: true, tracked: false });
    expect(await versionOf()).toBe(before + 1);

    const row = await lastOutbox();
    expect(row.changeType).toBe("rollout.untracked");
    expect(row.payload).toEqual({
      trackedFlags: (await snapshotOf(admin, envId)).trackedFlags,
    });
    const { trackedFlags } = row.payload as { trackedFlags: string[] };
    expect(trackedFlags).not.toContain(t.flagKey);
  });

  it("untrack lần hai ⇒ 200, không tốn version", async () => {
    const before = await versionOf();
    const res = await post(`/flag-envs/${targets[0]!.configId}/untrack`).expect(
      200,
    );
    expect(res.body).toMatchObject({ changed: false, skipped: "not-tracked" });
    expect(await versionOf()).toBe(before);
  });

  it("hàng session đã bị xoá ⇒ vẫn gỡ được theo config", async () => {
    const t = targets[1]!;
    await admin.rolloutSession.delete({ where: { id: t.sessionId } });

    const res = await post(`/flag-envs/${t.configId}/untrack`).expect(200);

    expect(res.body).toMatchObject({ changed: true, tracked: false });
    expect(await trackedOf(t.configId)).toBe(false);
  });
});

describe("biên của endpoint", () => {
  it("track rollout đã kết thúc ⇒ 409, không gắn nhãn", async () => {
    const t = targets[MAX_TRACKED_FLAGS_PER_ENV]!;
    await finish(t.sessionId);
    await post(`/rollouts/${t.sessionId}/track`).expect(409);
    expect(await trackedOf(t.configId)).toBe(false);
  });

  it("flag không còn ACTIVE ⇒ 409, không gắn nhãn — chốt nằm DƯỚI khoá env [v4.5]", async () => {
    const t = targets[MAX_TRACKED_FLAGS_PER_ENV]!;
    const { flagId } = await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: t.configId },
      select: { flagId: true },
    });
    await admin.rolloutSession.update({
      where: { id: t.sessionId },
      data: { status: "PENDING" },
    });
    await admin.featureFlag.update({
      where: { id: flagId },
      data: { lifecycleStatus: "ARCHIVED" },
    });
    try {
      const res = await post(`/rollouts/${t.sessionId}/track`).expect(409);
      expect(res.body.detail).toMatch(/không còn ACTIVE/);
      expect(await trackedOf(t.configId)).toBe(false);
    } finally {
      await admin.featureFlag.update({
        where: { id: flagId },
        data: { lifecycleStatus: "ACTIVE" },
      });
    }
  });

  it("nhãn CÒN từ rollout trước (S3 chưa untrack) + flag vừa lưu trữ ⇒ vẫn 409 — lối tắt 'đã gắn nhãn' không vượt được chốt ACTIVE [v4.5]", async () => {
    // targets[2] được gắn nhãn ở ca trần cardinality và chưa ai gỡ
    const t = targets[2]!;
    const { flagId } = await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: t.configId },
      select: { flagId: true },
    });
    expect(await trackedOf(t.configId)).toBe(true);
    await finish(t.sessionId);
    const next = await newSession(t.configId);
    await admin.featureFlag.update({
      where: { id: flagId },
      data: { lifecycleStatus: "ARCHIVED" },
    });
    try {
      const res = await post(`/rollouts/${next}/track`).expect(409);
      expect(res.body.detail).toMatch(/không còn ACTIVE/);
    } finally {
      await admin.rolloutSession.delete({ where: { id: next } });
      await admin.featureFlag.update({
        where: { id: flagId },
        data: { lifecycleStatus: "ACTIVE" },
      });
    }
  });

  it("session không tồn tại ⇒ 404; id sai dạng ⇒ 400; thiếu secret ⇒ 401", async () => {
    await post(`/rollouts/${randomUUID()}/track`).expect(404);
    await post("/rollouts/khong-phai-uuid/track").expect(400);
    await request(app)
      .post(`/internal/rollouts/${targets[2]!.sessionId}/track`)
      .expect(401);
  });
  it("gỡ theo config mà config không còn ⇒ 200 not-found, không tốn version — S3 coi mọi 404 là lỗi thật", async () => {
    const before = await versionOf();
    const res = await post(`/flag-envs/${randomUUID()}/untrack`).expect(200);

    expect(res.body).toEqual({
      tracked: false,
      changed: false,
      skipped: "not-found",
    });
    expect(await versionOf()).toBe(before);
  });
});

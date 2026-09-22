import { createHash, randomUUID } from "node:crypto";
import { configHashOf } from "@udp/flag-evaluator";
import { snapshotOf } from "@udp/flag-snapshot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { metrics } from "../src/core/metrics.js";
import {
  createKillSwitch,
  type KillSwitch,
} from "../src/executors/kill-switch.js";
import { Fence } from "../src/reconciler/fence.js";
import { updateIfVersion } from "../src/rollout-session/session.repository.js";
import { s3, seedLabel, testController } from "./helpers/controller.js";
import {
  admin,
  dropProject,
  executionEvents,
  newIntent,
  newProject,
  newSession,
  newTarget,
  onPercentOf,
  sessionState,
  type Target,
} from "./helpers/fixture.js";
import { startFlagService } from "@udp/test-support";

/**
 * §7.6, I30 phần (a) — Service 2 không phản hồi khi cần rollback: thử lại tới
 * `rollbackRetrySeconds`, rồi kill-switch ghi thẳng `serve` về baseline qua
 * `udp_s3` thật, và session đóng FAILED/DEPENDENCY_DOWN. Executor trỏ vào một
 * cổng không ai nghe — S2 "chết" có chủ đích.
 *
 * Nửa cuối của I30(a): bật Service 2 lại và khẳng định nó PHỤC VỤ đúng giá trị
 * kill-switch đã ghi — tức outbox, hash và thứ tự weights đều đúng kỷ luật mà S2
 * tự dùng. Nửa (b) (GRANT chặn mọi thứ khác) nằm ở `packages/db`.
 */

let project: Awaited<ReturnType<typeof newProject>>;
const DEAD = "http://127.0.0.1:9";

beforeAll(async () => {
  project = await newProject();
});

afterAll(async () => {
  await admin.sdkKey.deleteMany({
    where: { environment: { projectId: project.projectId } },
  });
  await dropProject(project.projectId);
  await admin.$disconnect();
});

type LabelledCounter =
  typeof metrics.rollbackBlocked | typeof metrics.killSwitch;

const counterOf = async (
  counter: LabelledCounter,
  labels: Record<string, string> = {},
): Promise<number> => {
  const { values } = await counter.get();
  return (
    values.find((v) =>
      Object.entries(labels).every(
        ([k, val]) => (v.labels as Record<string, unknown>)[k] === val,
      ),
    )?.value ?? 0
  );
};

const failingRollout = (target: Target): Promise<string> =>
  newSession(target, {
    status: "IN_PROGRESS",
    currentPercent: 30,
    baselinePercent: 5,
    thresholds: { maxConsecutiveBreaches: 1 },
  });

const breach = (
  c: ReturnType<typeof testController>,
  flagKey: string,
): void => {
  c.provider.set(`${flagKey}=on`, {
    requests: 3_000,
    errors: 300,
    p99Ms: 200,
  });
  c.provider.set(`${flagKey}=off`, {
    requests: 27_000,
    errors: 81,
    p99Ms: 200,
  });
};

const versionOf = async (environmentId: string): Promise<number> =>
  (
    await admin.environment.findUniqueOrThrow({
      where: { id: environmentId },
      select: { configVersion: true },
    })
  ).configVersion;

describe("I30(a) — kill-switch khi Service 2 chết", () => {
  it("auto-rollback không qua được S2 ⇒ serve về baseline qua ADR-05, session FAILED/DEPENDENCY_DOWN", async () => {
    const target = await newTarget(project, 30);
    const id = await failingRollout(target);
    const c = testController(DEAD, { rollbackRetrySeconds: 10 });
    breach(c, target.flagKey);

    const blockedBefore = await counterOf(metrics.rollbackBlocked);
    const appliedBefore = await counterOf(metrics.killSwitch, {
      outcome: "applied",
    });
    const versionBefore = await versionOf(target.environmentId);
    const stampBefore = await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: target.envConfigId },
      select: { updatedAt: true },
    });

    await c.reconciler.reconcileOne(id);

    // Session: đóng, và phần trăm ghi đúng thứ đang phục vụ
    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "DEPENDENCY_DOWN",
      currentTrafficPercentage: 5,
    });
    const [event] = await executionEvents(id);
    expect(event).toMatchObject({
      action: "DEPENDENCY_DOWN",
      trafficPercentage: 5,
    });
    const deployment = await admin.deploymentEvent.findFirstOrThrow({
      where: { rolloutSessionId: id },
      select: { eventType: true, metadata: true },
    });
    expect(deployment).toMatchObject({
      eventType: "ROLLBACK",
      metadata: {
        via: "kill-switch",
        from: 30,
        to: 5,
        failReason: "DEPENDENCY_DOWN",
        intendedFailReason: "AUTO_ROLLBACK",
      },
    });

    // Cấu hình: trọng số về baseline, sắp theo variantId, đúng một version
    expect(await onPercentOf(target.ruleId, target.on)).toBe(5);
    const rule = await admin.flagTargetingRule.findUniqueOrThrow({
      where: { id: target.ruleId },
      select: { serve: true },
    });
    const ids = (
      rule.serve as { weights: { variantId: string }[] }
    ).weights.map((w) => w.variantId);
    expect(ids).toEqual([...ids].sort());
    expect(await versionOf(target.environmentId)).toBe(versionBefore + 1);

    // Outbox và hash: đúng thứ S2 tự ghi cho một lần ramp
    const outbox = await admin.configChangeLog.findFirstOrThrow({
      where: { environmentId: target.environmentId },
      orderBy: { configVersion: "desc" },
      select: { changeType: true, payload: true, actorUserId: true },
    });
    expect(outbox.changeType).toBe("rule.ramped");
    expect(outbox.actorUserId).toBeNull();
    expect(outbox.payload).toMatchObject({
      rolloutSessionId: id,
      flag: { key: target.flagKey },
    });
    const snapshot = await snapshotOf(admin, target.environmentId);
    const env = await admin.environment.findUniqueOrThrow({
      where: { id: target.environmentId },
      select: { configHash: true },
    });
    expect(env.configHash).toBe(configHashOf(snapshot));

    // Mốc optimistic lock của env-config đã đẩy — người sửa rule từ trước nhận 409
    const stampAfter = await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: target.envConfigId },
      select: { updatedAt: true },
    });
    expect(stampAfter.updatedAt.getTime()).toBeGreaterThan(
      stampBefore.updatedAt.getTime(),
    );

    expect(await counterOf(metrics.rollbackBlocked)).toBe(blockedBefore + 1);
    expect(await counterOf(metrics.killSwitch, { outcome: "applied" })).toBe(
      appliedBefore + 1,
    );
  });

  it("Service 2 bật lại ⇒ /sdk/config phục vụ đúng trọng số kill-switch đã ghi", async () => {
    const target = await newTarget(project, 40);
    const id = await failingRollout(target);
    const c = testController(DEAD, { rollbackRetrySeconds: 10 });
    breach(c, target.flagKey);
    await c.reconciler.reconcileOne(id);
    expect(await onPercentOf(target.ruleId, target.on)).toBe(5);

    const raw = `udp_sk_test_${randomUUID()}`;
    await admin.sdkKey.create({
      data: {
        environmentId: target.environmentId,
        keyType: "SERVER",
        keyHash: createHash("sha256").update(raw).digest("hex"),
        keySuffix: raw.slice(-6),
        label: "killswitch-test",
        createdById: project.ownerId,
      },
    });

    const s2 = await startFlagService();
    try {
      const res = await fetch(`${s2.baseUrl}/sdk/config`, {
        headers: { authorization: `Bearer ${raw}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        configHash: string;
        flags: {
          key: string;
          rules?: {
            serve: { weights?: { variantKey: string; weight: number }[] };
          }[];
        }[];
      };
      const flag = body.flags.find((f) => f.key === target.flagKey);
      const weights = flag?.rules?.[0]?.serve.weights ?? [];
      expect(weights.find((w) => w.variantKey === "on")?.weight).toBe(5_000);
      expect(body.configHash).toBe(
        configHashOf(await snapshotOf(admin, target.environmentId)),
      );
    } finally {
      await s2.stop();
    }
  });

  it("ROLLBACK thủ công gặp S2 chết ⇒ kill-switch áp, intent được đánh dấu, ghi vết ý định gốc", async () => {
    const target = await newTarget(project, 30);
    const id = await newSession(target, {
      status: "IN_PROGRESS",
      currentPercent: 30,
      baselinePercent: 0,
    });
    const c = testController(DEAD, { rollbackRetrySeconds: 10 });
    const intent = await newIntent(id, "ROLLBACK", project.ownerId, 0);
    await c.reconciler.reconcileOne(id);

    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "DEPENDENCY_DOWN",
      currentTrafficPercentage: 0,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(0);
    const [event] = await executionEvents(id);
    expect(event).toMatchObject({
      action: "DEPENDENCY_DOWN",
      triggeredBy: "MANUAL",
      causedByEventId: intent,
    });
    const row = await admin.rolloutEvent.findUniqueOrThrow({
      where: { id: intent },
      select: { processedAt: true },
    });
    expect(row.processedAt).not.toBeNull();
    const deployment = await admin.deploymentEvent.findFirstOrThrow({
      where: { rolloutSessionId: id },
      select: { triggeredBy: true, metadata: true },
    });
    expect(deployment).toMatchObject({
      triggeredBy: "MANUAL",
      metadata: { intendedFailReason: "MANUAL" },
    });
  });

  it("kill-switch cũng hỏng ⇒ session vẫn đóng, traffic giữ nguyên, đếm failed", async () => {
    const target = await newTarget(project, 30);
    const id = await failingRollout(target);
    const broken: KillSwitch = {
      apply: () =>
        Promise.resolve({ status: "FAILED", message: "database cũng chết" }),
    };
    const failedBefore = await counterOf(metrics.killSwitch, {
      outcome: "failed",
    });
    const c = testController(DEAD, {
      rollbackRetrySeconds: 10,
      killSwitch: broken,
    });
    breach(c, target.flagKey);
    await c.reconciler.reconcileOne(id);

    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "DEPENDENCY_DOWN",
      currentTrafficPercentage: 30,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(30);
    expect(
      await admin.deploymentEvent.count({ where: { rolloutSessionId: id } }),
    ).toBe(0);
    expect(await counterOf(metrics.killSwitch, { outcome: "failed" })).toBe(
      failedBefore + 1,
    );
  });

  it("worker tỉnh muộn (version đã đổi) ⇒ transaction kill-switch lùi cả serve lẫn version", async () => {
    const target = await newTarget(project, 30);
    const id = await failingRollout(target);
    const versionBefore = await versionOf(target.environmentId);
    const killSwitch = createKillSwitch({ db: s3, notify: false });
    // Worker khác đã tiếp quản và ghi: version trong DB đi trước fence của worker này
    const stale = (await sessionState(id)).version;
    await admin.$executeRaw`UPDATE rollout_sessions SET version = version + 1 WHERE id = ${id}::uuid`;

    const outcome = await killSwitch.apply({
      fence: new Fence(id, stale, "late-worker"),
      sessionId: id,
      environmentId: target.environmentId,
      flagEnvConfigId: target.envConfigId,
      ruleId: target.ruleId,
      flagKey: target.flagKey,
      targetVariantId: target.on,
      expectedVariantIds: [target.on, target.off],
      percent: 0,
      // Đúng lệnh ghi của reconciler: `updateIfVersion` thật, trong transaction kill-switch
      record: (tx) =>
        updateIfVersion(tx, id, stale, {
          status: "FAILED",
          failReason: "DEPENDENCY_DOWN",
          currentTrafficPercentage: 0,
        }),
    });

    expect(outcome).toEqual({ status: "STALE" });
    expect(await sessionState(id)).toMatchObject({
      status: "IN_PROGRESS",
      version: stale + 1,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(30);
    expect(await versionOf(target.environmentId)).toBe(versionBefore);
  });

  it("tập variant của rule đã đổi từ lúc vòng đọc ⇒ FAILED, không ghi đè, không tốn version", async () => {
    const target = await newTarget(project, 30);
    const id = await failingRollout(target);
    const versionBefore = await versionOf(target.environmentId);
    let recorded = false;

    const outcome = await createKillSwitch({ db: s3, notify: false }).apply({
      fence: new Fence(id, 1, "w"),
      sessionId: id,
      environmentId: target.environmentId,
      flagEnvConfigId: target.envConfigId,
      ruleId: target.ruleId,
      flagKey: target.flagKey,
      targetVariantId: target.on,
      // vòng này đã đọc một rule mang variant khác
      expectedVariantIds: [target.on, randomUUID()],
      percent: 0,
      record: () => {
        recorded = true;
        return Promise.resolve(true);
      },
    });

    expect(outcome).toMatchObject({ status: "FAILED" });
    expect(recorded).toBe(false);
    expect(await onPercentOf(target.ruleId, target.on)).toBe(30);
    expect(await versionOf(target.environmentId)).toBe(versionBefore);
  });

  it("Service 2 SỐNG mà từ chối rollback (4xx) ⇒ HOLD với lý do, không kill-switch, session vẫn chạy", async () => {
    const target = await newTarget(project, 30);
    const id = await failingRollout(target);
    let killSwitchCalls = 0;
    const c = testController(DEAD, {
      rollbackRetrySeconds: 10,
      executor: {
        applyTraffic: () =>
          Promise.resolve({
            status: "REJECTED",
            message: "HTTP 422: rule sai",
          }),
        untrack: () => Promise.resolve({ status: "SUCCESS", changed: false }),
        track: () => Promise.resolve({ status: "SUCCESS", changed: false }),
      },
      killSwitch: {
        apply: () => {
          killSwitchCalls += 1;
          return Promise.resolve({ status: "APPLIED" });
        },
      },
    });
    breach(c, target.flagKey);
    await c.reconciler.reconcileOne(id);

    const state = await sessionState(id);
    expect(state.status).toBe("IN_PROGRESS");
    expect(state.lastDecision?.reason).toMatch(/từ chối/);
    expect(killSwitchCalls).toBe(0);
    expect(await onPercentOf(target.ruleId, target.on)).toBe(30);
  });

  it("không cấu hình kill-switch ⇒ đóng session, traffic giữ nguyên", async () => {
    const target = await newTarget(project, 30);
    const id = await failingRollout(target);
    const bare = testController(DEAD, {
      rollbackRetrySeconds: 10,
      withoutKillSwitch: true,
    });
    breach(bare, target.flagKey);
    await bare.reconciler.reconcileOne(id);
    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "DEPENDENCY_DOWN",
      currentTrafficPercentage: 30,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(30);
  });

  it("bậc promote không áp được thì chỉ HOLD với lý do — không FAILED, không kill-switch", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { stepPercent: 10 });
    const c = testController(DEAD);
    seedLabel(c.provider, target.flagKey);
    await c.reconciler.reconcileOne(id);
    const state = await sessionState(id);
    expect(state.status).toBe("PENDING");
    expect(state.lastDecision?.reason).toMatch(/Không áp dụng được/);
    expect(await onPercentOf(target.ruleId, target.on)).toBe(0);
  });
});

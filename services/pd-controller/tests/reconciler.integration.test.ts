import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@udp/config";
import { metrics } from "../src/core/metrics.js";
import { createFlagLevelExecutor } from "../src/executors/flag-level.executor.js";
import { testController, type TestController } from "./helpers/controller.js";
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
} from "./helpers/fixture.js";
import {
  startFlagService,
  type RunningFlagService,
} from "./helpers/flag-service.js";

/**
 * Vòng đời một rollout FLAG_LEVEL/CANARY qua Service 3 THẬT nối Service 2 THẬT
 * (§7.1, §7.6, §7.7): bắt đầu, promote sau dwell, hold, auto-rollback về
 * baseline, hết hạn, và bốn intent của người dùng.
 *
 * Đồng hồ tiêm vào, nên "5 phút dwell" là một dòng `clock.advance`. Metrics thì
 * từ FakeMetricsProvider. Chỉ database và S2 là thật — đó là hai thứ có hợp đồng
 * đáng kiểm (GRANT, fencing, outbox).
 */

let s2: RunningFlagService;
let project: Awaited<ReturnType<typeof newProject>>;

const processed = async (outcome: string): Promise<number> => {
  const m = await metrics.sessionsProcessed.get();
  return m.values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
};

/** Metrics tốt: canary 3000 request/12 lỗi, baseline 27000/81 (§7.7) */
const healthy = (c: TestController, flagKey: string): void => {
  c.provider.set(`${flagKey}=on`, {
    requests: 3_000,
    errors: 12,
    p99Ms: 250,
  });
  c.provider.set(`${flagKey}=off`, {
    requests: 27_000,
    errors: 81,
    p99Ms: 240,
  });
};

const failing = (c: TestController, flagKey: string): void => {
  c.provider.set(`${flagKey}=on`, {
    requests: 3_000,
    errors: 210,
    p99Ms: 250,
  });
  c.provider.set(`${flagKey}=off`, {
    requests: 27_000,
    errors: 81,
    p99Ms: 240,
  });
};

beforeAll(async () => {
  s2 = await startFlagService();
  project = await newProject();
}, 60_000);

afterAll(async () => {
  await s2.stop();
  await dropProject(project.projectId);
  await admin.$disconnect();
});

describe("Luồng 5 — vòng đời tự động", () => {
  it("PENDING → bậc đầu qua S2 → HOLD trong dwell → PROMOTE sau dwell → COMPLETE ở 100", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, {
      stepPercent: 50,
      stepIntervalSeconds: 300,
      analysisIntervalSeconds: 30,
      metricWindowSeconds: 60,
    });
    const c = testController(s2.baseUrl);
    healthy(c, target.flagKey);

    // Bậc đầu: 0 → 50 áp lên S2 trước, DB sau
    await c.reconciler.reconcileOne(id);
    expect(await onPercentOf(target.ruleId, target.on)).toBe(50);
    expect(await sessionState(id)).toMatchObject({
      status: "IN_PROGRESS",
      currentTrafficPercentage: 50,
      claimedBy: null,
    });

    // Chưa ổn định (window + scrapeLag = 75s) ⇒ HOLD, không PATCH
    c.clock.advance(60_000);
    await c.reconciler.reconcileOne(id);
    let state = await sessionState(id);
    expect(state.status).toBe("IN_PROGRESS");
    expect(state.lastDecision?.reason).toMatch(/ổn định/);

    // Đủ ổn định, metrics tốt, nhưng chưa hết dwell 300s ⇒ quyết PROMOTE mà không bước
    c.clock.advance(30_000);
    await c.reconciler.reconcileOne(id);
    state = await sessionState(id);
    expect(state.lastDecision?.decision).toBe("PROMOTE");
    expect(state.lastDecision?.metricSnapshot?.canary.requestCount).toBe(3_000);
    expect(state.currentTrafficPercentage).toBe(50);

    // Hết dwell ⇒ 50 → 100 = COMPLETE, session DONE
    c.clock.advance(300_000);
    await c.reconciler.reconcileOne(id);
    state = await sessionState(id);
    expect(state).toMatchObject({
      status: "DONE",
      currentTrafficPercentage: 100,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(100);

    const events = await executionEvents(id);
    expect(events.map((e) => e.action)).toEqual(["PROMOTE", "COMPLETE"]);
    expect(events.every((e) => e.triggeredBy === "AUTO")).toBe(true);
    // DONE thì không claim được nữa
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).status).toBe("DONE");
  });

  it("hai lần vượt ngưỡng liên tiếp ⇒ ROLLBACK về BASELINE, FAILED/AUTO_ROLLBACK, DeploymentEvent", async () => {
    const target = await newTarget(project, 20);
    const id = await newSession(target, {
      status: "IN_PROGRESS",
      currentPercent: 30,
      baselinePercent: 20,
      analysisIntervalSeconds: 30,
      metricWindowSeconds: 60,
      lastStepAt: null,
    });
    const c = testController(s2.baseUrl);
    failing(c, target.flagKey);

    await c.reconciler.reconcileOne(id);
    let state = await sessionState(id);
    expect(state.lastDecision).toMatchObject({
      decision: "HOLD",
      breachStreak: 1,
    });
    expect(state.status).toBe("IN_PROGRESS");

    // Chưa qua một cửa sổ đo ⇒ vẫn là cùng một lần đo
    c.clock.advance(30_000);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).lastDecision).toMatchObject({
      breachStreak: 1,
    });

    c.clock.advance(30_000);
    await c.reconciler.reconcileOne(id);
    state = await sessionState(id);
    expect(state).toMatchObject({
      status: "FAILED",
      failReason: "AUTO_ROLLBACK",
      currentTrafficPercentage: 20,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(20);

    const events = await executionEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "ROLLBACK",
      trafficPercentage: 20,
      triggeredBy: "AUTO",
    });
    const deployments = await admin.deploymentEvent.findMany({
      where: { rolloutSessionId: id },
      select: { eventType: true, workloadName: true, metadata: true },
    });
    expect(deployments).toHaveLength(1);
    expect(deployments[0]).toMatchObject({
      eventType: "ROLLBACK",
      workloadName: "checkout",
    });
    expect(deployments[0]?.metadata).toMatchObject({
      from: 30,
      to: 20,
      failReason: "AUTO_ROLLBACK",
    });
  });

  it("I7 — Prometheus không trả dữ liệu ⇒ HOLD mãi, không bao giờ promote", async () => {
    const target = await newTarget(project, 10);
    const id = await newSession(target, {
      status: "IN_PROGRESS",
      currentPercent: 10,
      baselinePercent: 0,
      stepIntervalSeconds: 0,
      analysisIntervalSeconds: 30,
    });
    const c = testController(s2.baseUrl);
    for (let i = 0; i < 3; i += 1) {
      await c.reconciler.reconcileOne(id);
      c.clock.advance(60_000);
    }
    const state = await sessionState(id);
    expect(state.currentTrafficPercentage).toBe(10);
    expect(state.lastDecision?.decision).toBe("HOLD");
    expect(await executionEvents(id)).toHaveLength(0);
  });

  it("quá max_duration_seconds ⇒ EXPIRE về baseline, FAILED/EXPIRED", async () => {
    const target = await newTarget(project, 40);
    const id = await newSession(target, {
      status: "IN_PROGRESS",
      currentPercent: 40,
      baselinePercent: 5,
      maxDurationSeconds: 60,
      createdAt: new Date(Date.now() - 3_600_000),
    });
    const c = testController(s2.baseUrl);
    await c.reconciler.reconcileOne(id);
    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "EXPIRED",
      currentTrafficPercentage: 5,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(5);
    expect((await executionEvents(id))[0]?.action).toBe("EXPIRE");
  });

  it("PENDING chưa bao giờ bắt đầu được (thiếu workload_name) vẫn hết hạn — không PATCH, không DeploymentEvent", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, {
      workloadName: null,
      maxDurationSeconds: 60,
      createdAt: new Date(Date.now() - 3_600_000),
    });
    const c = testController(s2.baseUrl);
    await c.reconciler.reconcileOne(id);
    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "EXPIRED",
      currentTrafficPercentage: 0,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(0);
    const [event] = await executionEvents(id);
    expect(event?.action).toBe("EXPIRE");
    expect(
      await admin.deploymentEvent.count({ where: { rolloutSessionId: id } }),
    ).toBe(0);
  });

  it("PAUSED cũng hết hạn — về baseline, FAILED/EXPIRED", async () => {
    const target = await newTarget(project, 40);
    const id = await newSession(target, {
      status: "PAUSED",
      currentPercent: 40,
      baselinePercent: 10,
      maxDurationSeconds: 60,
      createdAt: new Date(Date.now() - 3_600_000),
    });
    const c = testController(s2.baseUrl);
    await c.reconciler.reconcileOne(id);
    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "EXPIRED",
      currentTrafficPercentage: 10,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(10);
  });

  it("session thiếu workload_name ⇒ HOLD với lý do hiện lên last_decision, không PATCH", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { workloadName: null });
    const c = testController(s2.baseUrl);
    await c.reconciler.reconcileOne(id);
    const state = await sessionState(id);
    expect(state.status).toBe("PENDING");
    expect(state.lastDecision?.reason).toMatch(/workload_name/);
    expect(await onPercentOf(target.ruleId, target.on)).toBe(0);
  });

  it("thresholds sai hình dạng ⇒ lý do hiện lên last_decision và lease được NHẢ, không phải claim lại mỗi 60s", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { thresholds: { errorRates: 0.05 } });
    const c = testController(s2.baseUrl);
    await c.reconciler.reconcileOne(id);
    const state = await sessionState(id);
    expect(state.status).toBe("PENDING");
    expect(state.claimedBy).toBeNull();
    expect(state.lastDecision?.reason).toMatch(
      /Cấu hình session không hợp lệ: thresholds/,
    );
    expect(await onPercentOf(target.ruleId, target.on)).toBe(0);
  });

  it("chiến lược chưa có executor (BLUE_GREEN) ⇒ HOLD với lý do §7.2", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target);
    await admin.$executeRaw`UPDATE rollout_sessions SET strategy = 'BLUE_GREEN' WHERE id = ${id}::uuid`;
    const c = testController(s2.baseUrl);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).lastDecision?.reason).toMatch(
      /BLUE_GREEN .* thủ công/,
    );
  });
});

describe("§7.6 — intent của người dùng đi trước phân tích", () => {
  it("PAUSE rồi RESUME: đổi trạng thái, không PATCH, intent được đánh dấu, PAUSED bỏ qua phân tích (I27)", async () => {
    const target = await newTarget(project, 10);
    const id = await newSession(target, {
      status: "IN_PROGRESS",
      currentPercent: 10,
      stepIntervalSeconds: 0,
    });
    const c = testController(s2.baseUrl);
    healthy(c, target.flagKey);

    const pause = await newIntent(id, "PAUSE", project.ownerId, 10);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).status).toBe("PAUSED");

    // PAUSED: dù metrics tốt, không đo, không bước
    c.clock.advance(600_000);
    await c.reconciler.reconcileOne(id);
    expect(await sessionState(id)).toMatchObject({
      status: "PAUSED",
      currentTrafficPercentage: 10,
    });
    expect(c.provider.calls).toHaveLength(0);

    const resume = await newIntent(id, "RESUME", project.ownerId, 10);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).status).toBe("IN_PROGRESS");

    const events = await executionEvents(id);
    expect(events.map((e) => [e.action, e.causedByEventId])).toEqual([
      ["PAUSE", pause],
      ["RESUME", resume],
    ]);
    const intents = await admin.rolloutEvent.findMany({
      where: { sessionId: id, isIntent: true },
      select: { processedAt: true },
    });
    expect(intents.every((i) => i.processedAt !== null)).toBe(true);
  });

  it("ROLLBACK trên session PAUSED vẫn chạy (I27) — về baseline, FAILED/MANUAL", async () => {
    const target = await newTarget(project, 30);
    const id = await newSession(target, {
      status: "PAUSED",
      currentPercent: 30,
      baselinePercent: 10,
    });
    const c = testController(s2.baseUrl);
    const intent = await newIntent(id, "ROLLBACK", project.ownerId, 10);
    await c.reconciler.reconcileOne(id);
    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "MANUAL",
      currentTrafficPercentage: 10,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(10);
    const [event] = await executionEvents(id);
    expect(event).toMatchObject({
      action: "ROLLBACK",
      triggeredBy: "MANUAL",
      causedByEventId: intent,
    });
  });

  it("PROMOTE thủ công nhảy thẳng 100 ⇒ COMPLETE/DONE dù chưa hết dwell", async () => {
    const target = await newTarget(project, 10);
    const id = await newSession(target, {
      status: "IN_PROGRESS",
      currentPercent: 10,
      lastStepAt: new Date(),
    });
    const c = testController(s2.baseUrl);
    await newIntent(id, "PROMOTE", project.ownerId, 100);
    await c.reconciler.reconcileOne(id);
    expect(await sessionState(id)).toMatchObject({
      status: "DONE",
      currentTrafficPercentage: 100,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(100);
    expect((await executionEvents(id))[0]).toMatchObject({
      action: "COMPLETE",
      triggeredBy: "MANUAL",
    });
  });

  it("intent vô nghĩa (RESUME khi đang chạy) được đánh dấu processed mà không ghi event", async () => {
    const target = await newTarget(project, 10);
    const id = await newSession(target, {
      status: "IN_PROGRESS",
      currentPercent: 10,
    });
    const c = testController(s2.baseUrl);
    const intent = await newIntent(id, "RESUME", project.ownerId, 10);
    await c.reconciler.reconcileOne(id);
    const row = await admin.rolloutEvent.findUniqueOrThrow({
      where: { id: intent },
      select: { processedAt: true },
    });
    expect(row.processedAt).not.toBeNull();
    expect(await executionEvents(id)).toHaveLength(0);
    expect((await sessionState(id)).status).toBe("IN_PROGRESS");
  });

  it("intent không thi hành được vì cấu hình (PROMOTE khi thiếu workload_name) ⇒ đánh dấu đã xử lý + lý do, session tiếp tục vòng đời", async () => {
    const target = await newTarget(project, 10);
    const id = await newSession(target, {
      status: "IN_PROGRESS",
      currentPercent: 10,
      workloadName: null,
    });
    const c = testController(s2.baseUrl);
    const intent = await newIntent(id, "PROMOTE", project.ownerId, 100);
    await c.reconciler.reconcileOne(id);
    const row = await admin.rolloutEvent.findUniqueOrThrow({
      where: { id: intent },
      select: { processedAt: true },
    });
    expect(row.processedAt).not.toBeNull();
    const state = await sessionState(id);
    expect(state.status).toBe("IN_PROGRESS");
    expect(state.currentTrafficPercentage).toBe(10);
    expect(state.lastDecision?.reason).toMatch(
      /Ý định PROMOTE không thực hiện được: .*workload_name/,
    );
    expect(await executionEvents(id)).toHaveLength(0);
  });
});

describe("I23 — Service 2 từ chối worker mang version cũ", () => {
  it("412 khi version lệch ⇒ vòng dừng, không ghi DB, đếm precondition-failed", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { stepPercent: 10 });
    const before = await processed("precondition-failed");

    // Executor bị ép mang version cũ hơn version thật: mô phỏng worker ngủ quên
    const stale = testController(s2.baseUrl, {
      executor: createFlagLevelExecutor({
        baseUrl: s2.baseUrl,
        secret: env.INTERNAL_SERVICE_SECRET,
        fetch: (url, init) => {
          const headers = { ...(init?.headers as Record<string, string>) };
          headers["if-match"] = (headers["if-match"] ?? "").replace(
            /:(\d+)"$/,
            (_, v: string) => `:${String(Number(v) - 1)}"`,
          );
          return fetch(url, { ...init, headers });
        },
      }),
    });
    await stale.reconciler.reconcileOne(id);
    expect(await sessionState(id)).toMatchObject({
      status: "PENDING",
      currentTrafficPercentage: 0,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(0);
    expect(await processed("precondition-failed")).toBe(before + 1);
  });
});

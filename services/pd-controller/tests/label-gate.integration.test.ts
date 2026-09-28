import { ROLLOUT_TIMING } from "@udp/config";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TrackOutcome } from "@udp/shared-types";
import type { FlagLevelExecutor } from "../src/executors/flag-level.executor.js";
import { seedLabel, testController } from "./helpers/controller.js";
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

/**
 * [v4.4] Probe pha 2 (§7.4) và intent trên rollout chưa bắt đầu (§7.6 dòng PENDING).
 *
 * "KHÔNG BAO GIỜ chạy mù": bậc đầu chỉ áp khi đã thấy lưu lượng mang nhãn `ff`
 * của flag. Executor là bản giả ĐẾM lời gọi — ca nào cũng phải khẳng định được
 * "không PATCH", không chỉ "trạng thái đúng".
 */

let project: Awaited<ReturnType<typeof newProject>>;

beforeAll(async () => {
  project = await newProject();
});

/** Trả trạng thái gắn nhãn sau mỗi ca — kể cả ca hỏng giữa chừng */
afterEach(async () => {
  await admin.$executeRaw`UPDATE flag_env_configs SET is_tracked = false WHERE environment_id = ${project.environmentId}::uuid`;
});

afterAll(async () => {
  await dropProject(project.projectId);
  await admin.$disconnect();
});

interface Spy {
  executor: FlagLevelExecutor;
  patches: number;
  tracks: string[];
}

function spyExecutor(
  trackOutcome: TrackOutcome = { status: "SUCCESS", changed: true },
): Spy {
  const spy: Spy = {
    patches: 0,
    tracks: [],
    executor: {
      applyTraffic: () => {
        spy.patches += 1;
        return Promise.resolve({ status: "SUCCESS" });
      },
      untrack: () => Promise.resolve({ status: "SUCCESS", changed: false }),
      track: (sessionId) => {
        spy.tracks.push(sessionId);
        return Promise.resolve(trackOutcome);
      },
      setDefaultVariant: () => Promise.resolve({ status: "SUCCESS" }),
    },
  };
  return spy;
}

const markTracked = (target: Target) =>
  admin.$executeRaw`UPDATE flag_env_configs SET is_tracked = true WHERE id = ${target.envConfigId}::uuid`;

describe("probe pha 2 — bậc đầu chỉ áp khi đã thấy nhãn ff", () => {
  it("chưa thấy nhãn, flag chưa track ⇒ gọi lại track, HOLD có lý do, KHÔNG PATCH", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { stepPercent: 10 });
    const spy = spyExecutor();
    const c = testController("http://127.0.0.1:9", { executor: spy.executor });

    await c.reconciler.reconcileOne(id);

    const state = await sessionState(id);
    expect(state.status).toBe("PENDING");
    expect(state.lastDecision?.reason).toMatch(
      /Chưa thấy lưu lượng mang nhãn ff/,
    );
    expect(state.lastDecision?.reason).toMatch(/đã gọi lại track: đã gắn/);
    expect(spy.tracks).toEqual([id]);
    expect(spy.patches).toBe(0);
    expect(await onPercentOf(target.ruleId, target.on)).toBe(0);
  });

  it("flag đã track mà chưa thấy nhãn ⇒ KHÔNG gọi track (mỗi lời gọi khoá environment bên S2)", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { stepPercent: 10 });
    await markTracked(target);
    const spy = spyExecutor();
    const c = testController("http://127.0.0.1:9", { executor: spy.executor });

    await c.reconciler.reconcileOne(id);

    expect(spy.tracks).toEqual([]);
    expect(spy.patches).toBe(0);
  });

  it("track lại bị từ chối (trần 3 flag) ⇒ lý do HOLD nói đúng điều đó", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { stepPercent: 10 });
    const spy = spyExecutor({
      status: "LIMIT",
      message: "Environment đã có 3 flag đang gắn nhãn",
    });
    const c = testController("http://127.0.0.1:9", { executor: spy.executor });

    await c.reconciler.reconcileOne(id);

    expect((await sessionState(id)).lastDecision?.reason).toMatch(
      /đã đủ flag gắn nhãn — Environment đã có 3 flag/,
    );
    expect(spy.patches).toBe(0);
  });

  it("flag bị TẮT sau khi tạo ⇒ lý do nói flag tắt, không đổ cho hook", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { stepPercent: 10 });
    await admin.$executeRaw`UPDATE flag_env_configs SET is_enabled = false WHERE id = ${target.envConfigId}::uuid`;
    const c = testController("http://127.0.0.1:9", {
      executor: spyExecutor().executor,
    });

    await c.reconciler.reconcileOne(id);

    expect((await sessionState(id)).lastDecision?.reason).toMatch(/đang TẮT/);
  });

  it("HOLD của pha 2 theo nhịp phân tích: lượt kế trong analysisInterval là idle, không probe lại", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { stepPercent: 10 });
    const spy = spyExecutor();
    const c = testController("http://127.0.0.1:9", { executor: spy.executor });

    await c.reconciler.reconcileOne(id);
    c.clock.advance(5_000);
    await c.reconciler.reconcileOne(id);
    expect(spy.tracks).toHaveLength(1);

    // Nhãn xuất hiện; qua nhịp phân tích ⇒ bậc đầu
    seedLabel(c.provider, target.flagKey);
    c.clock.advance(30_000);
    await c.reconciler.reconcileOne(id);
    expect(spy.patches).toBe(1);
    expect((await sessionState(id)).status).toBe("IN_PROGRESS");
  });

  it("nguồn metrics chết quá labelWaitSeconds ⇒ vẫn PENDING — không đổ cho app khi không hỏi được", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, {
      stepPercent: 10,
      createdAt: new Date(
        Date.now() - (ROLLOUT_TIMING.labelWaitSeconds + 60) * 1000,
      ),
    });
    const spy = spyExecutor();
    const c = testController("http://127.0.0.1:9", { executor: spy.executor });
    c.provider.setReachable(false);

    await c.reconciler.reconcileOne(id);

    const state = await sessionState(id);
    expect(state.status).toBe("PENDING");
    expect(state.lastDecision?.reason).toMatch(/không tới được/);
    expect(spy.tracks).toEqual([]);
  });

  it("nguồn metrics truy vấn hỏng ⇒ HOLD nói đúng nguyên nhân, không gọi track", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { stepPercent: 10 });
    const spy = spyExecutor();
    const c = testController("http://127.0.0.1:9", { executor: spy.executor });
    c.provider.setQueryFailing(true);

    await c.reconciler.reconcileOne(id);

    expect((await sessionState(id)).lastDecision?.reason).toMatch(
      /truy vấn probe hỏng/,
    );
    expect(spy.tracks).toEqual([]);
    expect(spy.patches).toBe(0);
  });

  it("quá labelWaitSeconds mà chưa thấy nhãn ⇒ FAILED/EXPIRED, không PATCH, không DeploymentEvent", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, {
      stepPercent: 10,
      createdAt: new Date(
        Date.now() - (ROLLOUT_TIMING.labelWaitSeconds + 60) * 1000,
      ),
    });
    const spy = spyExecutor();
    const c = testController("http://127.0.0.1:9", { executor: spy.executor });

    await c.reconciler.reconcileOne(id);

    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "EXPIRED",
      currentTrafficPercentage: 0,
    });
    const [event] = await executionEvents(id);
    expect(event).toMatchObject({ action: "EXPIRE", triggeredBy: "AUTO" });
    expect(spy.patches).toBe(0);
    expect(
      await admin.deploymentEvent.count({ where: { rolloutSessionId: id } }),
    ).toBe(0);
  });
});

describe("intent trên rollout chưa bắt đầu (§7.6 dòng PENDING)", () => {
  it("ROLLBACK ⇒ HUỶ: FAILED/MANUAL, không PATCH, không DeploymentEvent, intent được đánh dấu", async () => {
    const target = await newTarget(project, 30);
    const id = await newSession(target, {
      stepPercent: 10,
      baselinePercent: 30,
      currentPercent: 30,
    });
    const intent = await newIntent(id, "ROLLBACK", project.ownerId, 30);
    const spy = spyExecutor();
    const c = testController("http://127.0.0.1:9", { executor: spy.executor });

    await c.reconciler.reconcileOne(id);

    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "MANUAL",
      currentTrafficPercentage: 30,
    });
    const [event] = await executionEvents(id);
    expect(event).toMatchObject({
      action: "ROLLBACK",
      triggeredBy: "MANUAL",
      causedByEventId: intent,
    });
    expect(spy.patches).toBe(0);
    expect(
      await admin.deploymentEvent.count({ where: { rolloutSessionId: id } }),
    ).toBe(0);
    expect(await onPercentOf(target.ruleId, target.on)).toBe(30);
  });

  it("PROMOTE ⇒ bỏ qua có lý do, không PATCH; PAUSE rồi RESUME ⇒ về PENDING, không IN_PROGRESS", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { stepPercent: 10 });
    const spy = spyExecutor();
    const c = testController("http://127.0.0.1:9", { executor: spy.executor });

    const promote = await newIntent(id, "PROMOTE", project.ownerId, 100);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).status).toBe("PENDING");
    expect(spy.patches).toBe(0);
    // Bỏ qua nhưng ĐÃ xử lý — không thì mọi vòng sau nhặt lại nó
    const processed = await admin.rolloutEvent.findUniqueOrThrow({
      where: { id: promote },
      select: { processedAt: true },
    });
    expect(processed.processedAt).not.toBeNull();

    await newIntent(id, "PAUSE", project.ownerId, 0);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).status).toBe("PAUSED");

    await newIntent(id, "RESUME", project.ownerId, 0);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).status).toBe("PENDING");
    expect(spy.patches).toBe(0);
  });
});

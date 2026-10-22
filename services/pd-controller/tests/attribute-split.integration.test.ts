import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@udp/config";
import { startFlagService, type RunningService } from "@udp/test-support";
import { createFlagLevelExecutor } from "../src/executors/flag-level.executor.js";
import {
  seedLabel,
  testController,
  type TestController,
} from "./helpers/controller.js";
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

/**
 * [Plan #46] ATTRIBUTE_SPLIT ở FLAG_LEVEL qua Service 3 THẬT nối Service 2 THẬT (§7.2): một bậc đưa
 * nhóm khớp thuộc tính sang variant mới; không tự quyết dù số xấu hay dwell đã qua; PROMOTE tay đổi
 * variant mặc định của environment (audit mang người bấm); ROLLBACK về baseline như canary.
 */

let s2: RunningService;
let project: Awaited<ReturnType<typeof newProject>>;

const metricsOf = (
  c: TestController,
  flagKey: string,
  onErrors: number,
): void => {
  c.provider.set(`${flagKey}=on`, {
    requests: 3_000,
    errors: onErrors,
    p99Ms: 250,
  });
  c.provider.set(`${flagKey}=off`, {
    requests: 27_000,
    errors: 81,
    p99Ms: 240,
  });
};

/** Session ATTRIBUTE_SPLIT đã qua bậc đầu (nhóm khớp ở 100%) */
async function started(c: TestController) {
  const target = await newTarget(project, 0, "ATTRIBUTE_BASED");
  const id = await newSession(target, {
    strategy: "ATTRIBUTE_SPLIT",
    stepPercent: 100,
    stepIntervalSeconds: 300,
  });
  seedLabel(c.provider, target.flagKey);
  await c.reconciler.reconcileOne(id);
  return { target, id };
}

beforeAll(async () => {
  s2 = await startFlagService();
  project = await newProject();
}, 60_000);

afterAll(async () => {
  await s2.stop();
  await dropProject(project.projectId);
  await admin.$disconnect();
});

describe("ATTRIBUTE_SPLIT — một bậc, không tự quyết", () => {
  it("PENDING ⇒ nhóm khớp sang 100% qua S2; số XẤU và dwell đã qua vẫn chỉ HOLD kèm số đo", async () => {
    const c = testController(s2.baseUrl);
    const { target, id } = await started(c);
    expect(await onPercentOf(target.ruleId, target.on)).toBe(100);
    expect(await sessionState(id)).toMatchObject({
      status: "IN_PROGRESS",
      currentTrafficPercentage: 100,
    });

    // Lỗi gấp 20 lần ở nhánh mới — canary sẽ rollback; ATTRIBUTE_SPLIT thì không
    metricsOf(c, target.flagKey, 600);
    for (let i = 0; i < 3; i += 1) {
      c.clock.advance(400_000);
      await c.reconciler.reconcileOne(id);
    }
    const state = await sessionState(id);
    expect(state).toMatchObject({
      status: "IN_PROGRESS",
      currentTrafficPercentage: 100,
    });
    expect(state.lastDecision?.decision).toBe("HOLD");
    expect(state.lastDecision?.reason).toMatch(/không tự quyết/);
    expect(state.lastDecision?.metricSnapshot?.canary.requestCount).toBe(3_000);
    expect(await onPercentOf(target.ruleId, target.on)).toBe(100);
    expect((await executionEvents(id)).map((e) => e.action)).toEqual([
      "PROMOTE",
    ]);
  });

  it("PROMOTE tay ⇒ variant mặc định của env đổi sang variant mới (audit mang người bấm), DONE, COMPLETE trỏ ý định", async () => {
    const c = testController(s2.baseUrl);
    const { target, id } = await started(c);
    const intent = await newIntent(id, "PROMOTE", project.ownerId, 100);

    await c.reconciler.reconcileOne(id);

    const config = await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: target.envConfigId },
      select: { defaultVariantId: true },
    });
    expect(config.defaultVariantId).toBe(target.on);
    expect((await sessionState(id)).status).toBe("DONE");
    const events = await executionEvents(id);
    expect(events.at(-1)).toMatchObject({
      action: "COMPLETE",
      triggeredBy: "MANUAL",
      causedByEventId: intent,
    });
    const audit = await admin.auditLog.findFirst({
      where: { projectId: project.projectId, targetId: target.envConfigId },
      orderBy: { occurredAt: "desc" },
      select: { actorUserId: true },
    });
    expect(audit?.actorUserId).toBe(project.ownerId);
  });

  it("ROLLBACK tay ⇒ về baseline như canary, FAILED/MANUAL", async () => {
    const c = testController(s2.baseUrl);
    const { target, id } = await started(c);
    await newIntent(id, "ROLLBACK", project.ownerId, 100);

    await c.reconciler.reconcileOne(id);

    expect(await onPercentOf(target.ruleId, target.on)).toBe(0);
    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "MANUAL",
    });
  });
});

describe("ATTRIBUTE_SPLIT — cấu hình sai và S2 từ chối", () => {
  it("rule bị đổi sang ALL giữa chừng ⇒ HOLD kèm lý do, traffic đứng yên", async () => {
    const c = testController(s2.baseUrl);
    const { target, id } = await started(c);
    await admin.flagTargetingRule.update({
      where: { id: target.ruleId },
      data: { ruleType: "ALL", condition: {} },
    });
    metricsOf(c, target.flagKey, 12);
    c.clock.advance(400_000);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).lastDecision?.reason).toMatch(
      /ATTRIBUTE_BASED hoặc SEGMENT/,
    );
    expect(await onPercentOf(target.ruleId, target.on)).toBe(100);
  });

  it("S2 từ chối đổi mặc định ⇒ ý định bị từ chối có lý do, session vẫn chạy", async () => {
    const real = testController(s2.baseUrl);
    const { id } = await started(real);
    const c = testController(s2.baseUrl, {
      executor: {
        ...createFlagLevelExecutor({
          baseUrl: s2.baseUrl,
          secret: env.INTERNAL_SERVICE_SECRET,
        }),
        setDefaultVariant: () =>
          Promise.resolve({
            status: "REJECTED",
            message: "HTTP 404: không có env-config",
          }),
      },
    });
    await newIntent(id, "PROMOTE", project.ownerId, 100);

    await c.reconciler.reconcileOne(id);

    const state = await sessionState(id);
    expect(state.status).toBe("IN_PROGRESS");
    expect(state.lastDecision?.reason).toMatch(/từ chối đổi variant mặc định/);
    const pending = await admin.rolloutEvent.count({
      where: { sessionId: id, isIntent: true, processedAt: null },
    });
    expect(pending).toBe(0);
  });
});

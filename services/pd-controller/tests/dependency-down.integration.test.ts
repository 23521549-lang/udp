import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { metrics } from "../src/core/metrics.js";
import { testController } from "./helpers/controller.js";
import {
  admin,
  dropProject,
  executionEvents,
  newIntent,
  newProject,
  newSession,
  newTarget,
  sessionState,
} from "./helpers/fixture.js";

/**
 * §7.6 — Service 2 không phản hồi khi cần rollback: thử lại tới
 * `rollbackRetrySeconds`, rồi FAILED/DEPENDENCY_DOWN và `udp_rollback_blocked_total`
 * tăng. Không có S2 ở đây có chủ đích: executor trỏ vào một cổng không ai nghe.
 */

let project: Awaited<ReturnType<typeof newProject>>;
const DEAD = "http://127.0.0.1:9";

beforeAll(async () => {
  project = await newProject();
});

afterAll(async () => {
  await dropProject(project.projectId);
  await admin.$disconnect();
});

const blocked = async (): Promise<number> =>
  (await metrics.rollbackBlocked.get()).values[0]?.value ?? 0;

describe("§7.6 — rollback bị chặn vì phụ thuộc chết", () => {
  it("auto-rollback không áp được ⇒ FAILED/DEPENDENCY_DOWN, event, metric tăng", async () => {
    const target = await newTarget(project, 30);
    const id = await newSession(target, {
      status: "IN_PROGRESS",
      currentPercent: 30,
      baselinePercent: 0,
      thresholds: { maxConsecutiveBreaches: 1 },
    });
    // sleep của helper đẩy đồng hồ giả nên vòng retry hết hạn ngay, không chờ thật
    const c = testController(DEAD, { rollbackRetrySeconds: 10 });
    c.provider.set(`${target.flagKey}=on`, {
      requests: 3_000,
      errors: 300,
      p99Ms: 200,
    });
    c.provider.set(`${target.flagKey}=off`, {
      requests: 27_000,
      errors: 81,
      p99Ms: 200,
    });

    const before = await blocked();
    await c.reconciler.reconcileOne(id);
    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "DEPENDENCY_DOWN",
      currentTrafficPercentage: 30,
    });
    expect(await blocked()).toBe(before + 1);
    const [event] = await executionEvents(id);
    expect(event).toMatchObject({
      action: "DEPENDENCY_DOWN",
      trafficPercentage: 30,
    });
  });

  it("ROLLBACK thủ công gặp S2 chết ⇒ DEPENDENCY_DOWN và intent VẪN được đánh dấu đã xử lý", async () => {
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
    });
    const [event] = await executionEvents(id);
    expect(event).toMatchObject({
      action: "DEPENDENCY_DOWN",
      causedByEventId: intent,
    });
    // Session FAILED không bao giờ được claim nữa — intent chưa đánh dấu sẽ treo "đang chờ" mãi
    const row = await admin.rolloutEvent.findUniqueOrThrow({
      where: { id: intent },
      select: { processedAt: true },
    });
    expect(row.processedAt).not.toBeNull();
  });

  it("bậc promote không áp được thì chỉ HOLD với lý do — không FAILED", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { stepPercent: 10 });
    const c = testController(DEAD);
    await c.reconciler.reconcileOne(id);
    const state = await sessionState(id);
    expect(state.status).toBe("PENDING");
    expect(state.lastDecision?.reason).toMatch(/Không áp dụng được/);
  });
});

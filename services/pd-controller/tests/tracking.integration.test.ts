import { env } from "@udp/config";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { metrics } from "../src/core/metrics.js";
import {
  createFlagLevelExecutor,
  type FlagLevelExecutor,
} from "../src/executors/flag-level.executor.js";
import { findUntrackPending } from "../src/tracking/tracking.repository.js";
import { createUntracker } from "../src/tracking/untracker.js";
import { s3, testController } from "./helpers/controller.js";
import {
  admin,
  dropProject,
  newProject,
  newSession,
  newTarget,
  sessionState,
  type Target,
} from "./helpers/fixture.js";
import { startFlagService, type RunningService } from "@udp/test-support";

/**
 * §6.6, §7.7 [v4.3] — rollout kết thúc thì nhãn `ff` được gỡ, qua Service 2 thật.
 *
 * Hai đường: ngay khi reconciler đóng session, và lưới quét theo config cho
 * những lần gọi hỏng (S2 chết — đúng ca kill-switch) hoặc session đã bị xoá.
 */

let s2: RunningService;
let project: Awaited<ReturnType<typeof newProject>>;
const DEAD = "http://127.0.0.1:9";

beforeAll(async () => {
  s2 = await startFlagService();
  project = await newProject();
}, 60_000);

/**
 * Trần 3 flag là theo environment, và mọi ca dùng chung một environment: trả lại
 * chỗ sau mỗi ca bằng tay (không qua S2 — đây là dọn dữ liệu test, không phải
 * hành vi đang kiểm), để một ca hỏng giữa chừng không kéo đổ các ca sau.
 */
afterEach(async () => {
  await admin.$executeRaw`
    UPDATE rollout_sessions SET status = 'DONE'
     WHERE environment_id = ${project.environmentId}::uuid
       AND status IN ('PENDING', 'IN_PROGRESS', 'PAUSED')`;
  await admin.$executeRaw`
    UPDATE flag_env_configs SET is_tracked = false
     WHERE environment_id = ${project.environmentId}::uuid`;
});

afterAll(async () => {
  await s2.stop();
  await dropProject(project.projectId);
  await admin.$disconnect();
});

const tracked = async (target: Target): Promise<boolean> =>
  (
    await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: target.envConfigId },
      select: { isTracked: true },
    })
  ).isTracked;

/** Gắn nhãn qua đúng endpoint Service 1 sẽ gọi */
async function track(sessionId: string): Promise<void> {
  const res = await fetch(
    `${s2.baseUrl}/internal/rollouts/${sessionId}/track`,
    {
      method: "POST",
      headers: { "x-internal-secret": env.INTERNAL_SERVICE_SECRET },
    },
  );
  expect(res.status).toBe(200);
}

const finish = (sessionId: string) =>
  admin.$executeRaw`UPDATE rollout_sessions SET status = 'DONE' WHERE id = ${sessionId}::uuid`;

const failedCount = async (): Promise<number> =>
  (await metrics.untrack.get()).values.find(
    (v) => v.labels.outcome === "failed",
  )?.value ?? 0;

const executorTo = (baseUrl: string): FlagLevelExecutor =>
  createFlagLevelExecutor({
    baseUrl,
    secret: env.INTERNAL_SERVICE_SECRET,
    timeoutMs: 2_000,
  });

/**
 * Trang lớn: database scratch dùng chung với các file test khác, nên config còn
 * sót của chúng không được đẩy config của ca này ra khỏi một lượt quét.
 */
const untrackerTo = (baseUrl: string) =>
  createUntracker({ db: s3, executor: executorTo(baseUrl), batch: 1_000 });

/** Reconciler có gỡ nhãn thật — cùng dây nối như `src/index.ts` */
function controllerWithUntracker() {
  const untracker = untrackerTo(s2.baseUrl);
  const c = testController(s2.baseUrl, {
    onTerminal: (configId) => {
      untracker.afterTerminal(configId);
    },
  });
  return { ...c, untracker };
}

describe("gỡ nhãn ngay khi rollout kết thúc", () => {
  it("PROMOTE thủ công tới 100 ⇒ DONE ⇒ nhãn được gỡ", async () => {
    const target = await newTarget(project, 10);
    const id = await newSession(target, {
      status: "IN_PROGRESS",
      currentPercent: 10,
    });
    await track(id);
    expect(await tracked(target)).toBe(true);

    const c = controllerWithUntracker();
    await admin.rolloutEvent.create({
      data: {
        sessionId: id,
        action: "PROMOTE",
        isIntent: true,
        trafficPercentage: 100,
        triggeredBy: "MANUAL",
        actorUserId: project.ownerId,
      },
    });
    await c.reconciler.reconcileOne(id);
    await c.untracker.stop();

    expect((await sessionState(id)).status).toBe("DONE");
    expect(await tracked(target)).toBe(false);
  });

  it("rollout vẫn đang chạy ⇒ không gỡ", async () => {
    const target = await newTarget(project, 10);
    const id = await newSession(target, {
      status: "IN_PROGRESS",
      currentPercent: 10,
    });
    await track(id);

    const untracker = untrackerTo(s2.baseUrl);
    untracker.afterTerminal(target.envConfigId);
    await untracker.stop();

    expect(await tracked(target)).toBe(true);
  });
});

describe("lưới quét theo config", () => {
  it("chỉ nhặt config đang gắn nhãn mà không còn rollout chạy", async () => {
    const running = await newTarget(project, 0);
    const runningId = await newSession(running, { status: "IN_PROGRESS" });
    await track(runningId);
    const ended = await newTarget(project, 0);
    const endedId = await newSession(ended, { status: "IN_PROGRESS" });
    await track(endedId);
    await finish(endedId);

    const pending = await findUntrackPending(s3, 1_000);
    expect(pending).toContain(ended.envConfigId);
    expect(pending).not.toContain(running.envConfigId);

    await untrackerTo(s2.baseUrl).sweep();
    expect(await tracked(running)).toBe(true);
    expect(await tracked(ended)).toBe(false);
  });

  it("con trỏ keyset: config S2 cứ từ chối không chặn config phía sau", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const target = await newTarget(project, 0);
      const id = await newSession(target, { status: "IN_PROGRESS" });
      await track(id);
      await finish(id);
      ids.push(target.envConfigId);
    }
    const [stuck, behind] = ids.sort();
    if (stuck === undefined || behind === undefined)
      throw new Error("thiếu config");
    expect(await findUntrackPending(s3, 1_000, stuck)).not.toContain(stuck);

    // Config nhỏ nhất luôn hỏng; trang một phần tử — đọc từ đầu mỗi lượt thì kẹt mãi ở nó
    const real = executorTo(s2.baseUrl);
    const untracker = createUntracker({
      db: s3,
      batch: 1,
      executor: {
        untrack: (configId) =>
          configId === stuck
            ? Promise.resolve({
                status: "FAILED",
                message: "từ chối có chủ đích",
              })
            : real.untrack(configId),
      },
    });
    const rounds = (await findUntrackPending(s3, 1_000)).length + 1;
    for (let i = 0; i < rounds; i += 1) await untracker.sweep();

    const [stuckRow, behindRow] = await Promise.all(
      [stuck, behind].map((id) =>
        admin.flagEnvConfig.findUniqueOrThrow({
          where: { id },
          select: { isTracked: true },
        }),
      ),
    );
    expect(stuckRow?.isTracked).toBe(true);
    expect(behindRow?.isTracked).toBe(false);
  });

  it("S2 chết ⇒ giữ nhãn và đếm failed; S2 sống ⇒ gỡ", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { status: "IN_PROGRESS" });
    await track(id);
    await finish(id);

    const before = await failedCount();
    await untrackerTo(DEAD).sweep();
    expect(await tracked(target)).toBe(true);
    expect(await failedCount()).toBeGreaterThan(before);

    await untrackerTo(s2.baseUrl).sweep();
    expect(await tracked(target)).toBe(false);
  });

  it("hàng session đã bị xoá ⇒ vẫn gỡ được, trả lại chỗ trong trần", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { status: "IN_PROGRESS" });
    await track(id);
    await admin.rolloutSession.delete({ where: { id } });

    await untrackerTo(s2.baseUrl).sweep();
    expect(await tracked(target)).toBe(false);
  });
});

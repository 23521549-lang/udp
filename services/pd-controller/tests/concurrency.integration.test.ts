import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedLabel, testController } from "./helpers/controller.js";
import {
  admin,
  dropProject,
  executionEvents,
  newProject,
  newSession,
  newTarget,
  onPercentOf,
  sessionState,
} from "./helpers/fixture.js";
import { startFlagService, type RunningService } from "@udp/test-support";

/**
 * I6 — nhiều replica cùng quét một session: ĐÚNG MỘT bên áp bậc, các bên còn
 * lại nhận 0 hàng ở claim (`FOR UPDATE SKIP LOCKED`), và kết quả trên S2 lẫn DB
 * là của đúng một lần ghi.
 *
 * Ba reconciler dùng ba workerId khác nhau trên cùng pool `udp_s3` — đủ để
 * chứng minh SQL claim loại trừ lẫn nhau, vì loại trừ nằm ở hàng khoá chứ không
 * ở tiến trình.
 */

let s2: RunningService;
let project: Awaited<ReturnType<typeof newProject>>;

beforeAll(async () => {
  s2 = await startFlagService();
  project = await newProject();
}, 60_000);

afterAll(async () => {
  await s2.stop();
  await dropProject(project.projectId);
  await admin.$disconnect();
});

describe("I6 — ba replica, một session", () => {
  it("chỉ một bên bước; không có bậc kép, không có event kép", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { stepPercent: 10 });
    const workers = ["r1", "r2", "r3"].map((w) =>
      testController(s2.baseUrl, { workerId: `${w}:${String(process.pid)}` }),
    );
    seedLabel(
      workers.map((w) => w.provider),
      target.flagKey,
    );

    await Promise.all(workers.map((w) => w.reconciler.reconcileOne(id)));

    expect(await sessionState(id)).toMatchObject({
      status: "IN_PROGRESS",
      currentTrafficPercentage: 10,
      claimedBy: null,
    });
    expect(await onPercentOf(target.ruleId, target.on)).toBe(10);
    expect(await executionEvents(id)).toHaveLength(1);
  });

  it("tick() của ba replica trên nhiều session: mỗi session đúng một bậc", async () => {
    const targets = await Promise.all([
      newTarget(project, 0),
      newTarget(project, 0),
      newTarget(project, 0),
    ]);
    const ids = await Promise.all(
      targets.map((t) => newSession(t, { stepPercent: 25 })),
    );
    const workers = ["t1", "t2", "t3"].map((w) =>
      testController(s2.baseUrl, { workerId: `${w}:${String(process.pid)}` }),
    );
    for (const t of targets) {
      seedLabel(
        workers.map((w) => w.provider),
        t.flagKey,
      );
    }
    await Promise.all(workers.map((w) => w.reconciler.tick()));

    for (const [i, id] of ids.entries()) {
      const t = targets[i];
      if (t === undefined) throw new Error("thiếu target");
      expect((await sessionState(id)).currentTrafficPercentage).toBe(25);
      expect(await onPercentOf(t.ruleId, t.on)).toBe(25);
      expect(await executionEvents(id)).toHaveLength(1);
    }
  });
});

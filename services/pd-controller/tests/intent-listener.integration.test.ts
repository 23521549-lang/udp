import { env } from "@udp/config";
import { createSessionConnector } from "@udp/db";
import { formatRolloutIntentNotice } from "@udp/shared-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FlagLevelExecutor } from "../src/executors/flag-level.executor.js";
import { createIntentListener } from "../src/intent/listener.js";
import { seedLabel, testController } from "./helpers/controller.js";
import {
  admin,
  dropProject,
  newIntent,
  newProject,
  newSession,
  newTarget,
  sessionState,
} from "./helpers/fixture.js";

/**
 * §7.6 [v4.3] — `NOTIFY rollout_intent` đánh thức Service 3 ngay, qua database
 * thật: owner phát như Service 1 sẽ phát, kênh nghe bằng `udp_s3` qua cổng
 * session. Không gọi `tick()` — nếu session đổi trạng thái thì chỉ có thể là nhờ
 * kênh.
 *
 * Intent PAUSE/RESUME không gọi Service 2, nên không cần dựng S2 ở đây.
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

const listenUrl = (): string => {
  const url = env.DATABASE_URL_S3_DIRECT;
  if (url === undefined) {
    throw new Error(
      "thiếu DATABASE_URL_S3_DIRECT — pnpm db:service-login udp_s3",
    );
  }
  return url;
};

const notify = (sessionId: string) =>
  admin.$executeRaw`SELECT pg_notify('rollout_intent', ${formatRolloutIntentNotice({ sessionId })})`;

async function eventually(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

describe("kênh rollout_intent", () => {
  it("intent PAUSE + NOTIFY ⇒ session PAUSED trong vài giây mà không có vòng quét", async () => {
    const target = await newTarget(project, 10);
    const id = await newSession(target, {
      status: "IN_PROGRESS",
      currentPercent: 10,
    });
    const c = testController(DEAD);
    let listening = 0;
    const listener = createIntentListener({
      connect: createSessionConnector(listenUrl()),
      onIntent: (sessionId) => {
        c.reconciler.wake(sessionId);
      },
      onListening: () => {
        listening += 1;
      },
    });
    listener.start();
    try {
      expect(
        await eventually(() => Promise.resolve(listening > 0), 10_000),
      ).toBe(true);

      // Rác trên kênh bị bỏ qua và không làm kênh chết: notify hợp lệ ngay sau vẫn tới
      await admin.$executeRaw`SELECT pg_notify('rollout_intent', 'khong-phai-json')`;

      await newIntent(id, "PAUSE", project.ownerId, 10);
      await notify(id);

      expect(
        await eventually(
          async () => (await sessionState(id)).status === "PAUSED",
          5_000,
        ),
      ).toBe(true);
    } finally {
      await listener.stop();
      await c.reconciler.stop();
    }
  });
});

describe("wake — một khe, không chạy trùng", () => {
  it("wake trong lúc session đang chạy ⇒ chạy lại ĐÚNG một lượt sau đó, không song song", async () => {
    const target = await newTarget(project, 0);
    // Nhịp phân tích 0: mỗi lượt đều thật sự tới executor. Với nhịp thường, lượt
    // chạy lại ngay sau một HOLD là `idle` [v4.4] — đúng, nhưng ca này đếm LƯỢT
    // qua số lần gọi executor.
    const id = await newSession(target, {
      stepPercent: 10,
      analysisIntervalSeconds: 0,
    });

    let concurrent = 0;
    let peak = 0;
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: FlagLevelExecutor = {
      applyTraffic: async () => {
        calls += 1;
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await gate;
        concurrent -= 1;
        return { status: "FAILED", message: "S2 giả chậm" };
      },
      untrack: () => Promise.resolve({ status: "SUCCESS", changed: false }),
      track: () => Promise.resolve({ status: "SUCCESS", changed: false }),
      setDefaultVariant: () => Promise.resolve({ status: "SUCCESS" }),
    };
    const c = testController(DEAD, { executor: slow, maxInFlight: 2 });
    seedLabel(c.provider, target.flagKey);

    try {
      c.reconciler.wake(id);
      // Chờ lượt đầu thật sự tới executor rồi mới đánh thức thêm
      expect(await eventually(() => Promise.resolve(calls === 1), 10_000)).toBe(
        true,
      );
      c.reconciler.wake(id);
      c.reconciler.wake(id);
      release();
      // Lượt đầu + đúng MỘT lượt chạy lại, dù đánh thức hai lần
      expect(await eventually(() => Promise.resolve(calls === 2), 10_000)).toBe(
        true,
      );
    } finally {
      // Ca hỏng giữa chừng không được để lượt treo ở `gate` giữ lease và khe
      release();
      await c.reconciler.stop();
    }
    expect(calls).toBe(2);
    expect(peak).toBe(1);
  });

  it("wake sau stop() ⇒ không claim gì", async () => {
    const target = await newTarget(project, 0);
    const id = await newSession(target, { stepPercent: 10 });
    const c = testController(DEAD);
    await c.reconciler.stop();
    c.reconciler.wake(id);
    await new Promise((r) => setTimeout(r, 500));
    const state = await sessionState(id);
    expect(state.claimedBy).toBeNull();
    expect(state.lastDecision).toBeNull();
  });
});

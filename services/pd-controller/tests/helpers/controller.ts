import { env } from "@udp/config";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import { prisma } from "../../src/core/db.js";
import { createFlagLevelExecutor } from "../../src/executors/flag-level.executor.js";
import { createKillSwitch } from "../../src/executors/kill-switch.js";
import {
  createReconciler,
  type Reconciler,
  type ReconcilerDeps,
} from "../../src/reconciler/reconciler.js";

/**
 * Reconciler cho test: đồng hồ TIÊM VÀO để dwell/analysis/max_duration không
 * phải chờ thật, `sleep` ĐẨY đồng hồ giả thay vì ngủ (không thì `applyWithRetry`
 * thành vòng lặp chặt tới khi test hết giờ nếu S2 trả 5xx), provider giả có
 * kịch bản, executor trỏ tới Service 2 dựng trên cổng ngẫu nhiên. Database là
 * `udp_s3` thật — GRANT thật.
 *
 * `prisma` của src (`s3`) không disconnect trong test: vitest chạy mỗi file
 * trong một tiến trình fork riêng và pool đóng theo tiến trình — cùng cách với
 * flag-service. Chỉ client owner của fixture mới disconnect ở `afterAll`.
 */
export interface Clock {
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
}

export function fakeClock(start = Date.now()): Clock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

export interface TestController {
  reconciler: Reconciler;
  clock: Clock;
  provider: FakeMetricsProvider;
  workerId: string;
}

export type ControllerOptions = Partial<ReconcilerDeps> & {
  clock?: Clock;
  /** Dựng reconciler như trước v4.3 — không có kill-switch */
  withoutKillSwitch?: boolean;
};

export function testController(
  flagServiceUrl: string,
  options: ControllerOptions = {},
): TestController {
  const {
    clock = fakeClock(),
    withoutKillSwitch = false,
    ...overrides
  } = options;
  const provider = new FakeMetricsProvider({ scrapeLagSeconds: 15 });
  const workerId =
    overrides.workerId ??
    `test:${String(process.pid)}:${Math.random().toString(16).slice(2, 8)}`;
  const executor = createFlagLevelExecutor({
    baseUrl: flagServiceUrl,
    secret: env.INTERNAL_SERVICE_SECRET,
    timeoutMs: 5_000,
  });
  const reconciler = createReconciler({
    db: prisma,
    executor,
    providerFor: () => provider,
    now: () => clock.now(),
    sleep: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
    maxInFlight: 3,
    ...(withoutKillSwitch
      ? {}
      : { killSwitch: createKillSwitch({ db: prisma, notify: false }) }),
    ...overrides,
    workerId,
  });
  return { reconciler, clock, provider, workerId };
}

export { prisma as s3 };

/**
 * [v4.4] Cho probe pha 2 thấy lưu lượng mang nhãn `ff` của flag — điều kiện để
 * `start()` áp bậc đầu. Khoá nhánh riêng (`=probe`) không trùng variant nào của
 * fixture, nên không đổi con số mà phân tích đọc của nhánh `on`/`off`.
 */
export function seedLabel(
  providers: FakeMetricsProvider | readonly FakeMetricsProvider[],
  flagKey: string,
): void {
  const list =
    providers instanceof FakeMetricsProvider ? [providers] : providers;
  for (const provider of list) {
    provider.set(`${flagKey}=probe`, { requests: 1, errors: 0 });
  }
}

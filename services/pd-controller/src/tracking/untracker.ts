import { ROLLOUT_TIMING } from "@udp/config";
import { logger } from "@udp/http";
import type { DbClient } from "../core/db.js";
import { errorMessage } from "../core/errors.js";
import { metrics } from "../core/metrics.js";
import type { FlagLevelExecutor } from "../executors/flag-level.executor.js";
import { findUntrackPending } from "./tracking.repository.js";

/**
 * Gỡ nhãn `ff` khi rollout kết thúc (§6.6, §7.7 "S3→S2: untrack") — hai đường,
 * cùng theo CONFIG:
 *
 *   - `afterTerminal(configId)`: ngay khi reconciler đóng session. Best effort,
 *     không chờ, không ném — một lần gọi hỏng không được làm hỏng vòng reconcile.
 *   - `sweep()`: lưới quét, nhịp riêng (`untrackSweepMs`), KHÔNG nằm trong
 *     `tick()` — khi S2 chết, mỗi lần gọi tốn tới hạn chờ của executor, và điều
 *     đó không được làm chậm rollback của session khác.
 *
 * Lưới đi theo con trỏ keyset: mỗi lượt một trang SAU config cuối của lượt
 * trước, hết thì quay về đầu. Luôn đọc từ đầu thì một trang config mà S2 cứ từ
 * chối sẽ chiếm trọn mọi lượt, và config phía sau không bao giờ được gỡ.
 *
 * Service 2 tự bỏ qua config còn rollout đang chạy, nên gọi thừa, gọi lặp hay
 * gọi muộn đều vô hại; lưới không cần trạng thái nào ngoài con trỏ.
 */
export interface Untracker {
  afterTerminal(configId: string): void;
  sweep(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export interface UntrackerDeps {
  db: DbClient;
  executor: FlagLevelExecutor;
  intervalMs?: number;
  batch?: number;
}

export function createUntracker(deps: UntrackerDeps): Untracker {
  const intervalMs = deps.intervalMs ?? ROLLOUT_TIMING.untrackSweepMs;
  const batch = deps.batch ?? ROLLOUT_TIMING.untrackSweepBatch;
  const pending = new Set<Promise<void>>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  /** Config cuối của lượt quét trước; `undefined` = bắt đầu lại từ đầu */
  let cursor: string | undefined;

  const run = async (configId: string): Promise<void> => {
    const outcome = await deps.executor.untrack(configId);
    if (outcome.status === "FAILED") {
      metrics.untrack.inc({ outcome: "failed" });
      logger.warn(
        { configId, reason: outcome.message },
        "Gỡ nhãn chưa được — lưới quét sẽ thử lại",
      );
      return;
    }
    metrics.untrack.inc({ outcome: outcome.changed ? "changed" : "skipped" });
  };

  /** Theo dõi promise để `stop()` chờ được, và không để lỗi nào thả nổi */
  const guard = (work: Promise<void>): void => {
    const guarded = work.catch((err: unknown) => {
      metrics.untrack.inc({ outcome: "failed" });
      logger.error({ reason: errorMessage(err) }, "Gỡ nhãn ném ngoài dự kiến");
    });
    pending.add(guarded);
    void guarded.finally(() => pending.delete(guarded));
  };

  const sweep = async (): Promise<void> => {
    const configIds = await findUntrackPending(deps.db, batch, cursor);
    // Trang chưa đầy = đã tới cuối: lượt sau quay về đầu
    cursor = configIds.length < batch ? undefined : configIds.at(-1);
    for (const configId of configIds) {
      if (stopped) return;
      await run(configId);
    }
  };

  const schedule = (): void => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      guard(sweep().finally(schedule));
    }, intervalMs);
    timer.unref();
  };

  return {
    afterTerminal(configId) {
      if (stopped) return;
      guard(run(configId));
    },
    sweep,
    start() {
      stopped = false;
      schedule();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      await Promise.all(pending);
    },
  };
}

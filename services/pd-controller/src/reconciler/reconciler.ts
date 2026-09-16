import { ROLLOUT_LEASE, ROLLOUT_TIMING } from "@udp/config";
import type { PrismaClient } from "@udp/db";
import { logger } from "@udp/http";
import type { DbClient } from "../core/db.js";
import { metrics } from "../core/metrics.js";
import {
  applyWithRetry,
  weightsFor,
  type ApplyOutcome,
  type FlagLevelExecutor,
} from "../executors/flag-level.executor.js";
import type { MetricsProviderFor } from "../metrics/provider.js";
import {
  findUnprocessedIntent,
  markProcessedOrThrow,
  recordExecution,
  recordRollbackDeployment,
} from "../rollout-session/event.repository.js";
import {
  claim,
  findReconcilable,
  InvalidSessionRowError,
  releaseLease,
  renewLease,
  setLastDecision,
  updateIfVersion,
} from "../rollout-session/session.repository.js";
import { loadFlagTarget, type FlagTarget } from "../rollout-session/target.js";
import type {
  Decision,
  IntentRow,
  SessionRow,
} from "../rollout-session/types.js";
import type { FailReason } from "@udp/db";
import {
  strategyFor as defaultStrategyFor,
  type RolloutStrategy,
  type StrategyFor,
} from "../strategies/index.js";
import { decide, settleGate } from "./decision.js";
import { Fence, FenceAbortedError } from "./fence.js";
import { applyStatusIntent, planIntent } from "./intent-processor.js";
import { keepLease } from "./lease.js";

/**
 * Vòng reconciliation của Service 3 (§7.1) — state-based, idempotent, nhiều
 * replica chạy song song an toàn nhờ bốn lớp: lease theo session, fence trước
 * side effect, `If-Match` ở S2, optimistic lock qua `version`.
 *
 * Thứ tự trong `run` là thứ tự của §7.1, với bốn sửa đổi của v4 giữ nguyên:
 * claim gồm PAUSED, phân tích tách khỏi dwell, fence + version trước side
 * effect, renew thất bại ⇒ abort — và một sửa của v4.2: hết hạn tổng thể được
 * kiểm TRƯỚC nhánh PAUSED/PENDING, không thì session chưa bao giờ bắt đầu được
 * (thiếu cấu hình) hay đang tạm dừng sẽ sống mãi.
 *
 * Mọi phụ thuộc tiêm vào: `now`/`sleep` để test không chờ thật, executor và
 * provider để test trỏ tới S2/Prometheus trên cổng ngẫu nhiên.
 */

export interface ReconcilerDeps {
  db: PrismaClient;
  executor: FlagLevelExecutor;
  providerFor: MetricsProviderFor;
  workerId: string;
  strategyFor?: StrategyFor;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  loopIntervalMs?: number;
  leaseSeconds?: number;
  renewIntervalMs?: number;
  rollbackRetrySeconds?: number;
  /** Số session xử lý đồng thời trong một vòng — theo pool, xem `ROLLOUT_POOL_HEADROOM` */
  maxInFlight?: number;
}

export interface Reconciler {
  /** Một vòng quét: claim mọi session đến hạn, xử lý từng cái, cô lập lỗi */
  tick(): Promise<void>;
  /** Một session — mở ra để test điều khiển từng bước */
  reconcileOne(sessionId: string): Promise<void>;
  start(): void;
  /** Ngừng lên lịch, đóng fence của các session đang giữ với lý do shutdown, CHỜ vòng đang chạy */
  stop(): Promise<void>;
}

/**
 * Kết cục của một lượt `reconcileOne` — nhãn `outcome` của
 * `udp_pd_sessions_processed_total`. Tập hữu hạn, không mang id.
 */
export type Outcome =
  | "intent"
  | "intent-rejected"
  | "paused"
  | "idle"
  | "started"
  | "expired"
  | "hold"
  | "dwell"
  | "promoted"
  | "rolled-back"
  | "dependency-down"
  | "precondition-failed"
  | "version-drift"
  | "invalid-session"
  | "fence-aborted"
  | "error";

export const SHUTDOWN_REASON = "shutdown";

/** Chạy `fn` trên từng phần tử, tối đa `limit` cái cùng lúc, không dừng khi một cái ném */
async function runLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      try {
        await fn(item);
        results.push({ status: "fulfilled", value: undefined });
      } catch (err: unknown) {
        results.push({ status: "rejected", reason: err });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const now = deps.now ?? Date.now;
  const loopIntervalMs = deps.loopIntervalMs ?? ROLLOUT_TIMING.loopIntervalMs;
  const leaseSeconds = deps.leaseSeconds ?? ROLLOUT_LEASE.durationSeconds;
  const renewIntervalMs = deps.renewIntervalMs ?? ROLLOUT_LEASE.renewIntervalMs;
  const rollbackRetryMs =
    (deps.rollbackRetrySeconds ?? ROLLOUT_TIMING.rollbackRetrySeconds) * 1000;
  const maxInFlight = deps.maxInFlight ?? 1;
  const strategyFor = deps.strategyFor ?? defaultStrategyFor;
  const { db, executor, workerId, providerFor } = deps;

  /** Shutdown: cắt ngắn mọi `sleep` đang chờ để fence được kiểm ngay */
  const shutdownSignal = new AbortController();
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
          clearTimeout(timer);
          shutdownSignal.signal.removeEventListener("abort", done);
          resolve();
        }
        shutdownSignal.signal.addEventListener("abort", done);
      }));

  const inFlightFences = new Set<Fence>();
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const done = (outcome: Outcome): void => {
    metrics.sessionsProcessed.inc({ outcome });
  };

  const holdDecision = (
    reason: string,
    snapshot: Decision["metricSnapshot"] = null,
  ): Decision => ({
    decision: "HOLD",
    reason,
    at: now(),
    breach: false,
    breachStreak: 0,
    breachAt: null,
    metricSnapshot: snapshot,
  });

  // ---------------------------------------------------------------- bước ghi

  /** Ghi `last_decision`; lease mất giữa chừng thì dừng vòng thay vì ghi đè */
  const record = async (
    session: SessionRow,
    fence: Fence,
    decision: Decision,
  ): Promise<void> => {
    metrics.decisions.inc({ decision: decision.decision });
    const ok = await setLastDecision(db, session.id, workerId, decision);
    if (!ok) fence.abort("lease lost: setLastDecision trả 0 hàng");
    fence.assert();
  };

  const holdWith = async (
    session: SessionRow,
    fence: Fence,
    reason: string,
    snapshot: Decision["metricSnapshot"] = null,
  ): Promise<Outcome> => {
    await record(session, fence, holdDecision(reason, snapshot));
    return "hold";
  };

  /**
   * Một transaction ghi có `updateIfVersion` bên trong: fence trước, và 0 hàng
   * SAU khi S2 đã nhận PATCH là "không thể xảy ra nếu fence và If-Match đúng" —
   * S2 và DB đã lệch: đếm, log, để vòng sau hội tụ từ trạng thái quan sát được.
   * Vị từ `version = $expected` chính là fence ở phía database.
   */
  const commitFenced = async (
    session: SessionRow,
    fence: Fence,
    write: (tx: DbClient) => Promise<boolean>,
  ): Promise<boolean> => {
    fence.assert();
    const ok = await db.$transaction(write);
    if (!ok) {
      metrics.fencingViolations.inc();
      logger.error(
        { sessionId: session.id, version: fence.version },
        "updateIfVersion 0 hàng SAU khi side effect đã áp — S2 và DB lệch",
      );
    }
    return ok;
  };

  /** Fence → PATCH S2 mang version → DB sau (§7.1 "cluster trước, DB sau") */
  const apply = (
    fence: Fence,
    target: FlagTarget,
    percent: number,
    reason: string,
  ): Promise<ApplyOutcome> =>
    executor.applyTraffic(
      fence,
      {
        ruleId: target.ruleId,
        weights: weightsFor(
          percent,
          target.currentWeights,
          target.targetVariant.id,
        ),
      },
      reason,
    );

  const stepUp = async (
    session: SessionRow,
    fence: Fence,
    target: FlagTarget,
    strategy: RolloutStrategy,
    to: number,
    opts: {
      triggeredBy: "AUTO" | "MANUAL";
      causedByEventId?: string;
      snapshot: Decision["metricSnapshot"];
    },
  ): Promise<Outcome> => {
    const applied = await apply(
      fence,
      target,
      to,
      `${session.id}:${opts.triggeredBy === "AUTO" ? "promote" : "manual-promote"}:${String(to)}`,
    );
    if (applied.status === "PRECONDITION_FAILED") return "precondition-failed";
    if (applied.status === "FAILED") {
      return holdWith(
        session,
        fence,
        `Không áp dụng được: ${applied.message}`,
        opts.snapshot,
      );
    }
    const complete = strategy.isComplete(to);
    const stepAt = new Date(now());
    const ok = await commitFenced(session, fence, async (tx) => {
      const updated = await updateIfVersion(tx, session.id, fence.version, {
        currentTrafficPercentage: to,
        status: complete ? "DONE" : "IN_PROGRESS",
        lastStepAt: stepAt,
      });
      if (!updated) return false;
      await recordExecution(tx, {
        sessionId: session.id,
        action: complete ? "COMPLETE" : "PROMOTE",
        trafficPercentage: to,
        triggeredBy: opts.triggeredBy,
        metricSnapshot: opts.snapshot,
        ...(opts.causedByEventId === undefined
          ? {}
          : { causedByEventId: opts.causedByEventId }),
      });
      if (opts.causedByEventId !== undefined) {
        await markProcessedOrThrow(tx, opts.causedByEventId);
      }
      return true;
    });
    return ok ? "promoted" : "version-drift";
  };

  /**
   * Về BASELINE, không phải về 0 (§7.1): flag đã ổn định ở 30% thì rollback không
   * được tắt luôn 30% đó. Dùng chung cho AUTO_ROLLBACK, MANUAL và EXPIRED — khác
   * nhau ở `fail_reason` và `action` của event.
   */
  const revert = async (
    session: SessionRow,
    fence: Fence,
    target: FlagTarget,
    opts: {
      failReason: FailReason;
      action: "ROLLBACK" | "EXPIRE";
      triggeredBy: "AUTO" | "MANUAL";
      reason: string;
      snapshot: Decision["metricSnapshot"];
      causedByEventId?: string;
    },
  ): Promise<Outcome> => {
    const baseline = session.baselinePercentage;
    if (baseline === null) {
      return holdWith(
        session,
        fence,
        "Thiếu baseline_percentage — không biết rollback về đâu",
        opts.snapshot,
      );
    }
    const deadline = now() + rollbackRetryMs;
    const applied = await applyWithRetry(
      () =>
        apply(
          fence,
          target,
          baseline,
          `${session.id}:${opts.action.toLowerCase()}:${String(baseline)}`,
        ),
      { deadline, now, sleep, fence },
    );
    if (applied.status === "PRECONDITION_FAILED") return "precondition-failed";
    if (applied.status === "FAILED") {
      return dependencyDown(
        session,
        fence,
        applied.message,
        opts.causedByEventId,
      );
    }

    const ok = await commitFenced(session, fence, async (tx) => {
      const updated = await updateIfVersion(tx, session.id, fence.version, {
        currentTrafficPercentage: baseline,
        status: "FAILED",
        failReason: opts.failReason,
      });
      if (!updated) return false;
      await recordExecution(tx, {
        sessionId: session.id,
        action: opts.action,
        trafficPercentage: baseline,
        triggeredBy: opts.triggeredBy,
        reason: opts.reason,
        metricSnapshot: opts.snapshot,
        ...(opts.causedByEventId === undefined
          ? {}
          : { causedByEventId: opts.causedByEventId }),
      });
      await recordRollbackDeployment(tx, {
        projectId: session.projectId,
        environmentId: session.environmentId,
        sessionId: session.id,
        workloadName: session.workloadName,
        triggeredBy: opts.triggeredBy,
        metadata: {
          scope: session.rolloutScope,
          flagKey: target.flagKey,
          targetVariant: target.targetVariant.key,
          from: session.currentTrafficPercentage,
          to: baseline,
          failReason: opts.failReason,
        },
      });
      if (opts.causedByEventId !== undefined) {
        await markProcessedOrThrow(tx, opts.causedByEventId);
      }
      return true;
    });
    return ok ? "rolled-back" : "version-drift";
  };

  /**
   * §7.6: hết `rollbackRetrySeconds` mà S2 vẫn không nhận ⇒ FAILED/DEPENDENCY_DOWN,
   * alert P1. Intent gây ra lần rollback này (nếu có) được đánh dấu đã xử lý:
   * nó ĐÃ được thi hành, kết cục nằm ở event DEPENDENCY_DOWN trỏ về nó — không
   * thì session FAILED không bao giờ được claim nữa và intent treo "đang chờ"
   * mãi trên Portal.
   */
  const dependencyDown = async (
    session: SessionRow,
    fence: Fence,
    message: string,
    causedByEventId?: string,
  ): Promise<Outcome> => {
    metrics.rollbackBlocked.inc();
    logger.error(
      { sessionId: session.id, message },
      "udp_rollback_blocked_total: rollback không áp được, Service 2 không phản hồi",
    );
    const ok = await commitFenced(session, fence, async (tx) => {
      const updated = await updateIfVersion(tx, session.id, fence.version, {
        status: "FAILED",
        failReason: "DEPENDENCY_DOWN",
      });
      if (!updated) return false;
      await recordExecution(tx, {
        sessionId: session.id,
        action: "DEPENDENCY_DOWN",
        trafficPercentage: session.currentTrafficPercentage,
        triggeredBy: "AUTO",
        reason: message,
        ...(causedByEventId === undefined ? {} : { causedByEventId }),
      });
      if (causedByEventId !== undefined) {
        await markProcessedOrThrow(tx, causedByEventId);
      }
      return true;
    });
    return ok ? "dependency-down" : "version-drift";
  };

  // ------------------------------------------------------------- các nhánh

  /** Rule đã bị sửa ngoài luồng rollout? Vòng này vẫn hội tụ từ DB; chỉ cần người vận hành biết */
  const warnDrift = (session: SessionRow, target: FlagTarget): void => {
    if (session.status === "PENDING") return;
    if (
      Math.abs(target.currentPercent - session.currentTrafficPercentage) > 0.005
    ) {
      logger.warn(
        {
          sessionId: session.id,
          ruleId: target.ruleId,
          rulePercent: target.currentPercent,
          sessionPercent: session.currentTrafficPercentage,
        },
        "Trọng số rule lệch với current_traffic_percentage — rule đã bị sửa ngoài rollout",
      );
    }
  };

  /**
   * Mục tiêu và chiến lược của session, hoặc lý do HOLD. Lý do ở đây là CẤU
   * HÌNH (rule ba variant, thiếu workload_name, chiến lược chưa có executor…),
   * không phải lỗi nhất thời.
   */
  const resolve = async (
    session: SessionRow,
  ): Promise<
    | { kind: "ready"; target: FlagTarget; strategy: RolloutStrategy }
    | { kind: "hold"; reason: string }
  > => {
    const strategy = strategyFor(session);
    if (strategy === undefined) {
      return {
        kind: "hold",
        reason: `${session.strategy} ở FLAG_LEVEL chỉ promote/rollback thủ công (§7.2) — chưa có executor`,
      };
    }
    const target = await loadFlagTarget(db, session);
    if (target.kind === "hold") return target;
    warnDrift(session, target);
    return { kind: "ready", target, strategy };
  };

  /**
   * Intent không thi hành được vì CẤU HÌNH: đánh dấu đã xử lý (không thì nó chặn
   * expiry và phân tích của session mãi mãi), và lý do hiện lên `last_decision`
   * để người dùng thấy vì sao nút bấm của mình không có tác dụng.
   */
  const rejectIntent = async (
    session: SessionRow,
    fence: Fence,
    intent: IntentRow,
    reason: string,
  ): Promise<Outcome> => {
    fence.assert();
    await db.$transaction((tx) => markProcessedOrThrow(tx, intent.id));
    await record(
      session,
      fence,
      holdDecision(`Ý định ${intent.action} không thực hiện được: ${reason}`),
    );
    return "intent-rejected";
  };

  const applyIntent = async (
    session: SessionRow,
    fence: Fence,
    intent: IntentRow,
  ): Promise<Outcome> => {
    const plan = planIntent(session, intent);
    if (
      plan.kind === "pause" ||
      plan.kind === "resume" ||
      plan.kind === "ignore"
    ) {
      fence.assert();
      const ok = await applyStatusIntent(db, session, fence, intent, plan);
      if (ok) return "intent";
      metrics.fencingViolations.inc();
      return "version-drift";
    }
    const resolved = await resolve(session);
    if (resolved.kind === "hold") {
      return rejectIntent(session, fence, intent, resolved.reason);
    }
    if (plan.kind === "promote-full") {
      return stepUp(session, fence, resolved.target, resolved.strategy, 100, {
        triggeredBy: "MANUAL",
        causedByEventId: intent.id,
        snapshot: null,
      });
    }
    if (session.baselinePercentage === null) {
      return rejectIntent(
        session,
        fence,
        intent,
        "thiếu baseline_percentage — không biết rollback về đâu",
      );
    }
    return revert(session, fence, resolved.target, {
      failReason: "MANUAL",
      action: "ROLLBACK",
      triggeredBy: "MANUAL",
      reason: "Người dùng yêu cầu rollback",
      snapshot: null,
      causedByEventId: intent.id,
    });
  };

  /** PENDING → áp bậc đầu. Baseline do Service 1 ghi lúc tạo; S3 chỉ đọc (§1.2) */
  const start = async (session: SessionRow, fence: Fence): Promise<Outcome> => {
    const resolved = await resolve(session);
    if (resolved.kind === "hold")
      return holdWith(session, fence, resolved.reason);
    if (session.baselinePercentage === null) {
      return holdWith(
        session,
        fence,
        "Thiếu baseline_percentage — Service 1 phải ghi lúc tạo rollout",
      );
    }
    const first = resolved.strategy.nextPercent(
      session.baselinePercentage,
      session.stepPercent,
    );
    const outcome = await stepUp(
      session,
      fence,
      resolved.target,
      resolved.strategy,
      first,
      { triggeredBy: "AUTO", snapshot: null },
    );
    return outcome === "promoted" ? "started" : outcome;
  };

  const analyse = async (
    session: SessionRow,
    fence: Fence,
  ): Promise<Outcome> => {
    const resolved = await resolve(session);
    if (resolved.kind === "hold")
      return holdWith(session, fence, resolved.reason);
    const { target, strategy } = resolved;

    const provider = providerFor(session);
    const ctx = {
      thresholds: session.thresholds,
      warmUpRequests: session.warmUpRequests,
      metricWindowSeconds: session.metricWindowSeconds,
      lastStepAt: session.lastStepAt,
      scrapeLagSeconds: provider.scrapeLagSeconds,
      previous: session.lastDecision,
      now: now(),
    };
    const gate = settleGate(ctx);
    if (gate !== undefined) return holdWith(session, fence, gate);

    const win = session.metricWindowSeconds;
    const [
      canaryRequests,
      canaryErrors,
      canaryP99,
      baselineRequests,
      baselineErrors,
    ] = await Promise.all([
      provider.requestCount(target.canary, win),
      provider.errorCount(target.canary, win),
      provider.latencyP99(target.canary, win),
      provider.requestCount(target.baseline, win),
      provider.errorCount(target.baseline, win),
    ]);
    const decision = decide(ctx, {
      canaryRequests,
      canaryErrors,
      canaryP99,
      baselineRequests,
      baselineErrors,
    });
    await record(session, fence, decision);

    if (decision.decision === "ROLLBACK") {
      return revert(session, fence, target, {
        failReason: "AUTO_ROLLBACK",
        action: "ROLLBACK",
        triggeredBy: "AUTO",
        reason: decision.reason,
        snapshot: decision.metricSnapshot,
      });
    }
    if (decision.decision === "HOLD") return "hold";

    // PROMOTE chỉ khi đã ở bậc hiện tại đủ lâu (dwell) — tách khỏi nhịp phân tích
    const dwellMs = session.stepIntervalSeconds * 1000;
    if (
      session.lastStepAt !== null &&
      now() - session.lastStepAt.getTime() < dwellMs
    ) {
      return "dwell";
    }
    const to = strategy.nextPercent(
      session.currentTrafficPercentage,
      session.stepPercent,
    );
    return stepUp(session, fence, target, strategy, to, {
      triggeredBy: "AUTO",
      snapshot: decision.metricSnapshot,
    });
  };

  /**
   * Quá `max_duration_seconds` ⇒ FAILED/EXPIRED. Session đã từng áp bậc nào thì
   * revert về baseline; PENDING (chưa áp gì — kể cả vì thiếu cấu hình) thì không
   * có gì để revert: chỉ đóng session, không PATCH, không DeploymentEvent.
   */
  const expire = async (
    session: SessionRow,
    fence: Fence,
  ): Promise<Outcome> => {
    const reason = `Vượt quá max_duration_seconds (${String(session.maxDurationSeconds)}s)`;
    if (session.status === "PENDING") {
      const ok = await commitFenced(session, fence, async (tx) => {
        const updated = await updateIfVersion(tx, session.id, fence.version, {
          status: "FAILED",
          failReason: "EXPIRED",
        });
        if (!updated) return false;
        await recordExecution(tx, {
          sessionId: session.id,
          action: "EXPIRE",
          trafficPercentage: session.currentTrafficPercentage,
          triggeredBy: "AUTO",
          reason: `${reason} mà chưa bắt đầu được`,
        });
        return true;
      });
      return ok ? "expired" : "version-drift";
    }
    const resolved = await resolve(session);
    if (resolved.kind === "hold")
      return holdWith(session, fence, resolved.reason);
    const outcome = await revert(session, fence, resolved.target, {
      failReason: "EXPIRED",
      action: "EXPIRE",
      triggeredBy: "AUTO",
      reason,
      snapshot: session.lastDecision?.metricSnapshot ?? null,
    });
    return outcome === "rolled-back" ? "expired" : outcome;
  };

  // ------------------------------------------------------------- vòng chính

  const run = async (session: SessionRow, fence: Fence): Promise<Outcome> => {
    // 1. Ý định của người dùng luôn được xử lý TRƯỚC phân tích — kể cả khi PAUSED
    const intent = await findUnprocessedIntent(db, session.id);
    if (intent !== undefined) return applyIntent(session, fence, intent);

    // 2. Hết hạn tổng thể — không để rollout treo vô thời hạn, dù PAUSED hay chưa bắt đầu
    if (
      now() - session.createdAt.getTime() >
      session.maxDurationSeconds * 1000
    ) {
      return expire(session, fence);
    }
    if (session.status === "PAUSED") return "paused";
    if (session.status === "PENDING") return start(session, fence);

    // 3. Nhịp phân tích — ĐỘC LẬP với dwell
    const last = session.lastDecision?.at;
    if (
      last !== undefined &&
      now() - last < session.analysisIntervalSeconds * 1000
    ) {
      return "idle";
    }

    // 4-5. Đo, quyết, và promote khi đã ở bậc đủ lâu
    return analyse(session, fence);
  };

  /**
   * Hàng đã claim nhưng không đọc được (thresholds có khoá lạ, last_decision sai
   * hình): ghi lý do cho người dùng thấy rồi NHẢ lease — không thì session bị
   * claim lại mỗi 60 giây, ném lại, và im lặng mãi (đo 12/09/2026 qua QA).
   */
  const rejectInvalidRow = async (
    err: InvalidSessionRowError,
  ): Promise<void> => {
    logger.error(
      { sessionId: err.sessionId, issues: err.message },
      "Session không đọc được — cấu hình sai hình dạng",
    );
    try {
      await setLastDecision(
        db,
        err.sessionId,
        workerId,
        holdDecision(`Cấu hình session không hợp lệ: ${err.message}`),
      );
    } finally {
      await releaseLease(db, err.sessionId, workerId);
    }
  };

  const reconcileOne = async (sessionId: string): Promise<void> => {
    let session: SessionRow | undefined;
    try {
      session = await claim(db, sessionId, workerId, leaseSeconds);
    } catch (err: unknown) {
      if (!(err instanceof InvalidSessionRowError)) throw err;
      await rejectInvalidRow(err).catch((inner: unknown) => {
        logger.error({ err: inner, sessionId }, "Không nhả được session hỏng");
      });
      done("invalid-session");
      return;
    }
    if (session === undefined) {
      // Replica khác đang giữ — SKIP LOCKED; đếm riêng, không phải một lượt xử lý
      metrics.claimFailures.inc();
      return;
    }
    const fence = new Fence(session.id, session.version, workerId);
    const keeper = keepLease(fence, {
      renewIntervalMs,
      leaseMs: leaseSeconds * 1000,
      renew: () => renewLease(db, session.id, workerId, leaseSeconds),
      onLost: (reason) => {
        logger.warn({ sessionId: session.id, reason }, "Mất lease giữa vòng");
      },
      onRenewError: (message) => {
        logger.warn(
          { sessionId: session.id, message },
          "Gia hạn lease ném — thử lại sớm",
        );
      },
    });
    inFlightFences.add(fence);
    metrics.sessionsInFlight.inc();
    try {
      const outcome = await run(session, fence);
      done(outcome);
    } catch (err: unknown) {
      if (err instanceof FenceAbortedError) {
        logger.warn(
          { sessionId: session.id, reason: err.reason },
          "Vòng dừng vì fence",
        );
        done("fence-aborted");
      } else {
        logger.error({ err, sessionId: session.id }, "reconcileOne ném");
        done("error");
      }
    } finally {
      keeper.stop();
      inFlightFences.delete(fence);
      metrics.sessionsInFlight.dec();
      // Mất lease thật thì không đụng (worker khác có thể đã giữ); shutdown thì
      // NHẢ để replica khác nhận ngay, không chờ 60 giây
      if (!fence.aborted || fence.abortReason === SHUTDOWN_REASON) {
        await releaseLease(db, session.id, workerId).catch((err: unknown) => {
          logger.warn({ err, sessionId: session.id }, "Không nhả được lease");
        });
      }
    }
  };

  const tick = async (): Promise<void> => {
    const end = metrics.loopDuration.startTimer();
    try {
      const candidates = await findReconcilable(db);
      const results = await runLimited(candidates, maxInFlight, reconcileOne);
      for (const r of results) {
        // reconcileOne tự bắt lỗi; đây là lưới cho lỗi ngoài nó (claim ném)
        if (r.status === "rejected") {
          logger.error({ err: r.reason as unknown }, "reconcileOne rejected");
          done("error");
        }
      }
    } finally {
      end();
    }
  };

  const schedule = (): void => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = tick()
        .catch((err: unknown) => {
          logger.error({ err }, "Vòng quét của reconciler hỏng");
        })
        .finally(() => {
          inFlight = undefined;
          schedule();
        });
    }, loopIntervalMs);
    timer.unref();
  };

  return {
    tick,
    reconcileOne,
    start() {
      stopped = false;
      schedule();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      for (const fence of inFlightFences) fence.abort(SHUTDOWN_REASON);
      shutdownSignal.abort();
      await inFlight;
    },
  };
}

import { ROLLOUT_LEASE, ROLLOUT_TIMING } from "@udp/config";
import type { Prisma, PrismaClient } from "@udp/db";
import { logger } from "@udp/http";
import type { DbClient } from "../core/db.js";
import { metrics } from "../core/metrics.js";
import {
  applyWithRetry,
  weightsFor,
  type ApplyOutcome,
  type FlagLevelExecutor,
} from "../executors/flag-level.executor.js";
import type {
  KillSwitch,
  KillSwitchOutcome,
} from "../executors/kill-switch.js";
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
import type { Decision, TrackOutcome } from "@udp/shared-types";
import type { IntentRow, SessionRow } from "../rollout-session/types.js";
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
  /** [v4.4] Hạn chờ nhãn `ff` của probe pha 2 — xem `ROLLOUT_TIMING.labelWaitSeconds` */
  labelWaitSeconds?: number;
  /** Số session xử lý đồng thời trong một vòng — theo pool, xem `ROLLOUT_POOL_HEADROOM` */
  maxInFlight?: number;
  /** §7.6 — ghi thẳng `serve` khi S2 chết; vắng thì DEPENDENCY_DOWN giữ traffic nguyên */
  killSwitch?: KillSwitch;
  /**
   * [v4.3] Gọi với env-config của session khi một lượt đóng session FLAG_LEVEL
   * (DONE/FAILED) — nơi gỡ nhãn `ff` (§6.6). Chạy SAU khi lượt đã xong và lease
   * đã nhả; ném thì chỉ log — việc gỡ nhãn có lưới quét riêng.
   */
  onTerminal?: (flagEnvConfigId: string) => void;
}

export interface Reconciler {
  /** Một vòng quét: claim mọi session đến hạn, xử lý từng cái, cô lập lỗi */
  tick(): Promise<void>;
  /** Một session — mở ra để test điều khiển từng bước; không qua semaphore */
  reconcileOne(sessionId: string): Promise<void>;
  /**
   * [v4.3] Xử lý một session NGAY (kênh `rollout_intent`, §7.6) — qua cùng
   * semaphore với vòng quét. Session đang chạy thì chạy lại đúng một lượt sau khi
   * lượt hiện tại xong: intent ghi giữa chừng không phải chờ vòng quét kế.
   */
  wake(sessionId: string): void;
  /**
   * Một vòng quét ngay, ngoài nhịp — sau khi kênh `rollout_intent` (nối lại) nghe
   * được, để bù intent ghi trong lúc kênh đứt. Vòng đang chạy thì không chồng
   * thêm vòng thứ hai; `stop()` chờ nó như vòng theo nhịp.
   */
  nudge(): void;
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
  | "label-wait"
  | "cancelled"
  | "expired"
  | "hold"
  | "dwell"
  | "promoted"
  | "completed"
  | "rolled-back"
  | "dependency-down"
  | "precondition-failed"
  | "version-drift"
  | "invalid-session"
  | "fence-aborted"
  | "error";

export const SHUTDOWN_REASON = "shutdown";

/** Kết cục của lần gọi lại `track` — chỉ để ghi vào lý do HOLD cho người dùng đọc */
function describeTrack(outcome: TrackOutcome): string {
  switch (outcome.status) {
    case "SUCCESS":
      return outcome.changed ? "đã gắn" : "đã có sẵn";
    case "LIMIT":
      return `environment đã đủ flag gắn nhãn — ${outcome.message}`;
    case "REJECTED":
      return `Service 2 từ chối (HTTP ${String(outcome.httpStatus)}): ${outcome.message}`;
    case "UNAVAILABLE":
      return `Service 2 không phản hồi — ${outcome.message}`;
  }
}

/** Một lần đóng session FAILED — xem `closeFailed` */
interface FailedClose {
  failReason: FailReason;
  action: "ROLLBACK" | "EXPIRE" | "DEPENDENCY_DOWN";
  triggeredBy: "AUTO" | "MANUAL";
  reason: string;
  snapshot: Decision["metricSnapshot"];
  causedByEventId?: string;
  /** Có mặt = traffic ĐÃ về `to`; vắng = traffic giữ nguyên, không DeploymentEvent */
  reverted?: {
    to: number;
    target: FlagTarget;
    metadata?: Prisma.InputJsonObject;
  };
}

/** Kết cục mà sau đó session không còn chạy — nhãn `ff` của nó phải được gỡ */
const TERMINAL_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>([
  "completed",
  "cancelled",
  "rolled-back",
  "expired",
  "dependency-down",
]);

const KILL_SWITCH_LABEL: Record<KillSwitchOutcome["status"], string> = {
  APPLIED: "applied",
  STALE: "stale",
  FAILED: "failed",
};

/**
 * Semaphore đếm, MỘT cho cả tiến trình. Vòng quét và `wake()` (kênh
 * `rollout_intent`) cùng xin khe ở đây — hai nhóm worker riêng thì cộng lại vượt
 * `maxInFlight`, pool cạn, lần gia hạn lease chờ khe quá hạn và fence đóng oan.
 */
function createSemaphore(limit: number): {
  acquire(): Promise<void>;
  release(): void;
} {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    acquire() {
      if (active < limit) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    },
    release() {
      const next = waiting.shift();
      // Khe chuyển thẳng cho người chờ — `active` không đổi
      if (next === undefined) active -= 1;
      else next();
    },
  };
}

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const now = deps.now ?? Date.now;
  const loopIntervalMs = deps.loopIntervalMs ?? ROLLOUT_TIMING.loopIntervalMs;
  const leaseSeconds = deps.leaseSeconds ?? ROLLOUT_LEASE.durationSeconds;
  const renewIntervalMs = deps.renewIntervalMs ?? ROLLOUT_LEASE.renewIntervalMs;
  const rollbackRetryMs =
    (deps.rollbackRetrySeconds ?? ROLLOUT_TIMING.rollbackRetrySeconds) * 1000;
  const maxInFlight = deps.maxInFlight ?? 1;
  const labelWaitMs =
    (deps.labelWaitSeconds ?? ROLLOUT_TIMING.labelWaitSeconds) * 1000;
  const strategyFor = deps.strategyFor ?? defaultStrategyFor;
  const { db, executor, workerId, providerFor, killSwitch, onTerminal } = deps;

  /** Shutdown: cắt ngắn mọi `sleep` đang chờ để fence được kiểm ngay */
  const shutdownSignal = new AbortController();
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        // Đã shutdown thì sự kiện `abort` sẽ không bắn lại — trả ngay
        if (shutdownSignal.signal.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(done, ms);
        function done(): void {
          clearTimeout(timer);
          shutdownSignal.signal.removeEventListener("abort", done);
          resolve();
        }
        shutdownSignal.signal.addEventListener("abort", done);
      }));

  const inFlightFences = new Set<Fence>();
  const slots = createSemaphore(Math.max(1, maxInFlight));
  /**
   * Session đang có lượt chạy hoặc đang chờ khe, đăng ký TRƯỚC `claim`: vòng quét
   * bỏ qua chúng, `wake` chỉ đặt cờ chạy lại, `stop()` chờ tất cả.
   */
  const scheduled = new Map<string, { rerun: boolean; done: Promise<void> }>();
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
    if (applied.status === "FAILED" || applied.status === "REJECTED") {
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
    if (!ok) return "version-drift";
    return complete ? "completed" : "promoted";
  };

  /**
   * Trạng thái cuối FAILED, dùng chung cho mọi đường đóng session thất bại:
   * rollback/expire qua S2, kill-switch, DEPENDENCY_DOWN giữ traffic, và expire
   * của session chưa bắt đầu. Một chỗ duy nhất quyết định event, DeploymentEvent
   * và đánh dấu intent — các đường không được trôi khỏi nhau.
   *
   * Trả hàm ghi, chạy trong transaction của bên gọi: `commitFenced` cho đường qua
   * S2, `record` của kill-switch cho đường ghi thẳng. `false` = version đã đổi.
   */
  const closeFailed =
    (session: SessionRow, fence: Fence, close: FailedClose) =>
    async (tx: DbClient): Promise<boolean> => {
      const { reverted } = close;
      const updated = await updateIfVersion(tx, session.id, fence.version, {
        status: "FAILED",
        failReason: close.failReason,
        ...(reverted === undefined
          ? {}
          : { currentTrafficPercentage: reverted.to }),
      });
      if (!updated) return false;
      await recordExecution(tx, {
        sessionId: session.id,
        action: close.action,
        trafficPercentage: reverted?.to ?? session.currentTrafficPercentage,
        triggeredBy: close.triggeredBy,
        reason: close.reason,
        metricSnapshot: close.snapshot,
        ...(close.causedByEventId === undefined
          ? {}
          : { causedByEventId: close.causedByEventId }),
      });
      if (reverted !== undefined) {
        await recordRollbackDeployment(tx, {
          projectId: session.projectId,
          environmentId: session.environmentId,
          sessionId: session.id,
          workloadName: session.workloadName,
          triggeredBy: close.triggeredBy,
          metadata: {
            scope: session.rolloutScope,
            flagKey: reverted.target.flagKey,
            targetVariant: reverted.target.targetVariant.key,
            from: session.currentTrafficPercentage,
            to: reverted.to,
            failReason: close.failReason,
            ...reverted.metadata,
          },
        });
      }
      if (close.causedByEventId !== undefined) {
        await markProcessedOrThrow(tx, close.causedByEventId);
      }
      return true;
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
    if (applied.status === "REJECTED") {
      // S2 sống và từ chối — không phải §7.6 "S2 không phản hồi": giữ nguyên, người vận hành xem lý do
      return holdWith(
        session,
        fence,
        `Rollback bị Service 2 từ chối: ${applied.message}`,
        opts.snapshot,
      );
    }
    if (applied.status === "FAILED") {
      return dependencyDown(session, fence, target, applied.message, opts);
    }

    const ok = await commitFenced(
      session,
      fence,
      closeFailed(session, fence, {
        ...opts,
        reverted: { to: baseline, target },
      }),
    );
    return ok ? "rolled-back" : "version-drift";
  };

  /**
   * [v4.3] Kill-switch (§7.6): ghi thẳng `serve` về baseline, với trạng thái cuối
   * của session ghi TRONG cùng transaction — worker tỉnh muộn lùi cả hai.
   * `undefined` = không dùng được (không cấu hình, thiếu baseline, rollout không
   * có env-config) hoặc cũng hỏng: bên gọi đóng session mà traffic giữ nguyên.
   */
  const tryKillSwitch = async (
    session: SessionRow,
    fence: Fence,
    target: FlagTarget,
    close: Omit<FailedClose, "reverted">,
    intended: FailReason,
  ): Promise<Outcome | undefined> => {
    const baseline = session.baselinePercentage;
    if (
      killSwitch === undefined ||
      baseline === null ||
      session.flagEnvConfigId === null
    ) {
      return undefined;
    }
    const outcome = await killSwitch.apply({
      fence,
      sessionId: session.id,
      environmentId: session.environmentId,
      flagEnvConfigId: session.flagEnvConfigId,
      ruleId: target.ruleId,
      flagKey: target.flagKey,
      targetVariantId: target.targetVariant.id,
      expectedVariantIds: target.currentWeights.map((w) => w.variantId),
      percent: baseline,
      record: closeFailed(session, fence, {
        ...close,
        reason: `kill-switch đã đưa traffic về ${String(baseline)}%: ${close.reason}`,
        reverted: {
          to: baseline,
          target,
          metadata: { intendedFailReason: intended, via: "kill-switch" },
        },
      }),
    });
    metrics.killSwitch.inc({ outcome: KILL_SWITCH_LABEL[outcome.status] });
    if (outcome.status === "APPLIED") return "dependency-down";
    if (outcome.status === "STALE") return "version-drift";
    logger.error(
      { sessionId: session.id, reason: outcome.message },
      "Kill-switch cũng không ghi được — traffic giữ nguyên",
    );
    return undefined;
  };

  /**
   * §7.6: hết `rollbackRetrySeconds` mà S2 vẫn không nhận ⇒ FAILED/DEPENDENCY_DOWN,
   * alert P1 (`udp_rollback_blocked_total` — tăng cả khi kill-switch cứu được, vì
   * S2 chết vẫn là sự cố cần người). Kill-switch trước; không được thì đóng
   * session, traffic giữ nguyên.
   *
   * `fail_reason` là DEPENDENCY_DOWN, còn lý do định rollback (`intended`) đi vào
   * `metadata.intendedFailReason` của DeploymentEvent khi kill-switch áp được.
   * Intent gây ra lần rollback này (nếu có) được đánh dấu đã xử lý: nó ĐÃ được thi
   * hành, kết cục nằm ở event DEPENDENCY_DOWN trỏ về nó — không thì session FAILED
   * không bao giờ được claim nữa và intent treo "đang chờ" mãi trên Portal.
   */
  const dependencyDown = async (
    session: SessionRow,
    fence: Fence,
    target: FlagTarget,
    message: string,
    intended: {
      failReason: FailReason;
      triggeredBy: "AUTO" | "MANUAL";
      snapshot: Decision["metricSnapshot"];
      causedByEventId?: string;
    },
  ): Promise<Outcome> => {
    metrics.rollbackBlocked.inc();
    logger.error(
      { sessionId: session.id, message },
      "udp_rollback_blocked_total: rollback không áp được, Service 2 không phản hồi",
    );
    const close: Omit<FailedClose, "reverted"> = {
      failReason: "DEPENDENCY_DOWN",
      action: "DEPENDENCY_DOWN",
      triggeredBy: intended.triggeredBy,
      reason: message,
      snapshot: intended.snapshot,
      ...(intended.causedByEventId === undefined
        ? {}
        : { causedByEventId: intended.causedByEventId }),
    };

    const saved = await tryKillSwitch(
      session,
      fence,
      target,
      close,
      intended.failReason,
    );
    if (saved !== undefined) return saved;

    const ok = await commitFenced(
      session,
      fence,
      closeFailed(session, fence, close),
    );
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
    if (plan.kind === "cancel") return cancel(session, fence, intent);
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
    const gate = await labelGate(session, fence, resolved.target);
    if (gate !== undefined) return gate;
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

  /**
   * [v4.4] Probe pha 2 (§7.4): bậc đầu chỉ áp khi đã thấy LƯU LƯỢNG mang nhãn
   * `ff` của flag. Hook chỉ gắn nhãn cho flag đã track (§6.6), nên pha này không
   * làm được ở Service 1 lúc tạo — S1 chỉ kiểm được workload (pha 1). Không thấy
   * nhãn mà vẫn áp bậc là chạy mù: phân tích sau đó HOLD vì thiếu dữ liệu, nhưng
   * traffic đã đổi.
   *
   * `undefined` = qua cổng. Chưa qua thì HOLD kèm lý do cụ thể; flag chưa track
   * (S1 chết giữa INSERT và `track`, hoặc `track` hết giờ) thì gọi lại `track` —
   * chỉ khi CHƯA track, vì mỗi lời gọi là một transaction giữ khoá environment
   * bên S2. Quá `labelWaitSeconds` kể từ lúc tạo thì đóng FAILED/EXPIRED: một app
   * thiếu hook không được giữ chỗ trong trần 3 flag suốt 24 giờ.
   */
  const labelGate = async (
    session: SessionRow,
    fence: Fence,
    target: FlagTarget,
  ): Promise<Outcome | undefined> => {
    const probe = await providerFor(session).probe({
      namespace: target.canary.namespace,
      workloadName: target.canary.workloadName,
      flagKey: target.flagKey,
    });
    if (probe.data?.hasSeries === true) return undefined;

    // Không hỏi được thì KHÔNG kết luận gì về app: HOLD, không tính hạn chờ nhãn —
    // Prometheus chết 15 phút không được đóng mọi rollout PENDING với lý do "kiểm
    // hook". `max_duration` vẫn là lưới cuối.
    if (probe.data?.reachable !== true || probe.data.queryFailed) {
      await holdWith(
        session,
        fence,
        probe.data?.reachable === true
          ? "Nguồn metrics sống nhưng truy vấn probe hỏng — chưa áp bậc đầu"
          : "Nguồn metrics không tới được — chưa áp bậc đầu",
      );
      return "label-wait";
    }

    const cause = !target.isEnabled
      ? `flag "${target.flagKey}" đang TẮT ở environment này — hook không gắn nhãn cho flag tắt`
      : `chưa thấy lưu lượng mang nhãn ff của "${target.flagKey}" — SDK đã nhận trackedFlags chưa, hook đã cài chưa (§6.6)?`;
    const waited = now() - session.createdAt.getTime();
    if (waited > labelWaitMs) {
      const ok = await commitFenced(
        session,
        fence,
        closeFailed(session, fence, {
          failReason: "EXPIRED",
          action: "EXPIRE",
          triggeredBy: "AUTO",
          reason: `Sau ${String(labelWaitMs / 1000)}s ${cause}`,
          snapshot: null,
        }),
      );
      return ok ? "expired" : "version-drift";
    }

    const retrack = target.isTracked
      ? ""
      : ` Flag chưa được gắn nhãn — đã gọi lại track: ${describeTrack(await executor.track(session.id))}.`;
    await holdWith(
      session,
      fence,
      `${cause.charAt(0).toUpperCase()}${cause.slice(1)} Chưa áp bậc đầu.${retrack}`,
    );
    return "label-wait";
  };

  /** ROLLBACK trên rollout chưa áp bậc nào (§7.6 dòng PENDING): đóng, không PATCH */
  const cancel = async (
    session: SessionRow,
    fence: Fence,
    intent: IntentRow,
  ): Promise<Outcome> => {
    const ok = await commitFenced(
      session,
      fence,
      closeFailed(session, fence, {
        failReason: "MANUAL",
        action: "ROLLBACK",
        triggeredBy: "MANUAL",
        reason: "Người dùng huỷ rollout chưa bắt đầu — traffic chưa từng đổi",
        snapshot: null,
        causedByEventId: intent.id,
      }),
    );
    return ok ? "cancelled" : "version-drift";
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
      const ok = await commitFenced(
        session,
        fence,
        closeFailed(session, fence, {
          failReason: "EXPIRED",
          action: "EXPIRE",
          triggeredBy: "AUTO",
          reason: `${reason} mà chưa bắt đầu được`,
          snapshot: null,
        }),
      );
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

    // 3. Nhịp phân tích — ĐỘC LẬP với dwell. PENDING cũng theo nhịp này [v4.4]:
    //    mỗi lần `start()` HOLD là một lượt probe (và có thể một lời gọi track),
    //    không được lặp mỗi 5 giây của vòng quét.
    const last = session.lastDecision?.at;
    if (
      last !== undefined &&
      now() - last < session.analysisIntervalSeconds * 1000
    ) {
      return "idle";
    }
    if (session.status === "PENDING") return start(session, fence);

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
    // `stop()` đóng fence của những gì ĐÃ trong tập; claim xong sau đó thì tự đóng
    if (stopped) fence.abort(SHUTDOWN_REASON);
    metrics.sessionsInFlight.inc();
    let outcome: Outcome | undefined;
    try {
      outcome = await run(session, fence);
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
    if (
      outcome !== undefined &&
      TERMINAL_OUTCOMES.has(outcome) &&
      session.flagEnvConfigId !== null
    ) {
      try {
        onTerminal?.(session.flagEnvConfigId);
      } catch (err: unknown) {
        logger.error({ err, sessionId: session.id }, "onTerminal ném");
      }
    }
  };

  /** Một lượt có khe; lặp khi `wake` đặt cờ chạy lại trong lúc đang chạy */
  const enqueue = (sessionId: string): Promise<void> => {
    const existing = scheduled.get(sessionId);
    if (existing !== undefined) {
      existing.rerun = true;
      return existing.done;
    }
    const entry = { rerun: false, done: Promise.resolve() };
    /**
     * Đọc qua hàm, không đọc thẳng trong điều kiện vòng lặp: `wake()` đặt cờ này
     * trong lúc lượt hiện tại đang `await`, điều mà phân tích luồng của TypeScript
     * không thấy — đọc thẳng thì nó thu hẹp cờ về `false` và coi vòng lặp là thừa.
     */
    const wantsRerun = (): boolean => entry.rerun && !stopped;
    entry.done = (async () => {
      do {
        await slots.acquire();
        // Hạ cờ SAU khi có khe: `wake` tới lúc còn chờ khe đã được lượt sắp chạy phủ
        entry.rerun = false;
        try {
          // Đã tắt trong lúc chờ khe: không claim thêm session nào
          if (!stopped) await reconcileOne(sessionId);
        } catch (err: unknown) {
          // reconcileOne tự bắt lỗi của vòng; đây là lưới cho lỗi ngoài nó (claim ném)
          logger.error({ err, sessionId }, "reconcileOne ném ra ngoài");
          done("error");
        } finally {
          slots.release();
        }
      } while (wantsRerun());
    })().finally(() => {
      scheduled.delete(sessionId);
    });
    scheduled.set(sessionId, entry);
    return entry.done;
  };

  const tick = async (): Promise<void> => {
    const end = metrics.loopDuration.startTimer();
    try {
      const candidates = await findReconcilable(db);
      // Session đang có lượt (thường do `wake`) thì để lượt đó lo — không xếp thêm
      await Promise.all(
        candidates.filter((id) => !scheduled.has(id)).map((id) => enqueue(id)),
      );
    } finally {
      end();
    }
  };

  /** Vòng quét có theo dõi: tối đa một vòng một lúc, `stop()` chờ được */
  const runTick = (): Promise<void> => {
    inFlight ??= tick()
      .catch((err: unknown) => {
        logger.error({ err }, "Vòng quét của reconciler hỏng");
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  const schedule = (): void => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runTick().finally(schedule);
    }, loopIntervalMs);
    timer.unref();
  };

  return {
    tick,
    reconcileOne,
    wake(sessionId) {
      if (stopped) return;
      void enqueue(sessionId);
    },
    nudge() {
      if (stopped) return;
      void runTick();
    },
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
      await Promise.all([...scheduled.values()].map((entry) => entry.done));
    },
  };
}

import type { PrismaClient } from "@udp/db";
import type { FailReason } from "@udp/db";
import { ClusterCallFailedError } from "@udp/cluster-access";
import { logger } from "@udp/http";
import type { Decision, DecisionDetail } from "@udp/shared-types";
import type { DbClient } from "../core/db.js";
import type { ClusterAccessProvider } from "../cluster-access/provider.js";
import { ClusterTokenUnavailableError } from "../cluster-access/token-client.js";
import {
  createArgoDriver,
  createFlaggerDriver,
  type DeliveryDriver,
} from "../delivery/drivers.js";
import type { ArgoRollout, Observation } from "../delivery/observe.js";
import type { MetricsProviderFor } from "../metrics/provider.js";
import {
  markProcessedOrThrow,
  recordExecution,
  recordRollbackDeployment,
  recordServiceDeployOutcome,
} from "../rollout-session/event.repository.js";
import { updateIfVersion } from "../rollout-session/session.repository.js";
import type { IntentRow, SessionRow } from "../rollout-session/types.js";
import { decide, settleGate, type HoldReason } from "./decision.js";
import type { Fence } from "./fence.js";
import { applyStatusIntent, planIntent } from "./intent-processor.js";
import type { Outcome } from "./reconciler.js";

/**
 * Nhánh SERVICE_LEVEL của vòng reconciliation (§7.3, §8.5) [Plan #51 QĐ-8] — cùng khung với FLAG_LEVEL (lease,
 * fence, intent trước, hết hạn, nhịp phân tích), khác ở bên chạm traffic: Argo Rollouts hay Flagger, qua đúng
 * quyền `udp-traffic`.
 *
 * - **Soi gương (mọi chế độ)**: trọng số của công cụ ⇒ `current_traffic_percentage`; công cụ xong ⇒ DONE; công cụ
 *   tự huỷ ⇒ FAILED `AUTO_ROLLBACK`. Mỗi lượt tối đa MỘT lần ghi có điều kiện (fence mang một version): lượt soi
 *   gương có thay đổi thì kết thúc ở đó, phân tích ở lượt sau.
 * - **udp-driven**: phân tích phiên bản mới vs cũ (`service_version`); Argo ⇒ promote đúng một bậc khi Rollout
 *   đứng ở bậc session đang chờ; Flagger ⇒ không ghi gì, quyết định nằm ở `last_decision` cho gate đọc.
 * - **tool-driven**: không lời ghi nào ngoài ý định của người dùng (I5).
 *
 * Test chạy trên cụm giả; chạy với controller Argo/Flagger thật trên cluster. Sổ nợ: `service-level-cluster`
 */

type Close = {
  failReason: FailReason;
  action: "ROLLBACK" | "EXPIRE" | "DEPENDENCY_DOWN";
  triggeredBy: "AUTO" | "MANUAL";
  reason: string;
  snapshot: Decision["metricSnapshot"];
  /** [Plan #60 QĐ-1] Mã + số của lý do khi việc đóng đến từ một vòng phân tích (tự rollback) */
  detail?: DecisionDetail | null;
  causedByEventId?: string;
};

export interface ServiceLevelKit {
  db: PrismaClient;
  now: () => number;
  providerFor: MetricsProviderFor;
  clusters: ClusterAccessProvider | undefined;
  record(session: SessionRow, fence: Fence, decision: Decision): Promise<void>;
  holdWith(
    session: SessionRow,
    fence: Fence,
    reason: string,
    snapshot?: Decision["metricSnapshot"],
    detail?: DecisionDetail | null,
  ): Promise<Outcome>;
  holdDecision(
    reason: string,
    snapshot?: Decision["metricSnapshot"],
    detail?: DecisionDetail | null,
  ): Decision;
  commitFenced(
    session: SessionRow,
    fence: Fence,
    write: (tx: DbClient) => Promise<boolean>,
  ): Promise<boolean>;
  rejectIntent(
    session: SessionRow,
    fence: Fence,
    intent: IntentRow,
    reason: string,
  ): Promise<Outcome>;
}

export interface ServiceLevelBranch {
  /** Một lượt PENDING/IN_PROGRESS sau cổng nhịp phân tích */
  run(session: SessionRow, fence: Fence): Promise<Outcome>;
  applyIntent(
    session: SessionRow,
    fence: Fence,
    intent: IntentRow,
  ): Promise<Outcome>;
  expire(session: SessionRow, fence: Fence): Promise<Outcome>;
}

const TOOL_NAME: Record<DeliveryDriver["tool"], string> = {
  "argo-rollouts": "Argo Rollouts",
  flagger: "Flagger",
};

/** Đường vào cluster hỏng: lý do cho người dùng đọc, không bao giờ lỗi gốc (có thể mang token) */
class ClusterUnavailable extends Error {}

export function createServiceLevelBranch(
  kit: ServiceLevelKit,
): ServiceLevelBranch {
  const { db, now } = kit;

  const reasonOf = (session: SessionRow, err: unknown): string => {
    if (err instanceof ClusterUnavailable) return err.message;
    if (err instanceof ClusterTokenUnavailableError) {
      return `Không lấy được token cluster: ${err.message}`;
    }
    if (
      err instanceof ClusterCallFailedError &&
      (err.status === 401 || err.status === 403)
    ) {
      // Token bị từ chối (cluster dựng lại, SA mất quyền): lần sau dựng truy cập lại từ đầu
      kit.clusters?.forget(session.projectId);
      return `API server từ chối Service 3 (HTTP ${String(err.status)}) — kiểm RBAC của udp-traffic (§12.2)`;
    }
    if (err instanceof ClusterCallFailedError) {
      return `API server trả ${String(err.status)} cho ${err.verb}`;
    }
    logger.warn({ err, sessionId: session.id }, "Lời gọi cluster hỏng");
    return "Không nói chuyện được với cluster của project";
  };

  /** Driver của công cụ đang giữ workload: `Rollout` của Argo nếu có, không thì `Canary` của Flagger */
  const driverFor = async (session: SessionRow): Promise<DeliveryDriver> => {
    if (kit.clusters === undefined) {
      throw new ClusterUnavailable(
        "Service 3 không có đường vào cluster — thiếu cấu hình truy cập (ADR-06)",
      );
    }
    if (
      session.workloadName === null ||
      session.versionNew === null ||
      session.versionOld === null
    ) {
      throw new ClusterUnavailable(
        "Session SERVICE_LEVEL thiếu workload hoặc phiên bản — Service 1 phải ghi lúc tạo",
      );
    }
    const environment = await db.environment.findUnique({
      where: { id: session.environmentId },
      select: { k8sNamespace: true },
    });
    if (environment === null) {
      throw new ClusterUnavailable("Environment của session không còn");
    }
    const target = {
      namespace: environment.k8sNamespace,
      workloadName: session.workloadName,
      createdAt: session.createdAt,
    };
    const client = await (
      await kit.clusters.get(session.projectId)
    ).getClient("traffic");
    const rollout = await client.read<ArgoRollout>("get", {
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Rollout",
      namespace: target.namespace,
      name: target.workloadName,
    });
    return rollout === null
      ? createFlaggerDriver(client, target)
      : createArgoDriver(client, target);
  };

  const deployMetadata = (session: SessionRow, extra: object) => ({
    scope: "SERVICE_LEVEL",
    strategy: session.strategy,
    versionOld: session.versionOld,
    versionNew: session.versionNew,
    ...extra,
  });

  const closeDone = async (
    session: SessionRow,
    fence: Fence,
    tool: string,
  ): Promise<Outcome> => {
    const ok = await kit.commitFenced(session, fence, async (tx) => {
      const updated = await updateIfVersion(tx, session.id, fence.version, {
        status: "DONE",
        currentTrafficPercentage: 100,
      });
      if (!updated) return false;
      await recordExecution(tx, {
        sessionId: session.id,
        action: "COMPLETE",
        trafficPercentage: 100,
        triggeredBy: "AUTO",
        reason: `${tool}: phiên bản ${String(session.versionNew)} phục vụ 100%`,
        metricSnapshot: null,
      });
      await recordServiceDeployOutcome(tx, {
        projectId: session.projectId,
        environmentId: session.environmentId,
        sessionId: session.id,
        workloadName: session.workloadName,
        eventType: "DEPLOY_SUCCESS",
        imageTag: session.versionNew,
        triggeredBy: "AUTO",
        metadata: deployMetadata(session, { tool }),
      });
      return true;
    });
    return ok ? "completed" : "version-drift";
  };

  const closeFailed = async (
    session: SessionRow,
    fence: Fence,
    close: Close,
  ): Promise<Outcome> => {
    const ok = await kit.commitFenced(session, fence, async (tx) => {
      const updated = await updateIfVersion(tx, session.id, fence.version, {
        status: "FAILED",
        failReason: close.failReason,
        currentTrafficPercentage: 0,
      });
      if (!updated) return false;
      await recordExecution(tx, {
        sessionId: session.id,
        action: close.action,
        trafficPercentage: 0,
        triggeredBy: close.triggeredBy,
        reason: close.reason,
        reasonDetail: close.detail ?? null,
        metricSnapshot: close.snapshot,
        ...(close.causedByEventId === undefined
          ? {}
          : { causedByEventId: close.causedByEventId }),
      });
      await recordServiceDeployOutcome(tx, {
        projectId: session.projectId,
        environmentId: session.environmentId,
        sessionId: session.id,
        workloadName: session.workloadName,
        eventType: "DEPLOY_FAILURE",
        imageTag: session.versionNew,
        triggeredBy: close.triggeredBy,
        metadata: deployMetadata(session, { failReason: close.failReason }),
      });
      await recordRollbackDeployment(tx, {
        projectId: session.projectId,
        environmentId: session.environmentId,
        sessionId: session.id,
        workloadName: session.workloadName,
        triggeredBy: close.triggeredBy,
        restoresDeploymentId: session.id,
        metadata: deployMetadata(session, {
          from: session.currentTrafficPercentage,
          to: 0,
          failReason: close.failReason,
        }),
      });
      if (close.causedByEventId !== undefined) {
        await markProcessedOrThrow(tx, close.causedByEventId);
      }
      return true;
    });
    const outcomes: Record<Close["action"], Outcome> = {
      ROLLBACK: "rolled-back",
      EXPIRE: "expired",
      DEPENDENCY_DOWN: "dependency-down",
    };
    return ok ? outcomes[close.action] : "version-drift";
  };

  /**
   * Đưa traffic về phiên bản cũ rồi đóng FAILED. Argo: bỏ route header (ATTRIBUTE_SPLIT), rồi abort. Flagger: đóng
   * session là đủ — gate `rollback` mở ở lần Flagger hỏi kế tiếp. Không ghi được abort ⇒ HOLD, ý định (nếu có) CHƯA
   * được đánh dấu nên vòng sau thử lại.
   */
  const rollback = async (
    session: SessionRow,
    fence: Fence,
    driver: DeliveryDriver,
    close: Close,
  ): Promise<Outcome> => {
    if (driver.tool === "argo-rollouts") {
      try {
        fence.assert();
        if (session.strategy === "ATTRIBUTE_SPLIT") {
          await driver.clearHeaderRoute();
        }
        await driver.abort();
      } catch (err: unknown) {
        return kit.holdWith(
          session,
          fence,
          `Chưa rollback được: ${reasonOf(session, err)} — thử lại ở vòng sau`,
          close.snapshot,
        );
      }
    }
    return closeFailed(session, fence, {
      ...close,
      reason:
        driver.tool === "flagger"
          ? `${close.reason} — Flagger rollback ở lần gọi gate kế tiếp`
          : close.reason,
    });
  };

  /**
   * Soi gương: session PENDING ⇒ IN_PROGRESS khi công cụ đã nhận phiên bản mới; trọng số đổi ⇒ ghi kèm `last_step_at`
   * (mốc dwell và mốc "cửa sổ metric nằm trọn sau bậc mới"). `undefined` = không có gì để ghi.
   */
  const mirror = async (
    session: SessionRow,
    fence: Fence,
    obs: Observation,
    driver: DeliveryDriver,
  ): Promise<Outcome | undefined> => {
    const tool = TOOL_NAME[driver.tool];
    const start = session.status === "PENDING";
    /**
     * Argo udp-driven: CHÍNH Service 3 đẩy bậc và ghi trọng số mới ngay khi promote; Rollout cần vài giây để tới
     * đó. Soi gương giữa chừng là kéo session lùi rồi lại tiến (sự kiện nhiễu, `last_step_at` sai) — chỉ đồng bộ
     * khi Rollout ĐỨNG YÊN ở một bậc (promote bị mất, ai đó bấm tay).
     */
    const settling =
      driver.tool === "argo-rollouts" &&
      session.controlMode === "UDP_DRIVEN" &&
      !obs.pausedAtStep;
    const moved =
      !settling &&
      Math.abs(obs.weight - session.currentTrafficPercentage) > 0.005;
    if (!start && !moved) return undefined;
    const ok = await kit.commitFenced(session, fence, async (tx) => {
      const updated = await updateIfVersion(tx, session.id, fence.version, {
        ...(start ? { status: "IN_PROGRESS" as const } : {}),
        ...(moved
          ? {
              currentTrafficPercentage: obs.weight,
              lastStepAt: new Date(now()),
            }
          : {}),
      });
      if (!updated) return false;
      if (moved) {
        await recordExecution(tx, {
          sessionId: session.id,
          action: "PROMOTE",
          trafficPercentage: obs.weight,
          triggeredBy: "AUTO",
          reason: `${tool}: traffic ${String(session.currentTrafficPercentage)}% → ${String(obs.weight)}%`,
          metricSnapshot: null,
        });
      }
      return true;
    });
    return ok ? (start && !moved ? "started" : "mirrored") : "version-drift";
  };

  /** Đo phiên bản mới vs cũ trên cùng cửa sổ (§7.4) — cùng `decide` với FLAG_LEVEL */
  const measure = async (
    session: SessionRow,
    namespaceOf: () => Promise<string>,
  ): Promise<{ gate: HoldReason } | { decision: Decision }> => {
    const provider = kit.providerFor(session);
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
    if (gate !== undefined) return { gate };
    const namespace = await namespaceOf();
    const workloadName = session.workloadName ?? "";
    const canary = {
      namespace,
      workloadName,
      version: session.versionNew ?? "",
    };
    const baseline = {
      namespace,
      workloadName,
      version: session.versionOld ?? "",
    };
    const win = session.metricWindowSeconds;
    const [
      canaryRequests,
      canaryErrors,
      canaryP99,
      baselineRequests,
      baselineErrors,
    ] = await Promise.all([
      provider.requestCount(canary, win),
      provider.errorCount(canary, win),
      provider.latencyP99(canary, win),
      provider.requestCount(baseline, win),
      provider.errorCount(baseline, win),
    ]);
    return {
      decision: decide(ctx, {
        canaryRequests,
        canaryErrors,
        canaryP99,
        baselineRequests,
        baselineErrors,
      }),
    };
  };

  const namespaceOf = (session: SessionRow) => async (): Promise<string> =>
    (
      await db.environment.findUniqueOrThrow({
        where: { id: session.environmentId },
        select: { k8sNamespace: true },
      })
    ).k8sNamespace;

  const run = async (session: SessionRow, fence: Fence): Promise<Outcome> => {
    let driver: DeliveryDriver;
    let obs: Observation | null;
    try {
      driver = await driverFor(session);
      obs = await driver.observe();
    } catch (err: unknown) {
      return kit.holdWith(session, fence, reasonOf(session, err));
    }
    const tool = TOOL_NAME[driver.tool];
    if (obs === null) {
      return kit.holdWith(
        session,
        fence,
        `Không thấy Rollout hay Canary "${String(session.workloadName)}" — đối tượng giao hàng đã bị xoá?`,
      );
    }
    if (obs.phase === "done") return closeDone(session, fence, tool);
    if (obs.phase === "failed") {
      return closeFailed(session, fence, {
        failReason: "AUTO_ROLLBACK",
        action: "ROLLBACK",
        triggeredBy: "AUTO",
        reason: `${tool} đã huỷ phiên bản mới${obs.message === undefined ? "" : `: ${obs.message}`}`,
        snapshot: session.lastDecision?.metricSnapshot ?? null,
      });
    }
    if (obs.phase === "waiting") {
      await kit.holdWith(
        session,
        fence,
        `Chờ ${tool} nhận phiên bản ${String(session.versionNew)}`,
      );
      return "waiting";
    }
    const mirrored = await mirror(session, fence, obs, driver);
    if (mirrored !== undefined) return mirrored;

    if (session.controlMode === "TOOL_DRIVEN") {
      // I5: không một lời ghi nào lên cluster — chỉ ghi lại điều đang thấy cho Portal
      await kit.record(
        session,
        fence,
        kit.holdDecision(
          `tool-driven — ${tool} tự phân tích và tự quyết; UDP soi gương (traffic ${String(obs.weight)}%)`,
        ),
      );
      return "hold";
    }

    if (
      session.strategy === "ATTRIBUTE_SPLIT" &&
      driver.tool === "argo-rollouts" &&
      obs.pausedAtStep &&
      session.trafficMatch !== null
    ) {
      try {
        fence.assert();
        await driver.setHeaderRoute(session.trafficMatch);
      } catch (err: unknown) {
        return kit.holdWith(
          session,
          fence,
          `Chưa đặt được route header: ${reasonOf(session, err)}`,
        );
      }
    }

    const measured = await measure(session, namespaceOf(session));
    if ("gate" in measured)
      return kit.holdWith(
        session,
        fence,
        measured.gate.reason,
        null,
        measured.gate.detail,
      );
    const { decision } = measured;

    if (session.strategy !== "CANARY") {
      // §7.2: ATTRIBUTE_SPLIT và BLUE_GREEN không tự quyết — số đo cho người đọc, promote/rollback bằng tay
      await kit.record(
        session,
        fence,
        kit.holdDecision(
          `${session.strategy} không tự quyết (§7.2) — PROMOTE hay ROLLBACK bằng tay; số đo phiên bản mới vs cũ ở dưới`,
          decision.metricSnapshot,
          { code: "MANUAL_ONLY" },
        ),
      );
      return "hold";
    }
    await kit.record(session, fence, decision);
    if (decision.decision === "ROLLBACK") {
      return rollback(session, fence, driver, {
        failReason: "AUTO_ROLLBACK",
        action: "ROLLBACK",
        triggeredBy: "AUTO",
        reason: decision.reason,
        detail: decision.detail,
        snapshot: decision.metricSnapshot,
      });
    }
    if (decision.decision === "HOLD") return "hold";

    const dwellMs = session.stepIntervalSeconds * 1000;
    if (
      session.lastStepAt !== null &&
      now() - session.lastStepAt.getTime() < dwellMs
    ) {
      return "dwell";
    }
    // Flagger: `last_decision` PROMOTE đã ghi — gate `confirm-traffic-increase` mở ở lần Flagger hỏi kế tiếp
    if (driver.tool === "flagger") return "gate-open";
    if (!obs.pausedAtStep) {
      return kit.holdWith(
        session,
        fence,
        `${tool} đang chuyển bậc — chờ dừng ở bậc kế rồi mới promote`,
        decision.metricSnapshot,
      );
    }
    let promoted;
    try {
      fence.assert();
      promoted = await driver.promote(session.currentTrafficPercentage);
    } catch (err: unknown) {
      return kit.holdWith(
        session,
        fence,
        `Chưa promote được: ${reasonOf(session, err)}`,
        decision.metricSnapshot,
      );
    }
    if (promoted.kind === "stale") return "precondition-failed";
    const to = promoted.to;
    const ok = await kit.commitFenced(session, fence, async (tx) => {
      const updated = await updateIfVersion(tx, session.id, fence.version, {
        currentTrafficPercentage: to,
        lastStepAt: new Date(now()),
      });
      if (!updated) return false;
      await recordExecution(tx, {
        sessionId: session.id,
        action: "PROMOTE",
        trafficPercentage: to,
        triggeredBy: "AUTO",
        metricSnapshot: decision.metricSnapshot,
      });
      return true;
    });
    return ok ? "promoted" : "version-drift";
  };

  const promoteIntent = async (
    session: SessionRow,
    fence: Fence,
    intent: IntentRow,
    driver: DeliveryDriver,
  ): Promise<Outcome> => {
    const tool = TOOL_NAME[driver.tool];
    if (driver.tool === "flagger" && session.controlMode === "TOOL_DRIVEN") {
      return kit.rejectIntent(
        session,
        fence,
        intent,
        "Flagger tự quyết promotion ở chế độ tool-driven — không có API promote (§7.3)",
      );
    }
    if (driver.tool === "argo-rollouts") {
      try {
        fence.assert();
        if (session.strategy === "ATTRIBUTE_SPLIT") {
          await driver.clearHeaderRoute();
        }
        await driver.promoteFull();
      } catch (err: unknown) {
        return kit.holdWith(
          session,
          fence,
          `Chưa promote được: ${reasonOf(session, err)} — thử lại ở vòng sau`,
        );
      }
    }
    const ok = await kit.commitFenced(session, fence, async (tx) => {
      const updated = await updateIfVersion(tx, session.id, fence.version, {
        ...(session.status === "PENDING"
          ? { status: "IN_PROGRESS" as const }
          : {}),
      });
      if (!updated) return false;
      await recordExecution(tx, {
        sessionId: session.id,
        action: "PROMOTE",
        trafficPercentage: session.currentTrafficPercentage,
        triggeredBy: "MANUAL",
        reason:
          driver.tool === "flagger"
            ? "Mở gate của Flagger — Flagger đưa phiên bản mới lên 100% ở các lần hỏi kế tiếp"
            : `${tool}: promote-full — phiên bản mới lên 100%`,
        causedByEventId: intent.id,
      });
      await markProcessedOrThrow(tx, intent.id);
      return true;
    });
    return ok ? "intent" : "version-drift";
  };

  return {
    run,

    async applyIntent(session, fence, intent) {
      if (intent.action === "PAUSE" || intent.action === "RESUME") {
        if (session.controlMode === "TOOL_DRIVEN") {
          return kit.rejectIntent(
            session,
            fence,
            intent,
            "tool-driven: dừng công cụ cần sửa spec của nó, Service 3 chỉ có quyền status (§12.2)",
          );
        }
        const plan = planIntent(session, intent);
        if (
          plan.kind !== "pause" &&
          plan.kind !== "resume" &&
          plan.kind !== "ignore"
        ) {
          return kit.rejectIntent(
            session,
            fence,
            intent,
            "ý định không hợp lệ",
          );
        }
        fence.assert();
        return (await applyStatusIntent(db, session, fence, intent, plan))
          ? "intent"
          : "version-drift";
      }
      let driver: DeliveryDriver;
      try {
        driver = await driverFor(session);
      } catch (err: unknown) {
        return kit.holdWith(
          session,
          fence,
          `Ý định ${intent.action} chờ đường vào cluster: ${reasonOf(session, err)}`,
        );
      }
      if (intent.action === "PROMOTE") {
        return promoteIntent(session, fence, intent, driver);
      }
      return rollback(session, fence, driver, {
        failReason: "MANUAL",
        action: "ROLLBACK",
        triggeredBy: "MANUAL",
        reason: "Người dùng yêu cầu rollback",
        snapshot: null,
        causedByEventId: intent.id,
      });
    },

    async expire(session, fence) {
      const reason = `Vượt quá max_duration_seconds (${String(session.maxDurationSeconds)}s)`;
      let driver: DeliveryDriver;
      try {
        driver = await driverFor(session);
      } catch (err: unknown) {
        // Không vào được cluster để abort: vẫn đóng — nói rõ traffic chưa được đưa về
        return closeFailed(session, fence, {
          failReason: "DEPENDENCY_DOWN",
          action: "DEPENDENCY_DOWN",
          triggeredBy: "AUTO",
          reason: `${reason}; không abort được (${reasonOf(session, err)}) — kiểm workload bằng tay`,
          snapshot: null,
        });
      }
      const outcome = await rollback(session, fence, driver, {
        failReason: "EXPIRED",
        action: "EXPIRE",
        triggeredBy: "AUTO",
        reason,
        snapshot: session.lastDecision?.metricSnapshot ?? null,
      });
      return outcome;
    },
  };
}

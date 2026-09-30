import type {
  DeploymentWire,
  DoraWire,
  RolloutDetailWire,
  RolloutEventWire,
} from "@udp/shared-types/wire";
import { iso, nowIso } from "../clock";
import type { Db, ProjectRecord } from "../db";
import { syncRule } from "../live";
import {
  bodyOf,
  found,
  HttpProblem,
  intParam,
  ok,
  projectOf,
  type Router,
} from "../router";
import { audit } from "./project";

/** Rollout (§7), deployment và DORA (§8.3, §2.2) */

const rolloutOf = (p: ProjectRecord, rolloutId: string): RolloutDetailWire =>
  found(
    p.rollouts.find((r) => r.id === rolloutId),
    "rollout",
  );

const summaryOf = (r: RolloutDetailWire) => ({
  id: r.id,
  environmentId: r.environment.id,
  scope: r.scope,
  strategy: r.strategy,
  status: r.status,
  currentTrafficPercentage: r.currentTrafficPercentage,
  baselinePercentage: r.baselinePercentage,
  flagKey: r.flag?.key ?? null,
  workloadName: r.workloadName,
  failReason: r.failReason ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

function event(
  db: Db,
  r: RolloutDetailWire,
  action: RolloutEventWire["action"],
  reason: string,
  manual: boolean,
): void {
  const at = nowIso();
  r.events.push({
    id: crypto.randomUUID(),
    action,
    isIntent: manual,
    processedAt: at,
    trafficPercentage: r.currentTrafficPercentage,
    reason,
    triggeredBy: manual ? "MANUAL" : "AUTO",
    actorUserId: manual ? db.me.id : null,
    causedByEventId: null,
    metricSnapshot: r.latestMetricSnapshot ?? null,
    createdAt: at,
  });
  r.updatedAt = at;
}

function setTracked(
  p: ProjectRecord,
  r: RolloutDetailWire,
  tracked: boolean,
): void {
  if (r.flag === undefined) return;
  const flag = p.flags.find((f) => f.detail.id === r.flag?.id);
  const env = flag?.detail.envs.find(
    (e) => e.environment.id === r.environment.id,
  );
  if (env !== undefined) env.isTracked = tracked;
}

function act(
  db: Db,
  p: ProjectRecord,
  r: RolloutDetailWire,
  action: string,
): void {
  const live = p.liveRollouts[r.id];
  switch (action) {
    case "PAUSE":
      if (r.status !== "IN_PROGRESS") break;
      r.status = "PAUSED";
      event(db, r, "PAUSE", `Tạm dừng bởi ${db.me.name}`, true);
      break;
    case "RESUME":
      if (r.status !== "PAUSED") break;
      r.status = "IN_PROGRESS";
      if (live !== undefined) {
        live.startedAt = Date.now();
        live.from = r.currentTrafficPercentage;
      }
      event(db, r, "RESUME", `Tiếp tục bởi ${db.me.name}`, true);
      break;
    case "PROMOTE": {
      if (r.status !== "IN_PROGRESS" && r.status !== "PAUSED") break;
      const next = Math.min(100, r.currentTrafficPercentage + r.stepPercent);
      r.currentTrafficPercentage = next;
      r.baselinePercentage =
        r.strategy === "CANARY" ? 100 - next : r.baselinePercentage;
      if (live !== undefined) {
        live.startedAt = Date.now();
        live.from = next;
        live.upTo = Math.max(live.upTo, next);
        syncRule(p, live, next);
      }
      if (next >= 100) {
        r.status = "DONE";
        event(
          db,
          r,
          "COMPLETE",
          `Promote thủ công lên 100% bởi ${db.me.name}`,
          true,
        );
        delete p.liveRollouts[r.id];
        setTracked(p, r, false);
      } else {
        event(
          db,
          r,
          "PROMOTE",
          `Promote thủ công lên ${String(next)}% bởi ${db.me.name}`,
          true,
        );
      }
      break;
    }
    case "ROLLBACK":
      if (r.status === "DONE" || r.status === "FAILED") break;
      r.status = "FAILED";
      r.currentTrafficPercentage = 0;
      r.baselinePercentage =
        r.strategy === "CANARY" ? 100 : r.baselinePercentage;
      r.failReason = `Rollback thủ công bởi ${db.me.name}`;
      if (live !== undefined) syncRule(p, live, 0);
      delete p.liveRollouts[r.id];
      setTracked(p, r, false);
      event(db, r, "ROLLBACK", r.failReason, true);
      break;
    default:
      throw new HttpProblem(
        422,
        "UNKNOWN_ACTION",
        `Hành động "${action}" không có`,
      );
  }
  // Như Service 1: mọi nút của người dùng là MỘT intent ghi vào session
  audit(
    db,
    p,
    "rollout.intent",
    "rollout_session",
    r.id,
    null,
    { action, trafficPercentage: r.currentTrafficPercentage },
    r.environment.id,
  );
}

interface CreateBody {
  scope: "FLAG_LEVEL" | "SERVICE_LEVEL";
  envId: string;
  strategy: RolloutDetailWire["strategy"];
  controlMode?: RolloutDetailWire["controlMode"];
  flagEnvConfigId?: string;
  targetingRuleId?: string;
  targetVariantId?: string;
  workloadName: string;
  imageTag?: string;
  stepPercent: number;
  stepIntervalSeconds: number;
  analysisIntervalSeconds: number;
  warmUpRequests: number;
  thresholds: Record<string, number>;
}

function create(db: Db, p: ProjectRecord, body: CreateBody): RolloutDetailWire {
  const env = found(
    p.environments.find((e) => e.id === body.envId),
    "environment",
  );
  const busy = p.rollouts.find(
    (r) =>
      r.environment.id === env.id &&
      (r.status === "IN_PROGRESS" || r.status === "PAUSED") &&
      (body.scope === "SERVICE_LEVEL"
        ? r.workloadName === body.workloadName && r.scope === "SERVICE_LEVEL"
        : r.flag?.id !== undefined &&
          r.flag.targetingRuleId === body.targetingRuleId),
  );
  if (busy !== undefined) {
    throw new HttpProblem(
      409,
      "ROLLOUT_IN_PROGRESS",
      "Đã có một rollout đang chạy cho đúng đối tượng này",
    );
  }
  const flag = p.flags.find((f) =>
    f.detail.envs.some((e) => e.configId === body.flagEnvConfigId),
  );
  const target = flag?.detail.variants.find(
    (v) => v.id === body.targetVariantId,
  );
  const other = flag?.detail.variants.find(
    (v) => v.id !== body.targetVariantId,
  );
  const at = nowIso();
  const percent = body.strategy === "ATTRIBUTE_SPLIT" ? 100 : body.stepPercent;
  const rollout: RolloutDetailWire = {
    id: crypto.randomUUID(),
    projectId: p.project.id,
    environment: { id: env.id, name: env.name, isProduction: env.isProduction },
    scope: body.scope,
    controlMode: body.controlMode ?? "udp-driven",
    strategy: body.strategy,
    status: "IN_PROGRESS",
    currentTrafficPercentage: percent,
    baselinePercentage: body.strategy === "CANARY" ? 100 - percent : null,
    ...(flag === undefined ||
    target === undefined ||
    body.targetingRuleId === undefined
      ? {}
      : {
          flag: {
            id: flag.detail.id,
            key: flag.detail.key,
            targetVariant: target.key,
            targetingRuleId: body.targetingRuleId,
          },
        }),
    workloadName: body.workloadName,
    ...(body.imageTag === undefined
      ? {}
      : { versionNew: body.imageTag, versionOld: "đang chạy" }),
    thresholds: body.thresholds,
    stepPercent: body.stepPercent,
    stepIntervalSeconds: body.stepIntervalSeconds,
    analysisIntervalSeconds: body.analysisIntervalSeconds,
    warmUpRequests: body.warmUpRequests,
    metricWindowSeconds: 60,
    maxDurationSeconds: 86_400,
    lastDecision: {
      decision: "HOLD",
      reason: `Warm-up: chờ đủ ${String(body.warmUpRequests)} request ở nhánh canary`,
      breach: false,
      breachStreak: 0,
      breachAt: null,
      at,
    },
    events: [],
    createdAt: at,
    updatedAt: at,
  };
  p.rollouts.unshift(rollout);
  setTracked(p, rollout, true);
  if (
    flag !== undefined &&
    target !== undefined &&
    other !== undefined &&
    body.targetingRuleId !== undefined &&
    body.strategy === "CANARY"
  ) {
    const live = {
      startedAt: Date.now(),
      from: percent,
      step: body.stepPercent,
      everySeconds: 40,
      upTo: Math.min(100 - body.stepPercent, 90),
      flagId: flag.detail.id,
      ruleId: body.targetingRuleId,
      targetVariantId: target.id,
      otherVariantId: other.id,
    };
    p.liveRollouts[rollout.id] = live;
    syncRule(p, live, percent);
  }
  audit(
    db,
    p,
    "rollout.create",
    "rollout_session",
    rollout.id,
    null,
    {
      scope: body.scope,
      strategy: body.strategy,
      workloadName: body.workloadName,
      stepPercent: body.stepPercent,
    },
    env.id,
  );
  return rollout;
}

// ------------------------------------------------------------- DORA

const MS_DAY = 86_400_000;

/** Median của một dãy — `null` khi rỗng */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Lead time mô phỏng: từ commit tới deploy, ổn định theo id (1–6 giờ) */
const leadTimeOf = (d: DeploymentWire): number => {
  let h = 0;
  for (const ch of d.deploymentId) h = (h * 31 + ch.charCodeAt(0)) % 18_000;
  return 3_600 + h;
};

export function doraOf(
  list: readonly DeploymentWire[],
  envId: string,
  days: number,
): DoraWire {
  const to = Date.now();
  const from = to - days * MS_DAY;
  const inWindow = list.filter((d) => Date.parse(d.startedAt) >= from);
  const successes = inWindow.filter((d) => d.status === "DEPLOY_SUCCESS");
  const failures = inWindow.filter((d) => d.status === "DEPLOY_FAILURE");
  const rollbacks = inWindow.filter((d) => d.status === "ROLLBACK");
  const chronological = [...inWindow].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  const recoveries = chronological.flatMap((d, i) => {
    if (d.status !== "DEPLOY_FAILURE") return [];
    const next = chronological
      .slice(i + 1)
      .find((x) => x.status === "DEPLOY_SUCCESS" || x.status === "ROLLBACK");
    return next === undefined
      ? []
      : [(Date.parse(next.lastEventAt) - Date.parse(d.lastEventAt)) / 1000];
  });
  const concluded = successes.length + failures.length;
  const rework = rollbacks.length;
  return {
    environmentId: envId,
    window: { from: iso(from), to: iso(to), days },
    deployments: successes.length,
    deploymentFrequencyPerDay: successes.length / days,
    leadTimeSeconds: {
      median: median(successes.map(leadTimeOf)),
      samples: successes.length,
    },
    changeFailureRate: {
      value: concluded === 0 ? null : failures.length / concluded,
      failed: failures.length,
      total: concluded,
    },
    recoveryTimeSeconds: {
      median: median(recoveries),
      samples: recoveries.length,
    },
    reworkRate: {
      value: concluded === 0 ? null : rework / concluded,
      rework,
      total: concluded,
    },
    rollbacks: {
      auto: rollbacks.filter((d) => d.triggeredBy === "AUTO").length,
      manual: rollbacks.filter((d) => d.triggeredBy !== "AUTO").length,
    },
  };
}

export function registerDeliveryRoutes(router: Router, db: Db): void {
  router
    .on("GET", "/projects/:id/rollouts", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const envId = req.query.get("envId");
      const status = req.query.get("status");
      const limit = intParam(req.query, "limit", 100);
      const list = p.rollouts
        .filter((r) => envId === null || r.environment.id === envId)
        .filter((r) => status === null || r.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(summaryOf);
      return ok({ rollouts: list });
    })
    .on("POST", "/projects/:id/rollouts/probe", () =>
      ok({
        probe: {
          reachable: true,
          hasSeries: true,
          scrapeIntervalSec: 15,
          scrapeIntervalSource: "workload",
          minMetricWindowSeconds: 60,
        },
      }),
    )
    .on("POST", "/projects/:id/rollouts", (req, [id = ""]) => {
      const p = projectOf(db, id);
      return ok({ rollout: create(db, p, bodyOf<CreateBody>(req)) }, 201);
    })
    .on(
      "GET",
      "/projects/:id/rollouts/:rolloutId",
      (_req, [id = "", rolloutId = ""]) =>
        ok({ rollout: rolloutOf(projectOf(db, id), rolloutId) }),
    )
    .on(
      "GET",
      "/projects/:id/rollouts/:rolloutId/events",
      (_req, [id = "", rolloutId = ""]) =>
        ok({ events: rolloutOf(projectOf(db, id), rolloutId).events }),
    )
    .on(
      "POST",
      "/projects/:id/rollouts/:rolloutId/actions",
      (req, [id = "", rolloutId = ""]) => {
        const p = projectOf(db, id);
        const { action } = bodyOf<{ action: string }>(req);
        act(db, p, rolloutOf(p, rolloutId), action);
        return ok({ intentId: crypto.randomUUID(), status: "accepted" }, 202);
      },
    )

    // ---------------------------------------------------------- deployment
    .on("GET", "/projects/:id/deployments", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const envId = req.query.get("envId") ?? "";
      const limit = intParam(req.query, "limit", 50);
      return ok({ deployments: (p.deployments[envId] ?? []).slice(0, limit) });
    })
    .on("GET", "/projects/:id/deployments/latest", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const envId = req.query.get("envId") ?? "";
      return ok({ deployment: p.deployments[envId]?.[0] ?? null });
    })
    .on(
      "GET",
      "/projects/:id/deployments/:deploymentId/logs",
      (_req, [id = "", deploymentId = ""]) => {
        const p = projectOf(db, id);
        return ok({
          deploymentId,
          events: found(p.deploymentLogs[deploymentId], "lần deploy"),
        });
      },
    )
    .on(
      "POST",
      "/projects/:id/deployments/:deploymentId/approve",
      (_req, [id = "", deploymentId = ""]) => {
        const p = projectOf(db, id);
        const entry = Object.entries(p.deployments).find(([, list]) =>
          list.some((d) => d.deploymentId === deploymentId),
        );
        const deployment = found(
          entry?.[1].find((d) => d.deploymentId === deploymentId),
          "lần deploy",
        );
        if (deployment.status !== "DEPLOY_PENDING") {
          return ok({ deploymentId, status: "duplicate" });
        }
        const started = {
          id: crypto.randomUUID(),
          eventType: "DEPLOY_START" as const,
          occurredAt: nowIso(),
        };
        const done = {
          id: crypto.randomUUID(),
          eventType: "DEPLOY_SUCCESS" as const,
          occurredAt: nowIso(),
        };
        deployment.events.push(started, done);
        deployment.status = "DEPLOY_SUCCESS";
        deployment.triggeredBy = "MANUAL";
        deployment.lastEventAt = done.occurredAt;
        const base = {
          triggeredBy: "MANUAL" as const,
          workloadName: deployment.workloadName,
          imageTag: deployment.imageTag,
          commitSha: deployment.commitSha,
          pipelineId: null,
        };
        (p.deploymentLogs[deploymentId] ??= []).push(
          { ...started, ...base, detail: { approvedBy: db.me.email } },
          { ...done, ...base, detail: { readyReplicas: 4 } },
        );
        audit(
          db,
          p,
          "deployment.approve",
          "Deployment",
          deploymentId,
          { status: "DEPLOY_PENDING" },
          { status: "DEPLOY_SUCCESS" },
          entry?.[0] ?? null,
        );
        return ok({ deploymentId, status: "started" });
      },
    )
    .on("GET", "/projects/:id/metrics/dora", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const envId = req.query.get("envId") ?? "";
      const days = Math.min(Math.max(intParam(req.query, "days", 30), 1), 90);
      return ok({ dora: doraOf(p.deployments[envId] ?? [], envId, days) });
    });
}

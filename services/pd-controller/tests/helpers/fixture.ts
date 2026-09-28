import { randomUUID } from "node:crypto";
import { env, TOTAL_BUCKETS } from "@udp/config";
import { createPrismaClient, type Prisma, type PrismaClient } from "@udp/db";
import {
  canonicalizeServe,
  decisionSchema,
  flagServeDbSchema,
  type Decision,
} from "@udp/shared-types";
import { newFlagTarget } from "@udp/test-support";

/**
 * Fixture cho test của Service 3, dựng bằng quyền OWNER (`DATABASE_URL_DIRECT`).
 *
 * `udp_s3` không tạo được project/flag/rule (đúng §1.2), nên fixture đi bằng
 * owner như `rule-ramp` của S2; reconciler dưới test thì nối bằng chính `udp_s3`
 * — đó là điều làm test này kiểm được GRANT thật chứ không phải mock.
 *
 * Rule là phân phối HAI variant (`on`/`off`), đúng hình dạng canary FLAG_LEVEL.
 * Unique index `idx_one_active_rollout_per_target` khoá theo `flag_env_config_id`:
 * mỗi kịch bản cần session mới thì tạo env-config mới (`newTarget`) chứ không
 * xếp hai session sống lên cùng một env-config.
 */

/** Client owner của fixture — mỗi file test là một tiến trình fork nên một khoá cố định là đủ */
export const admin: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: "__udp_prisma_pdtest",
});

export interface Target {
  projectId: string;
  environmentId: string;
  flagId: string;
  flagKey: string;
  envConfigId: string;
  ruleId: string;
  on: string;
  off: string;
  ownerId: string;
}

export async function stableOwner(): Promise<string> {
  const user = await admin.user.findFirstOrThrow({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return user.id;
}

/** Project + environment `dev`; các flag/rule/session treo dưới nó và bị xoá cascade */
export async function newProject(): Promise<{
  projectId: string;
  environmentId: string;
  ownerId: string;
  suffix: string;
}> {
  const ownerId = await stableOwner();
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId,
      name: `pdtest-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-pdtest-${suffix}-dev` },
        ],
      },
    },
    select: { id: true, environments: { select: { id: true } } },
  });
  const environmentId = project.environments[0]?.id;
  if (environmentId === undefined) throw new Error("fixture thiếu environment");
  return { projectId: project.id, environmentId, ownerId, suffix };
}

/** Flag BOOLEAN + env config + rule phân phối on/off, `on` đang ở `onPercent` */
export async function newTarget(
  project: { projectId: string; environmentId: string; ownerId: string },
  onPercent: number,
  ruleType: "ALL" | "ATTRIBUTE_BASED" = "ALL",
): Promise<Target> {
  const flag = await newFlagTarget(admin, project, onPercent, {
    keyPrefix: "pd",
    ruleType,
  });
  return {
    projectId: project.projectId,
    environmentId: project.environmentId,
    ownerId: project.ownerId,
    ...flag,
  };
}

export interface SessionOptions {
  /** [Plan #46] Mặc định CANARY */
  strategy?: "CANARY" | "ATTRIBUTE_SPLIT";
  status?: "PENDING" | "IN_PROGRESS" | "PAUSED";
  currentPercent?: number;
  baselinePercent?: number | null;
  stepPercent?: number;
  stepIntervalSeconds?: number;
  analysisIntervalSeconds?: number;
  metricWindowSeconds?: number;
  warmUpRequests?: number;
  maxDurationSeconds?: number;
  workloadName?: string | null;
  thresholds?: Prisma.InputJsonObject;
  metricQueries?: Prisma.InputJsonObject;
  lastStepAt?: Date | null;
  createdAt?: Date;
}

/**
 * Session đã chạy (IN_PROGRESS, hoặc PAUSED sau khi chạy) luôn có `last_step_at`
 * trên đường thật — chỉ `stepUp` đưa session ra khỏi PENDING, và nó đặt cột này.
 * Fixture để NULL là tạo một trạng thái không tồn tại, mà [v4.4] đọc NULL là
 * "chưa từng áp bậc" (`planIntent`). Một giờ trước: qua mọi dwell và cổng cửa sổ.
 */
function defaultLastStepAt(status: SessionOptions["status"]): Date | null {
  return status === undefined || status === "PENDING"
    ? null
    : new Date(Date.now() - 3_600_000);
}

/** RolloutSession FLAG_LEVEL/CANARY như Service 1 sẽ tạo (Luồng 5), baseline do S1 ghi */
export async function newSession(
  target: Target,
  options: SessionOptions = {},
): Promise<string> {
  const session = await admin.rolloutSession.create({
    data: {
      projectId: target.projectId,
      environmentId: target.environmentId,
      flagEnvConfigId: target.envConfigId,
      targetingRuleId: target.ruleId,
      targetVariantId: target.on,
      workloadName:
        options.workloadName === undefined ? "checkout" : options.workloadName,
      rolloutScope: "FLAG_LEVEL",
      strategy: options.strategy ?? "CANARY",
      controlMode: "UDP_DRIVEN",
      status: options.status ?? "PENDING",
      currentTrafficPercentage: options.currentPercent ?? 0,
      baselinePercentage:
        options.baselinePercent === undefined ? 0 : options.baselinePercent,
      thresholds: options.thresholds ?? {},
      ...(options.metricQueries === undefined
        ? {}
        : { metricQueries: options.metricQueries }),
      stepPercent: options.stepPercent ?? 10,
      stepIntervalSeconds: options.stepIntervalSeconds ?? 300,
      analysisIntervalSeconds: options.analysisIntervalSeconds ?? 30,
      metricWindowSeconds: options.metricWindowSeconds ?? 60,
      warmUpRequests: options.warmUpRequests ?? 100,
      maxDurationSeconds: options.maxDurationSeconds ?? 86_400,
      lastStepAt:
        options.lastStepAt === undefined
          ? defaultLastStepAt(options.status)
          : options.lastStepAt,
      createdById: target.ownerId,
      ...(options.createdAt === undefined
        ? {}
        : { createdAt: options.createdAt }),
    },
    select: { id: true },
  });
  return session.id;
}

/** Intent do "Service 1" ghi — bằng owner, đúng hình dạng §7.6 */
export interface ServiceSessionOptions {
  strategy?: "CANARY" | "ATTRIBUTE_SPLIT" | "BLUE_GREEN";
  controlMode?: "UDP_DRIVEN" | "TOOL_DRIVEN";
  status?: "PENDING" | "IN_PROGRESS" | "PAUSED";
  currentPercent?: number;
  stepPercent?: number;
  stepIntervalSeconds?: number;
  maxDurationSeconds?: number;
  thresholds?: Prisma.InputJsonObject;
  trafficMatch?: { header: string; value: string };
  lastStepAt?: Date | null;
  createdAt?: Date;
}

/**
 * [Plan #51] Session SERVICE_LEVEL như Service 1 ghi lúc tạo: workload `web`, phiên bản `v1` → `v2`, traffic 0
 * (phiên bản mới chưa nhận request nào).
 */
export async function newServiceSession(
  project: { projectId: string; environmentId: string; ownerId: string },
  options: ServiceSessionOptions = {},
): Promise<string> {
  const session = await admin.rolloutSession.create({
    data: {
      projectId: project.projectId,
      environmentId: project.environmentId,
      workloadName: "web",
      rolloutScope: "SERVICE_LEVEL",
      strategy: options.strategy ?? "CANARY",
      controlMode: options.controlMode ?? "UDP_DRIVEN",
      status: options.status ?? "PENDING",
      currentTrafficPercentage: options.currentPercent ?? 0,
      baselinePercentage: 0,
      versionOld: "v1",
      versionNew: "v2",
      ...(options.trafficMatch === undefined
        ? {}
        : { trafficMatch: options.trafficMatch }),
      thresholds: options.thresholds ?? {},
      stepPercent: options.stepPercent ?? 20,
      stepIntervalSeconds: options.stepIntervalSeconds ?? 300,
      analysisIntervalSeconds: 30,
      metricWindowSeconds: 60,
      warmUpRequests: 100,
      maxDurationSeconds: options.maxDurationSeconds ?? 86_400,
      lastStepAt: options.lastStepAt ?? null,
      createdById: project.ownerId,
      ...(options.createdAt === undefined
        ? {}
        : { createdAt: options.createdAt }),
    },
    select: { id: true },
  });
  return session.id;
}

export async function newIntent(
  sessionId: string,
  action: "PAUSE" | "RESUME" | "PROMOTE" | "ROLLBACK",
  actorUserId: string,
  trafficPercentage = 0,
): Promise<string> {
  const event = await admin.rolloutEvent.create({
    data: {
      sessionId,
      action,
      isIntent: true,
      trafficPercentage,
      triggeredBy: "MANUAL",
      actorUserId,
    },
    select: { id: true },
  });
  return event.id;
}

export interface SessionState {
  status: string;
  currentTrafficPercentage: number;
  failReason: string | null;
  version: number;
  claimedBy: string | null;
  lastDecision: Decision | null;
}

export async function sessionState(sessionId: string): Promise<SessionState> {
  const s = await admin.rolloutSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: {
      status: true,
      currentTrafficPercentage: true,
      failReason: true,
      version: true,
      claimedBy: true,
      lastDecision: true,
    },
  });
  return {
    status: s.status,
    currentTrafficPercentage: Number(s.currentTrafficPercentage),
    failReason: s.failReason,
    version: s.version,
    claimedBy: s.claimedBy,
    lastDecision: decisionSchema.nullable().parse(s.lastDecision),
  };
}

export async function executionEvents(sessionId: string): Promise<
  {
    action: string;
    trafficPercentage: number;
    triggeredBy: string;
    causedByEventId: string | null;
  }[]
> {
  const rows = await admin.rolloutEvent.findMany({
    where: { sessionId, isIntent: false },
    orderBy: { createdAt: "asc" },
    select: {
      action: true,
      trafficPercentage: true,
      triggeredBy: true,
      causedByEventId: true,
    },
  });
  return rows.map((r) => ({
    action: r.action,
    trafficPercentage: Number(r.trafficPercentage),
    triggeredBy: r.triggeredBy,
    causedByEventId: r.causedByEventId,
  }));
}

/** Trọng số `on` hiện tại của rule, theo phần trăm */
export async function onPercentOf(
  ruleId: string,
  onId: string,
): Promise<number> {
  const rule = await admin.flagTargetingRule.findUniqueOrThrow({
    where: { id: ruleId },
    select: { serve: true },
  });
  const serve = flagServeDbSchema.parse(rule.serve);
  if (serve.kind !== "distribution") return -1;
  const on = serve.weights.find((w) => w.variantId === onId);
  return on === undefined ? -1 : (on.weight * 100) / TOTAL_BUCKETS;
}

export async function dropProject(projectId: string): Promise<void> {
  await admin.rolloutEvent.deleteMany({ where: { session: { projectId } } });
  await admin.deploymentEvent.deleteMany({ where: { projectId } });
  await admin.configChangeLog.deleteMany({
    where: { environment: { projectId } },
  });
  // [Plan #46] ATTRIBUTE_SPLIT đổi mặc định qua S2 — S2 ghi audit (I40), `Restrict` giữ project
  await admin.auditLog.deleteMany({ where: { projectId } });
  await admin.project.deleteMany({ where: { id: projectId } });
}

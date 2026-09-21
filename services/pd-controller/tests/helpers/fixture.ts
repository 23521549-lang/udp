import { randomUUID } from "node:crypto";
import { env, TOTAL_BUCKETS } from "@udp/config";
import { createPrismaClient, type Prisma, type PrismaClient } from "@udp/db";
import { canonicalizeServe, flagServeDbSchema } from "@udp/shared-types";
import {
  decisionSchema,
  type Decision,
} from "../../src/rollout-session/types.js";

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
): Promise<Target> {
  const key = `pd-${randomUUID().slice(0, 8)}`;
  const flag = await admin.featureFlag.create({
    data: {
      projectId: project.projectId,
      key,
      flagType: "BOOLEAN",
      lifecycleStatus: "ACTIVE",
      variants: {
        create: [
          { key: "on", value: true },
          { key: "off", value: false },
        ],
      },
    },
    select: { id: true, variants: { select: { id: true, key: true } } },
  });
  const on = flag.variants.find((v) => v.key === "on")?.id;
  const off = flag.variants.find((v) => v.key === "off")?.id;
  if (on === undefined || off === undefined)
    throw new Error("fixture thiếu variant");
  await admin.featureFlag.update({
    where: { id: flag.id },
    data: { defaultVariantId: off },
  });
  const target = Math.round((onPercent * TOTAL_BUCKETS) / 100);
  const config = await admin.flagEnvConfig.create({
    data: {
      flagId: flag.id,
      environmentId: project.environmentId,
      isEnabled: true,
      rules: {
        create: [
          {
            ruleType: "ALL",
            priority: 0,
            bucketSalt: randomUUID(),
            condition: {},
            // Sắp theo variantId như mọi writer thật — trigger UDP04 chặn bản sai thứ tự
            serve: canonicalizeServe({
              kind: "distribution",
              weights: [
                { variantId: on, weight: target },
                { variantId: off, weight: TOTAL_BUCKETS - target },
              ],
            }),
          },
        ],
      },
    },
    select: { id: true, rules: { select: { id: true } } },
  });
  const ruleId = config.rules[0]?.id;
  if (ruleId === undefined) throw new Error("fixture thiếu rule");
  return {
    projectId: project.projectId,
    environmentId: project.environmentId,
    flagId: flag.id,
    flagKey: key,
    envConfigId: config.id,
    ruleId,
    on,
    off,
    ownerId: project.ownerId,
  };
}

export interface SessionOptions {
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
      strategy: "CANARY",
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
      lastStepAt: options.lastStepAt ?? null,
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
  await admin.project.deleteMany({ where: { id: projectId } });
}

import { prisma } from "../../core/db.js";
import type { DeploymentEventRow } from "./deployment.dora.js";

const EVENT_FIELDS = {
  id: true,
  deploymentId: true,
  eventType: true,
  occurredAt: true,
  commitTimestamp: true,
  restoresDeploymentId: true,
  rolloutSessionId: true,
  triggeredBy: true,
  metadata: true,
  workloadName: true,
  imageTag: true,
  commitSha: true,
} as const;

/** Env có thuộc project không — cùng khuôn `environmentBelongsTo` của flag */
export async function environmentOf(
  projectId: string,
  environmentId: string,
): Promise<{ id: string; isProduction: boolean } | null> {
  return prisma.environment.findFirst({
    where: { id: environmentId, projectId },
    select: { id: true, isProduction: true },
  });
}

/** Env production có rank nhỏ nhất — DORA mặc định tính trên production (§2.2) */
export async function productionEnvOf(
  projectId: string,
): Promise<{ id: string } | null> {
  return prisma.environment.findFirst({
    where: { projectId, isProduction: true },
    orderBy: { rank: "asc" },
    select: { id: true },
  });
}

/**
 * Sự kiện gần nhất của một env — đi thẳng vào `idx_deploy_env_time`
 * (project, environment, occurred_at DESC).
 */
export async function recentEvents(
  projectId: string,
  environmentId: string,
  take: number,
): Promise<DeploymentEventRow[]> {
  return prisma.deploymentEvent.findMany({
    where: { projectId, environmentId },
    orderBy: { occurredAt: "desc" },
    take,
    select: EVENT_FIELDS,
  });
}

export async function eventsBetween(
  projectId: string,
  environmentId: string,
  from: Date,
  to: Date,
): Promise<DeploymentEventRow[]> {
  return prisma.deploymentEvent.findMany({
    where: { projectId, environmentId, occurredAt: { gte: from, lt: to } },
    orderBy: { occurredAt: "asc" },
    select: EVENT_FIELDS,
  });
}

/** Mốc DEPLOY_SUCCESS của những deployment bị khôi phục — có thể trước cửa sổ */
export async function successTimesOf(
  projectId: string,
  deploymentIds: readonly string[],
): Promise<Map<string, Date>> {
  if (deploymentIds.length === 0) return new Map();
  const rows = await prisma.deploymentEvent.findMany({
    where: {
      projectId,
      deploymentId: { in: [...deploymentIds] },
      eventType: "DEPLOY_SUCCESS",
    },
    select: { deploymentId: true, occurredAt: true },
  });
  return new Map(rows.map((r) => [r.deploymentId, r.occurredAt]));
}

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

/** [v4.11, Plan #45] Mọi sự kiện của MỘT lần deploy, theo thời gian — `idx` trên `deployment_id` */
export async function eventsOfDeployment(
  projectId: string,
  deploymentId: string,
) {
  return prisma.deploymentEvent.findMany({
    where: { projectId, deploymentId },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    select: { ...EVENT_FIELDS, pipelineId: true },
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

/** [v4.11, Plan #57] Sự kiện của MỌI environment của một project trong cửa sổ — biểu đồ deploy của trang Kiến trúc */
export async function eventsOfProject(
  projectId: string,
  from: Date,
  to: Date,
): Promise<(DeploymentEventRow & { environmentId: string })[]> {
  return prisma.deploymentEvent.findMany({
    where: { projectId, occurredAt: { gte: from, lt: to } },
    orderBy: { occurredAt: "asc" },
    select: { ...EVENT_FIELDS, environmentId: true },
  });
}

/** Mốc DEPLOY_SUCCESS của những deployment bị khôi phục — có thể trước cửa sổ */
/**
 * [v4.11, Plan #56] Env production ĐẦU TIÊN (theo rank) của mọi project còn sống — cùng quy tắc `productionEnvOf`,
 * một truy vấn cho cả nền tảng thay vì một cho mỗi project.
 */
export async function productionEnvironments(): Promise<
  { id: string; name: string; projectId: string; projectName: string }[]
> {
  const rows = await prisma.environment.findMany({
    where: { isProduction: true, project: { status: { not: "DELETED" } } },
    orderBy: [{ projectId: "asc" }, { rank: "asc" }],
    select: {
      id: true,
      name: true,
      projectId: true,
      project: { select: { name: true } },
    },
  });
  const first = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!first.has(r.projectId)) first.set(r.projectId, r);
  return [...first.values()].map((r) => ({
    id: r.id,
    name: r.name,
    projectId: r.projectId,
    projectName: r.project.name,
  }));
}

/** [v4.11, Plan #56] Sự kiện trong cửa sổ của nhiều environment, kèm env của từng sự kiện */
export async function eventsInEnvironments(
  environmentIds: readonly string[],
  from: Date,
  to: Date,
): Promise<(DeploymentEventRow & { environmentId: string })[]> {
  if (environmentIds.length === 0) return [];
  return prisma.deploymentEvent.findMany({
    where: {
      environmentId: { in: [...environmentIds] },
      occurredAt: { gte: from, lt: to },
    },
    orderBy: { occurredAt: "asc" },
    select: { ...EVENT_FIELDS, environmentId: true },
  });
}

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

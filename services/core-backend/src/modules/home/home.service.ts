import { Prisma } from "@udp/db";
import type { HomeAttentionWire, HomeWire } from "@udp/shared-types/wire";
import { prisma } from "../../core/db.js";
import { driftVerdictOf } from "../domain/project-domain.service.js";

/**
 * [v4.11, Plan #53 QĐ-5] Trang chủ của MỘT người dùng: mọi project họ là thành viên, rollout đang
 * chạy, việc cần xử lý, và deploy 14 ngày — một lời gọi thay vì N×M lời gọi từ trình duyệt.
 *
 * MỌI truy vấn lọc theo membership của người gọi (`project_members.user_id`) ngay trong câu hỏi, không
 * lọc sau: một dòng của project khác không bao giờ rời database. PLATFORM_ADMIN không có đặc quyền ở
 * đây — cùng luật với guard của project (§2.2: vai nền tảng chỉ dùng cho `/admin`).
 */

const ACTIVE_ROLLOUT = ["PENDING", "IN_PROGRESS"] as const;
const OPEN_ROLLOUT = ["PENDING", "IN_PROGRESS", "PAUSED"] as const;
const DAY_MS = 86_400_000;
export const HOME_DEPLOY_DAYS = 14;
/** Deploy chờ duyệt cũ hơn thế này không còn là "việc cần làm" — pipeline đã đi đường khác */
const PENDING_WINDOW_DAYS = 30;
const EXPIRING_WINDOW_MS = 48 * 3_600_000;
const MAX_ROLLOUTS = 20;
const MAX_ATTENTION = 50;

const idList = (ids: readonly string[]) =>
  Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));

interface PendingRow {
  deploymentId: string;
  projectId: string;
  environmentId: string;
  workloadName: string | null;
  occurredAt: Date;
}

interface FailedJobRow {
  id: string;
  projectId: string;
  jobType: string;
  updatedAt: Date;
}

interface DeployDayRow {
  day: string;
  eventType: "DEPLOY_SUCCESS" | "DEPLOY_FAILURE";
  count: number;
}

export async function homeOf(
  userId: string,
  now: Date = new Date(),
): Promise<HomeWire> {
  const memberships = await prisma.projectMember.findMany({
    where: { userId, project: { status: { not: "DELETED" } } },
    select: {
      projectRole: true,
      project: {
        select: {
          id: true,
          name: true,
          status: true,
          expiresAt: true,
          credentials: {
            where: { isActive: true },
            select: { provider: true },
            take: 1,
          },
          _count: { select: { environments: true } },
        },
      },
    },
    orderBy: { project: { name: "asc" } },
  });
  const ids = memberships.map((m) => m.project.id);
  const nameOf = new Map(
    memberships.map((m) => [m.project.id, m.project.name]),
  );
  const deploys = emptyDays(now);
  if (ids.length === 0) {
    return {
      projects: [],
      rollouts: [],
      attention: [],
      deploys,
      generatedAt: now.toISOString(),
    };
  }

  const since = new Date(
    Math.floor(now.getTime() / DAY_MS) * DAY_MS -
      (HOME_DEPLOY_DAYS - 1) * DAY_MS,
  );
  const [
    rollouts,
    activeCounts,
    pending,
    domains,
    failedJobs,
    deployDays,
    envs,
  ] = await Promise.all([
    prisma.rolloutSession.findMany({
      where: { projectId: { in: ids }, status: { in: [...OPEN_ROLLOUT] } },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        projectId: true,
        rolloutScope: true,
        status: true,
        currentTrafficPercentage: true,
        workloadName: true,
        updatedAt: true,
        environment: { select: { id: true, name: true, isProduction: true } },
        flagEnvConfig: { select: { flag: { select: { key: true } } } },
      },
    }),
    prisma.rolloutSession.groupBy({
      by: ["projectId"],
      where: { projectId: { in: ids }, status: { in: [...ACTIVE_ROLLOUT] } },
      _count: { _all: true },
    }),
    prisma.$queryRaw<PendingRow[]>(Prisma.sql`
        SELECT deployment_id AS "deploymentId", project_id AS "projectId",
               environment_id AS "environmentId", workload_name AS "workloadName",
               occurred_at AS "occurredAt"
        FROM (
          SELECT DISTINCT ON (deployment_id) *
          FROM deployment_events
          WHERE project_id IN (${idList(ids)})
            AND event_type <> 'FLAG_CHANGE'
            AND occurred_at > ${new Date(now.getTime() - PENDING_WINDOW_DAYS * DAY_MS)}
          ORDER BY deployment_id, occurred_at DESC
        ) latest
        WHERE event_type = 'DEPLOY_PENDING'`),
    prisma.domainConfig.findMany({
      where: {
        projectId: { in: ids },
        isEnabled: true,
        OR: [
          { domainStatus: { in: ["ERROR", "BLOCKED"] } },
          { domainStatus: "ACTIVE", lastError: { not: Prisma.AnyNull } },
        ],
      },
      select: {
        projectId: true,
        domainType: true,
        domainStatus: true,
        lastError: true,
        updatedAt: true,
      },
    }),
    prisma.$queryRaw<FailedJobRow[]>(Prisma.sql`
        SELECT id, project_id AS "projectId", job_type::text AS "jobType", updated_at AS "updatedAt"
        FROM (
          SELECT DISTINCT ON (project_id) *
          FROM provisioning_jobs
          WHERE project_id IN (${idList(ids)})
          ORDER BY project_id, updated_at DESC
        ) latest
        WHERE state IN ('FAILED', 'COMPENSATION_FAILED')`),
    prisma.$queryRaw<DeployDayRow[]>(Prisma.sql`
        SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
               event_type::text AS "eventType", count(*)::int AS count
        FROM deployment_events
        WHERE project_id IN (${idList(ids)})
          AND occurred_at >= ${since}
          AND event_type IN ('DEPLOY_SUCCESS', 'DEPLOY_FAILURE')
        GROUP BY 1, 2`),
    prisma.environment.findMany({
      where: { projectId: { in: ids } },
      select: { id: true, name: true, isProduction: true },
    }),
  ]);

  const envOf = new Map(envs.map((e) => [e.id, e]));
  const project = (projectId: string) => ({
    projectId,
    projectName: nameOf.get(projectId) ?? "",
  });

  const attention: HomeAttentionWire[] = [
    ...pending.map((p) => ({
      kind: "DEPLOY_PENDING" as const,
      ...project(p.projectId),
      subject: p.workloadName ?? "deploy",
      environment: envOf.get(p.environmentId) ?? null,
      refId: p.deploymentId,
      at: p.occurredAt.toISOString(),
    })),
    ...domains.flatMap((d): HomeAttentionWire[] => {
      if (d.domainStatus === "ERROR" || d.domainStatus === "BLOCKED") {
        return [
          {
            kind: "DOMAIN_ERROR",
            ...project(d.projectId),
            subject: d.domainType,
            environment: null,
            refId: null,
            at: d.updatedAt.toISOString(),
          },
        ];
      }
      const drift = driftVerdictOf(d.domainStatus, d.lastError);
      return drift.verdict === "DRIFTED"
        ? [
            {
              kind: "DOMAIN_DRIFTED",
              ...project(d.projectId),
              subject: d.domainType,
              environment: null,
              refId: null,
              at: drift.at ?? d.updatedAt.toISOString(),
            },
          ]
        : [];
    }),
    ...failedJobs.map((j) => ({
      kind: "JOB_FAILED" as const,
      ...project(j.projectId),
      subject: j.jobType,
      environment: null,
      refId: j.id,
      at: j.updatedAt.toISOString(),
    })),
    ...memberships.flatMap((m): HomeAttentionWire[] =>
      m.project.expiresAt !== null &&
      m.project.expiresAt.getTime() <= now.getTime() + EXPIRING_WINDOW_MS
        ? [
            {
              kind: "PROJECT_EXPIRING",
              ...project(m.project.id),
              subject: m.project.name,
              environment: null,
              refId: null,
              at: m.project.expiresAt.toISOString(),
            },
          ]
        : [],
    ),
    ...rollouts
      .filter((r) => r.status === "PAUSED")
      .map((r) => ({
        kind: "ROLLOUT_PAUSED" as const,
        ...project(r.projectId),
        subject: subjectOf(r),
        environment: r.environment,
        refId: r.id,
        at: r.updatedAt.toISOString(),
      })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_ATTENTION);

  const attentionCount = new Map<string, number>();
  for (const a of attention) {
    attentionCount.set(a.projectId, (attentionCount.get(a.projectId) ?? 0) + 1);
  }
  const activeOf = new Map(
    activeCounts.map((c) => [c.projectId, c._count._all]),
  );
  for (const row of deployDays) {
    const day = deploys.find((d) => d.date === row.day);
    if (day === undefined) continue;
    if (row.eventType === "DEPLOY_SUCCESS") day.success += row.count;
    else day.failure += row.count;
  }

  return {
    projects: memberships.map((m) => ({
      id: m.project.id,
      name: m.project.name,
      status: m.project.status,
      myRole: m.projectRole,
      cloudProvider: m.project.credentials[0]?.provider ?? null,
      environmentCount: m.project._count.environments,
      expiresAt: m.project.expiresAt?.toISOString() ?? null,
      activeRollouts: activeOf.get(m.project.id) ?? 0,
      attention: attentionCount.get(m.project.id) ?? 0,
    })),
    rollouts: rollouts.slice(0, MAX_ROLLOUTS).map((r) => ({
      id: r.id,
      ...project(r.projectId),
      environment: r.environment,
      subject: subjectOf(r),
      scope: r.rolloutScope,
      status: r.status as (typeof OPEN_ROLLOUT)[number],
      trafficPercentage: Number(r.currentTrafficPercentage),
      updatedAt: r.updatedAt.toISOString(),
    })),
    attention,
    deploys,
    generatedAt: now.toISOString(),
  };
}

/** Key flag với rollout mức flag, tên workload với rollout mức service */
function subjectOf(r: {
  workloadName: string | null;
  flagEnvConfig: { flag: { key: string } } | null;
}): string {
  return r.flagEnvConfig?.flag.key ?? r.workloadName ?? "rollout";
}

/** Đủ `HOME_DEPLOY_DAYS` ngày (UTC), cũ nhất trước — ngày không deploy vẫn có mặt với 0/0 */
function emptyDays(
  now: Date,
): { date: string; success: number; failure: number }[] {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return Array.from({ length: HOME_DEPLOY_DAYS }, (_, i) => ({
    date: new Date(today - (HOME_DEPLOY_DAYS - 1 - i) * DAY_MS)
      .toISOString()
      .slice(0, 10),
    success: 0,
    failure: 0,
  }));
}

import { env } from "@udp/config";
import { Prisma } from "@udp/db";
import type {
  AdminOverviewWire,
  AdminPlatformWire,
} from "@udp/shared-types/wire";
import type { PlatformProbe } from "../../core/platform-probe.js";
import { prisma } from "../../core/db.js";
import { orphans } from "./admin.service.js";

/**
 * [v4.11, Plan #53 QĐ-6] Bảng điều khiển nền tảng — hai nửa tách nhau vì hai nguồn khác nhau:
 *
 * - `overview`: số liệu nền tảng từ DATABASE (người dùng, project, job, tài nguyên mồ côi, công cụ,
 *   deploy, dung lượng database) — luôn có;
 * - `platform`: tín hiệu của CỤM đang chạy UDP qua Kubernetes API — có thể vắng (chạy ngoài cụm,
 *   RBAC thiếu), và vắng thì nói lý do, không làm hỏng nửa kia.
 */

const DAY_MS = 86_400_000;
const RUNNING_JOB = [
  "QUEUED",
  "NETWORK",
  "CLUSTER",
  "CLUSTER_ACCESS",
  "DOMAINS",
  "COMPENSATING",
] as const;
const TOP_TOOLS = 10;

interface ToolRow {
  domainType: string;
  toolId: string;
  projects: number;
}

export async function overview(
  now: Date = new Date(),
): Promise<AdminOverviewWire> {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const [
    users,
    admins,
    newUsers,
    byStatus,
    clouds,
    jobs,
    tools,
    deploys,
    orphanView,
    sizeBytes,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { platformRole: "PLATFORM_ADMIN" } }),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.project.groupBy({
      by: ["status"],
      where: { status: { not: "DELETED" } },
      _count: { _all: true },
    }),
    // Một credential đang dùng mỗi project (idx_one_active_credential_per_project) ⇒ đếm hàng = đếm project
    prisma.cloudCredential.groupBy({
      by: ["provider"],
      where: { isActive: true, project: { status: { not: "DELETED" } } },
      _count: { _all: true },
    }),
    prisma.provisioningJob.groupBy({ by: ["state"], _count: { _all: true } }),
    prisma.$queryRaw<ToolRow[]>(Prisma.sql`
      SELECT dc.domain_type AS "domainType", dc.selected_tool AS "toolId",
             count(DISTINCT dc.project_id)::int AS projects
      FROM domain_configs dc
      JOIN projects p ON p.id = dc.project_id
      WHERE dc.is_enabled AND dc.selected_tool IS NOT NULL AND p.status <> 'DELETED'
      GROUP BY 1, 2
      ORDER BY projects DESC, 1, 2
      LIMIT ${TOP_TOOLS}`),
    prisma.deploymentEvent.groupBy({
      by: ["eventType"],
      where: {
        occurredAt: { gte: weekAgo },
        eventType: { in: ["DEPLOY_SUCCESS", "DEPLOY_FAILURE"] },
      },
      _count: { _all: true },
    }),
    orphans(),
    databaseSize(),
  ]);

  const statusCount = (s: string): number =>
    byStatus.find((b) => b.status === s)?._count._all ?? 0;
  const jobCount = (states: readonly string[]): number =>
    jobs
      .filter((j) => states.includes(j.state))
      .reduce((sum, j) => sum + j._count._all, 0);
  const deployCount = (t: string): number =>
    deploys.find((d) => d.eventType === t)?._count._all ?? 0;

  return {
    users: { total: users, admins, newLast7d: newUsers },
    projects: {
      total: byStatus.reduce((sum, b) => sum + b._count._all, 0),
      byStatus: {
        DRAFT: statusCount("DRAFT"),
        PROVISIONING: statusCount("PROVISIONING"),
        ACTIVE: statusCount("ACTIVE"),
        ERROR: statusCount("ERROR"),
      },
    },
    clouds: clouds
      .map((c) => ({ provider: c.provider, projects: c._count._all }))
      .sort(
        (a, b) =>
          b.projects - a.projects || a.provider.localeCompare(b.provider),
      ),
    jobs: {
      running: jobCount(RUNNING_JOB),
      failed: jobCount(["FAILED"]),
      compensationFailed: jobCount(["COMPENSATION_FAILED"]),
      cancelRequested: jobCount(["CANCEL_REQUESTED"]),
    },
    orphans: {
      count: orphanView.resources.length,
      usdPerHour: orphanView.estimatedUsdPerHour,
      unpriced: orphanView.unpriced.length,
    },
    tools,
    deploys7d: {
      success: deployCount("DEPLOY_SUCCESS"),
      failure: deployCount("DEPLOY_FAILURE"),
    },
    database: { sizeBytes },
    generatedAt: now.toISOString(),
  };
}

/**
 * Dung lượng database đang dùng — trên máy ảo so với PVC 20 GiB, trên dịch vụ được host so với hạn
 * mức của gói. `null` khi role không được hỏi (một nhà cung cấp có thể chặn `pg_database_size`).
 */
async function databaseSize(): Promise<number | null> {
  try {
    const [row] = await prisma.$queryRaw<{ size: bigint }[]>(
      Prisma.sql`SELECT pg_database_size(current_database()) AS size`,
    );
    return row === undefined ? null : Number(row.size);
  } catch {
    return null;
  }
}

export async function platform(
  probe: PlatformProbe,
  now: Date = new Date(),
): Promise<AdminPlatformWire> {
  return {
    release: env.UDP_RELEASE ?? null,
    ...(await probe.read()),
    checkedAt: now.toISOString(),
  };
}

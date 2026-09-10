import { ACTIVE_ROLLOUT_STATUSES } from "@udp/config";
import type { Prisma } from "@udp/db";
import type { PublicRule } from "./rule.types.js";

export const RULE_FIELDS = {
  id: true,
  ruleType: true,
  condition: true,
  serve: true,
  priority: true,
  description: true,
  bucketSalt: true,
} as const;

export interface EnvConfigTarget {
  environmentId: string;
  flagKey: string;
  projectId: string;
  updatedAt: Date;
}

/**
 * Env-config ra những gì một lần ghi rule cần: environment để khoá (bước 1 của
 * ADR-05), key của flag để rút delta, project để kiểm segment, và mốc
 * `updated_at` cho optimistic lock.
 *
 * Gọi hai lần — một lần ngoài transaction để biết khoá gì, một lần TRONG
 * `mutate` sau khi đã khoá. Lần thứ hai mới là lần đáng tin: giữa hai lần, một
 * PUT khác có thể đã commit, và optimistic lock phải so với mốc SAU khi khoá, nếu
 * không nó để lọt đúng khe hở mà nó sinh ra để đóng.
 */
export async function envConfigTargetOf(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<EnvConfigTarget | null> {
  const row = await tx.flagEnvConfig.findUnique({
    where: { id },
    select: {
      environmentId: true,
      updatedAt: true,
      flag: { select: { key: true, projectId: true } },
    },
  });

  return row === null
    ? null
    : {
        environmentId: row.environmentId,
        flagKey: row.flag.key,
        projectId: row.flag.projectId,
        updatedAt: row.updatedAt,
      };
}

/** Rule của một env-config, theo thứ tự chuẩn `(priority, id)` */
export const rulesOf = (
  tx: Prisma.TransactionClient,
  flagEnvConfigId: string,
): Promise<PublicRule[]> =>
  tx.flagTargetingRule.findMany({
    where: { flagEnvConfigId },
    select: RULE_FIELDS,
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });

/**
 * Trong số các rule đưa vào, rule nào đang bị một rollout HOẠT ĐỘNG giữ.
 *
 * Đây là tín hiệu duy nhất Service 2 có để giữ lời §1.2 — "một writer duy nhất
 * tới đối tượng điều khiển traffic": trong lúc rollout đang ramp một rule, rule
 * đó thuộc về Service 3. Đọc được là nhờ migration `s2_reads_rollout_sessions`,
 * và truy vấn này chỉ chạm hai trong năm cột được cấp — `targeting_rule_id` và
 * `status`.
 *
 * "Hoạt động" là `ACTIVE_ROLLOUT_STATUSES`, đúng vị từ của truy vấn giành lease,
 * gồm cả `PENDING` và `PAUSED`: một rollout đang tạm dừng vẫn sở hữu rule của nó.
 */
export async function activeRolloutRuleIds(
  tx: Prisma.TransactionClient,
  ruleIds: readonly string[],
): Promise<Set<string>> {
  if (ruleIds.length === 0) return new Set();

  const rows = await tx.rolloutSession.findMany({
    where: {
      targetingRuleId: { in: [...ruleIds] },
      status: { in: [...ACTIVE_ROLLOUT_STATUSES] },
    },
    select: { targetingRuleId: true },
  });

  return new Set(
    rows.flatMap((r) =>
      r.targetingRuleId === null ? [] : [r.targetingRuleId],
    ),
  );
}

/** Những segment trong danh sách THỰC SỰ thuộc project này */
export async function segmentsInProject(
  tx: Prisma.TransactionClient,
  projectId: string,
  segmentIds: readonly string[],
): Promise<Set<string>> {
  if (segmentIds.length === 0) return new Set();

  const rows = await tx.segment.findMany({
    where: { id: { in: [...segmentIds] }, projectId },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

export interface RampTarget {
  environmentId: string;
  flagKey: string;
  flagEnvConfigId: string;
  serve: Prisma.JsonValue;
}

/**
 * Rule ra những gì một lần ramp cần. Gọi hai lần, cùng lý do với
 * `envConfigTargetOf`: lần ngoài transaction để biết khoá environment nào, lần
 * trong `mutate` mới là lần đáng tin.
 */
export async function rampTargetOf(
  tx: Prisma.TransactionClient,
  ruleId: string,
): Promise<RampTarget | null> {
  const row = await tx.flagTargetingRule.findUnique({
    where: { id: ruleId },
    select: {
      serve: true,
      flagEnvConfigId: true,
      flagEnvConfig: {
        select: { environmentId: true, flag: { select: { key: true } } },
      },
    },
  });

  return row === null
    ? null
    : {
        environmentId: row.flagEnvConfig.environmentId,
        flagKey: row.flagEnvConfig.flag.key,
        flagEnvConfigId: row.flagEnvConfigId,
        serve: row.serve,
      };
}

export interface LeaseState {
  version: number;
  targetingRuleId: string | null;
  status: string;
  /** `claimed_until` còn ở tương lai, theo đồng hồ của DATABASE */
  leased: boolean;
}

/**
 * Trạng thái lease của một `RolloutSession` — MỘT truy vấn cho cả T12 lẫn I23.
 *
 * Raw SQL vì phép so thời gian phải chạy trên đồng hồ của DATABASE, và Prisma
 * không viết được điều đó trong `where`. Lease được cấp bằng
 * `now() + interval '60 seconds'` (§7.1), tức theo đồng hồ database; so nó với
 * `new Date()` của pod này là để độ lệch đồng hồ giữa hai máy quyết định ai được
 * ghi.
 *
 * `statement_timestamp()`, KHÔNG phải `now()`. Trong transaction, `now()` là giờ
 * BẮT ĐẦU transaction, mà câu này chạy sau bước 1 của ADR-05 — sau khi đã chờ
 * khoá environment lâu bao nhiêu cũng được. Đã đo: sau `pg_sleep(1.2)` trong cùng
 * transaction, `now()` chậm hơn `statement_timestamp()` 1,3 giây. Dùng `now()`
 * thì lease hết hạn TRONG LÚC chờ khoá vẫn được coi là còn hạn.
 *
 * Chỉ chạm năm cột migration `s2_reads_rollout_sessions` cấp — thêm một cột nữa
 * vào đây là `42501`. Và KHÔNG khoá hàng: `FOR SHARE` lẫn `FOR KEY SHARE` đều cần
 * quyền UPDATE, đã đo là `42501` với `udp_s2`, mà cấp UPDATE là phá ma trận
 * writer I22.
 */
export async function leaseOf(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<LeaseState | null> {
  const rows = await tx.$queryRaw<LeaseState[]>`
    SELECT version,
           targeting_rule_id::text AS "targetingRuleId",
           status::text AS status,
           (claimed_until IS NOT NULL
             AND claimed_until > statement_timestamp()) AS leased
      FROM rollout_sessions
     WHERE id = ${sessionId}::uuid`;

  return rows[0] ?? null;
}

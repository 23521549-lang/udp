import { Prisma } from "@udp/db";
import { SEGMENT } from "@udp/config";
import { prisma } from "../../core/db.js";

/**
 * Đường ĐỌC segment của Service 1 (§3.1).
 *
 * Đọc thẳng database, không qua Service 2 — khác đường ghi. `udp_s1` có SELECT
 * trên `segments`, `flag_targeting_rules`, `flag_env_configs`, `feature_flags` và
 * `environments` (R7-7), và không có phép kiểm nghiệp vụ nào ở đây cần khoá
 * environment: một trang danh sách đọc trạng thái đã commit là đủ. Thêm một hop
 * nội bộ cho việc đó chỉ để "cho giống đường ghi" là trả giá mà không mua gì.
 *
 * Mọi con số tóm tắt tính TRONG SQL. Kéo `conditions` về rồi đếm ở JS là chuyển
 * tới 4 MiB mỗi segment × 100 segment qua dây cho một trang phải dưới 10 KB
 * (AC-3.11).
 */

/** `conditions` đã lưu, cộng các con số tóm tắt — không bao giờ ra ngoài nguyên vẹn */
const SUMMARY_COLUMNS = Prisma.sql`
  s.id::text   AS "id",
  s.name       AS "name",
  s.description AS "description",
  s.created_at AS "createdAt",
  s.updated_at AS "updatedAt",
  jsonb_array_length(s.conditions -> 'all')::int     AS "conditionCount",
  jsonb_array_length(s.conditions -> 'userIds')::int AS "userIdCount",
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(s.conditions -> 'all') AS c
     WHERE c ->> 'operator' = 'regex'
  ) AS "hasRegex",
  octet_length(s.conditions::text) AS "payloadBytes",
  u."flagCount"           AS "flagCount",
  u."productionFlagCount" AS "productionFlagCount"`;

/**
 * "Bao nhiêu flag đang dùng segment này, mấy trong số đó ở production".
 *
 * `LATERAL` để chạy một lần cho mỗi segment của trang thay vì một truy vấn cho
 * mỗi segment. Đếm theo flag, không theo rule: một flag có thể có rule trỏ tới
 * cùng segment ở cả ba environment, và Portal cần biết "3 flag", không phải "9
 * rule". Không lọc `lifecycle_status`: rule của flag DRAFT hay ARCHIVED vẫn chặn
 * xoá segment, nên danh sách phải nói đúng thứ sẽ chặn.
 */
const USAGE_LATERAL = Prisma.sql`
  CROSS JOIN LATERAL (
    SELECT count(DISTINCT f.id)::int AS "flagCount",
           count(DISTINCT f.id) FILTER (WHERE e.is_production)::int AS "productionFlagCount"
      FROM flag_targeting_rules r
      JOIN flag_env_configs c ON c.id = r.flag_env_config_id
      JOIN environments e     ON e.id = c.environment_id
      JOIN feature_flags f    ON f.id = c.flag_id
     WHERE e.project_id = s.project_id
       AND r.rule_type = 'SEGMENT'
       AND r.condition ->> 'segmentId' = s.id::text
  ) u`;

export interface SummaryRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  conditionCount: number;
  userIdCount: number;
  hasRegex: boolean;
  payloadBytes: number;
  flagCount: number;
  productionFlagCount: number;
}

export interface DetailRow extends SummaryRow {
  conditions: Prisma.JsonValue;
}

/**
 * Danh sách segment của project, sắp theo tên.
 *
 * `position(... in ...)` chứ không `ILIKE '%' || $ || '%'`: trong `ILIKE` thì `%`
 * và `_` do người dùng gõ là ký tự đại diện, nên gõ `%` sẽ khớp mọi thứ và gõ một
 * tên có `_` sẽ khớp cả những tên khác. Không có trang nào hứa cú pháp đại diện,
 * nên đừng cấp nó một cách tình cờ.
 *
 * `LIMIT` bằng đúng trần số segment mỗi project (V5): trang này không phân trang,
 * và trần kia là chốt bảo đảm nó không cần.
 */
export function list(
  projectId: string,
  search: string | undefined,
): Promise<SummaryRow[]> {
  const needle = search ?? null;
  return prisma.$queryRaw<SummaryRow[]>`
    SELECT ${SUMMARY_COLUMNS}
      FROM segments s
      ${USAGE_LATERAL}
     WHERE s.project_id = ${projectId}::uuid
       AND (${needle}::text IS NULL
            OR position(lower(${needle}::text) in lower(s.name)) > 0)
     ORDER BY s.name
     LIMIT ${SEGMENT.maxPerProject}`;
}

/**
 * Một segment của ĐÚNG project này, hoặc `undefined`.
 *
 * `project_id` nằm trong CÙNG câu truy vấn, không kiểm ở hai bước: đây là chốt
 * sở hữu của I14/R05 cho `:segmentId`, và một phép kiểm tách rời là một khe hở.
 * Cũng là phép kiểm mà PUT/DELETE gọi TRƯỚC khi chạm Service 2 — segment của
 * project khác phải ra 404 mà Service 2 không hề bị gọi.
 */
export async function detail(
  projectId: string,
  segmentId: string,
): Promise<DetailRow | undefined> {
  const rows = await prisma.$queryRaw<DetailRow[]>`
    SELECT ${SUMMARY_COLUMNS}, s.conditions AS "conditions"
      FROM segments s
      ${USAGE_LATERAL}
     WHERE s.project_id = ${projectId}::uuid
       AND s.id = ${segmentId}::uuid`;
  return rows[0];
}

/** Segment này có thuộc project này không — chốt sở hữu của đường GHI */
export async function belongsToProject(
  projectId: string,
  segmentId: string,
): Promise<boolean> {
  const row = await prisma.segment.findFirst({
    where: { id: segmentId, projectId },
    select: { id: true },
  });
  return row !== null;
}

export interface FlagUsageRow {
  flagId: string;
  flagKey: string;
  lifecycleStatus: string;
  envs: { id: string; name: string; isProduction: boolean }[];
}

/**
 * Flag còn rule trỏ tới segment, kèm environment của rule đó.
 *
 * Gộp environment trong SQL (`jsonb_agg DISTINCT`) để một flag có rule ở ba
 * environment ra MỘT hàng, không ba — đây là danh sách "gỡ ở đâu", và ba hàng
 * cùng key làm người đọc tưởng có ba flag.
 */
export function flagUsage(
  projectId: string,
  segmentId: string,
): Promise<FlagUsageRow[]> {
  return prisma.$queryRaw<FlagUsageRow[]>`
    SELECT f.id::text              AS "flagId",
           f.key                   AS "flagKey",
           f.lifecycle_status::text AS "lifecycleStatus",
           jsonb_agg(DISTINCT jsonb_build_object(
             'id', e.id::text, 'name', e.name, 'isProduction', e.is_production
           )) AS "envs"
      FROM flag_targeting_rules r
      JOIN flag_env_configs c ON c.id = r.flag_env_config_id
      JOIN environments e     ON e.id = c.environment_id
      JOIN feature_flags f    ON f.id = c.flag_id
     WHERE e.project_id = ${projectId}::uuid
       AND r.rule_type = 'SEGMENT'
       AND r.condition ->> 'segmentId' = ${segmentId}
     GROUP BY f.id, f.key, f.lifecycle_status
     ORDER BY f.key
     LIMIT ${SEGMENT.referencesInView}`;
}

export interface QuotaRow {
  segmentCount: number;
  payloadBytes: number;
}

/**
 * Hai con số trần của project (V21) — cùng thước đo `octet_length(conditions::text)`
 * mà Service 2 cưỡng chế trần bằng, để Portal không hiện một con số rồi nhận 422
 * theo một con số khác.
 */
export async function quota(projectId: string): Promise<QuotaRow> {
  const rows = await prisma.$queryRaw<QuotaRow[]>`
    SELECT count(*)::int AS "segmentCount",
           COALESCE(SUM(octet_length(conditions::text)), 0)::int AS "payloadBytes"
      FROM segments
     WHERE project_id = ${projectId}::uuid`;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("quota: truy vấn gộp không trả hàng nào");
  }
  return row;
}

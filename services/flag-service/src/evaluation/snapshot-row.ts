import { Prisma } from "@udp/db";
import { z } from "zod";

/**
 * Đọc MỌI thứ cần để dựng snapshot của một environment bằng MỘT câu lệnh SQL.
 *
 * Trước đó đường này là 9 truy vấn Prisma (environment, environment lần hai,
 * project, segments, feature_flags, flag_variants, flag_env_configs,
 * flag_targeting_rules, COMMIT) gói trong một transaction `RepeatableRead` —
 * đo 12/09/2026 trên env seed: 957ms, và chạy DƯỚI row-lock của `environments`
 * ở mọi lần ghi flag/rule/env-config (`stateFor`). Một câu lệnh: 77ms.
 *
 * Vì sao một câu lệnh là bảo đảm MẠNH HƠN transaction `RepeatableRead`, không
 * phải bỏ nó cho nhanh: PostgreSQL 17 §13.2.1 — "a SELECT query (without a
 * FOR UPDATE/SHARE clause) sees only data committed before the query began; it
 * never sees either uncommitted data or changes committed by concurrent
 * transactions during the query's execution … a SELECT query sees a snapshot of
 * the database as of the instant the query begins to run". Mọi subquery và
 * `json_agg` bên dưới là một phần của cùng câu lệnh, nên `(config_version,
 * config_hash, snapshot)` nói về cùng một khoảnh khắc BẰNG CẤU TRÚC — không có
 * khe nào giữa "đọc version" và "đọc nội dung" để một lần ghi chen vào.
 *
 * Bốn quy tắc của câu lệnh, mỗi cái canh một bất biến:
 *   - MỌI tầng lồng có điều kiện environment/project của chính nó; riêng
 *     `flag_env_configs` lọc `environment_id = e.id` — đây là nơi I14 (SDK key
 *     của `dev` không đọc được cấu hình `prod`) được quyết định.
 *   - `COALESCE(…, '[]')` ở CẢ BỐN tầng: `json_agg` trên tập rỗng trả NULL, và
 *     environment vừa tạo (0 flag) là ca phổ biến nhất trong fixture.
 *   - Thứ tự TẤT ĐỊNH ngay trong SQL (`flags` theo key, `rules` theo priority
 *     rồi id, `segments` theo id): Postgres không bảo đảm thứ tự khi thiếu
 *     `ORDER BY`, và thứ tự trả về đổi sau mỗi UPDATE — đầu vào của hàm băm
 *     không được phép có một khác biệt không tất định.
 *   - Kết quả đi qua zod TRƯỚC khi vào mapping: `$queryRaw` trả `unknown`, và
 *     một cột đổi tên trong migration phải nổ ở đây với tên trường, không nổ
 *     ở `pickVariant` trong tiến trình của khách.
 *
 * Chuỗi `udp:snapshot` trong câu lệnh là nhãn để test đếm truy vấn nhận ra nó.
 */

const uuid = z.string().uuid();

const ruleRowSchema = z.object({
  id: uuid,
  ruleType: z.string(),
  priority: z.number().int(),
  bucketSalt: z.string(),
  condition: z.unknown(),
  serve: z.unknown(),
});

const envConfigRowSchema = z.object({
  isEnabled: z.boolean(),
  defaultVariantId: uuid.nullable(),
  rules: z.array(ruleRowSchema),
});

const flagRowSchema = z.object({
  key: z.string(),
  flagType: z.string(),
  lifecycleStatus: z.string(),
  stickinessAttribute: z.string(),
  defaultVariantId: uuid.nullable(),
  variants: z.array(
    z.object({ id: uuid, key: z.string(), value: z.unknown() }),
  ),
  /** NULL khi flag chưa có cấu hình ở environment này */
  envConfig: envConfigRowSchema.nullable(),
});

export const snapshotRowSchema = z.object({
  name: z.string(),
  configVersion: z.number().int(),
  configHash: z.string(),
  segments: z.array(z.object({ id: uuid, conditions: z.unknown() })),
  flags: z.array(flagRowSchema),
});

export type SnapshotRow = z.infer<typeof snapshotRowSchema>;
export type FlagRow = z.infer<typeof flagRowSchema>;

const snapshotSql = (environmentId: string): Prisma.Sql => Prisma.sql`
  /* udp:snapshot */
  SELECT
    e.name,
    e.config_version AS "configVersion",
    e.config_hash    AS "configHash",
    COALESCE((
      SELECT json_agg(json_build_object('id', s.id, 'conditions', s.conditions) ORDER BY s.id)
        FROM segments s
       WHERE s.project_id = e.project_id
    ), '[]'::json) AS segments,
    COALESCE((
      SELECT json_agg(json_build_object(
          'key',                 f.key,
          'flagType',            f.flag_type,
          'lifecycleStatus',     f.lifecycle_status,
          'stickinessAttribute', f.stickiness_attribute,
          'defaultVariantId',    f.default_variant_id,
          'variants', COALESCE((
            SELECT json_agg(json_build_object('id', v.id, 'key', v.key, 'value', v.value) ORDER BY v.id)
              FROM flag_variants v
             WHERE v.flag_id = f.id
          ), '[]'::json),
          'envConfig', (
            SELECT json_build_object(
                'isEnabled',        c.is_enabled,
                'defaultVariantId', c.default_variant_id,
                'rules', COALESCE((
                  SELECT json_agg(json_build_object(
                      'id',         r.id,
                      'ruleType',   r.rule_type,
                      'priority',   r.priority,
                      'bucketSalt', r.bucket_salt,
                      'condition',  r.condition,
                      'serve',      r.serve
                    ) ORDER BY r.priority, r.id)
                    FROM flag_targeting_rules r
                   WHERE r.flag_env_config_id = c.id
                ), '[]'::json))
              FROM flag_env_configs c
             WHERE c.flag_id = f.id AND c.environment_id = e.id
          )
        ) ORDER BY f.key)
        FROM feature_flags f
       WHERE f.project_id = e.project_id
    ), '[]'::json) AS flags
  FROM environments e
  WHERE e.id = ${environmentId}::uuid
`;

/**
 * Hàng snapshot của một environment, hoặc `undefined` nếu environment không tồn
 * tại. Chạy được cả trên client thường lẫn trong transaction ghi (`stateFor`):
 * `TransactionClient` là tập con cấu trúc của `PrismaClient`.
 */
export async function snapshotRowOf(
  db: Prisma.TransactionClient,
  environmentId: string,
): Promise<SnapshotRow | undefined> {
  const rows = await db.$queryRaw<unknown[]>(snapshotSql(environmentId));
  const first = rows[0];
  if (first === undefined) return undefined;
  return snapshotRowSchema.parse(first);
}

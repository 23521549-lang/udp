import { SDK_STATS } from "@udp/config";
import { hasSqlState, Prisma, type PrismaClient } from "@udp/db";
import type { StatsGranularity } from "@udp/shared-types";
import type { StatsRow } from "./stats.aggregator.js";

/**
 * [v4.9] Nơi DUY NHẤT biết SQL của `flag_evaluation_stats` (R8) — ghi ở đây,
 * đọc ở đây, gộp retention ở đây.
 *
 * Cả hai câu đều viết thẳng bằng `$executeRaw`/`$queryRaw` thay vì đi qua model
 * của Prisma, và mỗi câu có lý do riêng nằm ngay trên nó. Điểm chung: chúng là
 * một CÂU cho cả lô, không phải N lời gọi — telemetry chạy trên cùng pool 5 khe
 * với `/sdk/config`, nên một lô 1 000 hàng mà tốn 1 000 round trip là tự gây ra
 * sự cố tồi hơn thứ nó đo.
 */

/** SQLSTATE `foreign_key_violation` — env bị xoá trong khe giữa lúc nhận và lúc ghi */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Câu UPSERT của một lô — export để test chạy ĐÚNG câu mà runtime chạy
 * (`tests/evalstat-upsert.integration.test.ts`, B-04).
 *
 * Bốn chi tiết là bắt buộc, không phải tuỳ chọn:
 *
 *   - **`JOIN environments` rồi `JOIN feature_flags` theo `project_id` + `key`.**
 *     Key của flag chỉ UNIQUE theo project, nên `WHERE key = $k` trần sẽ cộng
 *     lượt của project A vào flag cùng tên của project B (R06, I14). Environment
 *     đến từ CHÍNH khoá SDK, không từ body. Ánh xạ key ⇒ id bằng JOIN trong câu
 *     ghi cũng có nghĩa: 0 lượt đọc thêm, không cache phải làm tươi, và hàng của
 *     flag/env vừa biến mất tự rơi.
 *   - **`GROUP BY` trước `ON CONFLICT`.** Hai hàng cùng khoá xung đột trong MỘT
 *     câu làm Postgres ném `21000 ON CONFLICT DO UPDATE command cannot affect
 *     row a second time` và mất CẢ lô (R7 V1). Bộ gộp đã khử trùng theo đúng
 *     khoá đó, nên đây là lớp thứ hai — giá của nó bằng 0, còn giá của việc
 *     thiếu nó là 15 giây số đếm.
 *   - **`ORDER BY` khoá.** Hai replica flush các lô chồng nhau khoá hàng theo
 *     cùng một thứ tự nên không deadlock (cùng lý do `packages/db/src/outbox.ts`).
 *   - **Tham số là 5 mảng `text[]` ép kiểu trong SQL.** Không phụ thuộc cách
 *     driver adapter tuần tự hoá `Date`, `bigint` hay số lớn: `eval_count` đi
 *     dưới dạng chuỗi thập phân và `bucket_hour` dưới dạng ISO có `Z` (C-15).
 *
 * `gen_random_uuid()` vì cột `id` KHÔNG có default ở database (`@default(uuid())`
 * là của Prisma). Không đi qua `writeWithOutbox`: telemetry không phải cấu hình,
 * không tăng `config_version` (INV-23.4).
 */
export function upsertStatsSql(rows: readonly StatsRow[]): Prisma.Sql {
  return Prisma.sql`
    WITH input AS (
      SELECT environment_id::uuid       AS environment_id,
             flag_key,
             variant_key,
             eval_count::bigint         AS eval_count,
             bucket_hour::timestamptz   AS bucket_hour
        FROM unnest(
               ${rows.map((r) => r.environmentId)}::text[],
               ${rows.map((r) => r.flagKey)}::text[],
               ${rows.map((r) => r.variant)}::text[],
               ${rows.map((r) => String(r.count))}::text[],
               ${rows.map((r) => new Date(r.bucketHour).toISOString())}::text[]
             ) AS t(environment_id, flag_key, variant_key, eval_count, bucket_hour)
    )
    INSERT INTO flag_evaluation_stats
                (id, flag_id, environment_id, variant_key, eval_count, bucket_hour)
    SELECT gen_random_uuid(), f.id, i.environment_id, i.variant_key,
           sum(i.eval_count)::bigint, i.bucket_hour
      FROM input i
      JOIN environments  e ON e.id = i.environment_id
      JOIN feature_flags f ON f.project_id = e.project_id AND f.key = i.flag_key
     GROUP BY f.id, i.environment_id, i.variant_key, i.bucket_hour
     ORDER BY f.id, i.environment_id, i.variant_key, i.bucket_hour
    ON CONFLICT (flag_id, environment_id, variant_key, bucket_hour)
    DO UPDATE SET eval_count = flag_evaluation_stats.eval_count + EXCLUDED.eval_count`;
}

/**
 * Câu gộp MỘT ngày hàng giờ quá hạn thành một hàng 00:00 UTC — idempotent, không
 * cần migration và không cần hàm SECURITY DEFINER (`udp_s2` có DELETE trên bảng
 * này, khác `config_change_log`).
 *
 * Hàng 00:00 UTC của chính ngày đó KHÔNG bị DELETE (`> day.d`) mà được INSERT
 * cộng vào, nên không hàng nào bị sửa hai lần trong một câu. An toàn với nhiều
 * replica: replica thứ hai chờ khoá hàng rồi DELETE 0 hàng (cùng lý lẽ
 * `prune.job.ts`), không cần bầu leader.
 *
 * Ngày theo UTC, khớp bucket (R12 (e)): cửa sổ đọc theo múi giờ của người xem
 * vẫn đúng vì `hourlyDays` = `query.maxDays` + 2.
 */
function rollupOldestDaySql(hourlyDays: number): Prisma.Sql {
  return Prisma.sql`
    WITH day AS (
      SELECT date_trunc('day', bucket_hour, 'UTC') AS d
        FROM flag_evaluation_stats
       WHERE bucket_hour < date_trunc('day', now(), 'UTC')
                            - make_interval(days => ${hourlyDays}::int)
         AND bucket_hour <> date_trunc('day', bucket_hour, 'UTC')
       ORDER BY bucket_hour
       LIMIT 1
    ), gone AS (
      DELETE FROM flag_evaluation_stats s
       USING day
       WHERE s.bucket_hour > day.d
         AND s.bucket_hour < day.d + interval '1 day'
      RETURNING s.flag_id, s.environment_id, s.variant_key, s.eval_count, day.d
    ), folded AS (
      INSERT INTO flag_evaluation_stats
                  (id, flag_id, environment_id, variant_key, eval_count, bucket_hour)
      SELECT gen_random_uuid(), flag_id, environment_id, variant_key,
             sum(eval_count)::bigint, d
        FROM gone
       GROUP BY flag_id, environment_id, variant_key, d
      ON CONFLICT (flag_id, environment_id, variant_key, bucket_hour)
      DO UPDATE SET eval_count = flag_evaluation_stats.eval_count + EXCLUDED.eval_count
    )
    SELECT count(*)::int AS deleted FROM gone`;
}

// ------------------------------------------------------------- đường ĐỌC

/**
 * Phần của client cần cho các câu ĐỌC — nhận cả `prisma` và `tx`, vì chốt archive
 * 7 ngày đọc bảng này TRONG transaction đã khoá environment (§3.4).
 */
type Reader = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Trần của mọi con số rời file này: `Number.MAX_SAFE_INTEGER` ép TRONG SQL rồi
 * `::text`, không bao giờ để một `bigint` của JS đi tới `res.json` (V17, R11).
 *
 * `LEAST` của Postgres BỎ QUA NULL, nên mọi tổng có `FILTER` phải `COALESCE`
 * TRƯỚC khi vào `LEAST` — ngược lại một nhóm rỗng trả về đúng cái trần.
 */
const SAFE_MAX = Prisma.sql`${Number.MAX_SAFE_INTEGER}::bigint`;

/** Tổng `::text` của SQL ⇒ `number`; đã bão hoà ở SQL nên không mất độ chính xác */
const countOf = (text: string): number => Number(text);

const envFilterOf = (environmentId: string | undefined): Prisma.Sql =>
  environmentId === undefined
    ? Prisma.empty
    : Prisma.sql`AND s.environment_id = ${environmentId}::uuid`;

export interface StatsWindow {
  granularity: StatsGranularity;
  tz: string;
  from: Date;
  to: Date;
}

/**
 * Vị từ cửa sổ — khác nhau theo `granularity`, và đó là điểm mấu chốt.
 *
 * `hour`: bucket đã là đầu giờ UTC, nên so thẳng với `date_trunc('hour', …)` là
 * đủ và dùng được index trên `bucket_hour`.
 *
 * `day`: cửa sổ tính theo NGÀY ĐỊA PHƯƠNG, cùng khoá với series (F12) — nếu lọc
 * theo mốc UTC thì một bucket thuộc ngày địa phương đầu cửa sổ nhưng sớm hơn `from`
 * sẽ bị loại khỏi tổng trong khi ngày đó vẫn có một điểm trên đồ thị, và `totals`
 * không còn bằng tổng của `series`. Hai bất đẳng thức trên `bucket_hour` (±1 ngày,
 * đủ rộng cho mọi lệch múi giờ) chỉ để Postgres còn dùng được index.
 */
function windowFilter(window: StatsWindow): Prisma.Sql {
  const lo = window.from.toISOString();
  const hi = window.to.toISOString();
  return window.granularity === "hour"
    ? Prisma.sql`
       AND s.bucket_hour >= date_trunc('hour', ${lo}::timestamptz)
       AND s.bucket_hour <= date_trunc('hour', ${hi}::timestamptz)`
    : Prisma.sql`
       AND s.bucket_hour >= ${lo}::timestamptz - interval '1 day'
       AND s.bucket_hour <= ${hi}::timestamptz + interval '1 day'
       AND (s.bucket_hour AT TIME ZONE ${window.tz})::date
           BETWEEN (${lo}::timestamptz AT TIME ZONE ${window.tz})::date
               AND (${hi}::timestamptz AT TIME ZONE ${window.tz})::date`;
}

/** Khoá gộp của một điểm — phải TRÙNG với khoá của series bên dưới */
const bucketKey = (window: StatsWindow): Prisma.Sql =>
  window.granularity === "hour"
    ? Prisma.sql`s.bucket_hour`
    : Prisma.sql`(s.bucket_hour AT TIME ZONE ${window.tz})::date`;

/**
 * Series DÀY sinh ngay trong SQL (V17, F12).
 *
 * `day`: `generate_series` trên hai `date` ĐỊA PHƯƠNG, bước `interval '1 day'` —
 * số học trên `date` nên mốc đổi giờ không sinh ra điểm thừa hay điểm thiếu, và
 * mỗi ngày địa phương có đúng một điểm dù ngày đó dài 23 hay 25 giờ. Không dùng
 * tham số tz thứ tư của `generate_series` (chỉ có từ PG 16).
 *
 * `hour`: `generate_series` trên `timestamptz`, KHÔNG tham số tz — bucket là giờ
 * UTC nên múi giờ không tham gia; `tz` chỉ đổi cách Portal đặt nhãn.
 *
 * Số điểm = số bucket mà cửa sổ CHẠM TỚI. Với `day` đó là số ngày địa phương giữa
 * `from` và `to`, tức `days` điểm trừ khi một mốc đổi giờ rơi vào đúng khoảng vài
 * giờ quanh nửa đêm địa phương của `to` — lúc đó `window.from`/`to` trong phản hồi
 * vẫn nói đúng cửa sổ thật.
 */
function seriesPoints(window: StatsWindow): Prisma.Sql {
  const lo = window.from.toISOString();
  const hi = window.to.toISOString();
  return window.granularity === "hour"
    ? Prisma.sql`
       SELECT generate_series(date_trunc('hour', ${lo}::timestamptz),
                              date_trunc('hour', ${hi}::timestamptz),
                              interval '1 hour') AS at`
    : Prisma.sql`
       SELECT generate_series((${lo}::timestamptz AT TIME ZONE ${window.tz})::date,
                              (${hi}::timestamptz AT TIME ZONE ${window.tz})::date,
                              interval '1 day')::date AS at`;
}

/**
 * Nhãn của một điểm: mốc ISO với `hour`, ngày địa phương `YYYY-MM-DD` với `day`.
 *
 * Định dạng trong SQL chứ không ở JS: điểm `day` là một `date` không có múi giờ,
 * và `new Date("2026-09-06")` ở JS lại hiểu nó là nửa đêm UTC — đúng lúc múi giờ
 * âm thì nhãn lùi một ngày.
 */
const atLabel = (window: StatsWindow): Prisma.Sql =>
  window.granularity === "hour"
    ? Prisma.sql`to_char(d.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
    : Prisma.sql`to_char(d.at, 'YYYY-MM-DD')`;

export interface RecentEvaluations {
  evalCount: number;
  lastEvaluatedAt: Date | null;
}

/**
 * Lượt đánh giá của MỘT flag từ `since` trở đi, cộng mọi environment — chốt
 * archive 7 ngày (§3.4) và khối `archive` của phản hồi stats.
 *
 * `eval_count > 0` để một hàng rỗng (do rollup hay do lô bị bỏ) không giữ flag
 * lại mãi; `max(bucket_hour)` là lần đánh giá cuối ở độ phân giải giờ — đủ để nói
 * "archive được sau lúc nào".
 */
export async function recentEvaluationsOf(
  db: Reader,
  flagId: string,
  since: Date,
): Promise<RecentEvaluations> {
  const rows = await db.$queryRaw<
    { count: string; lastEvaluatedAt: Date | null }[]
  >`
    SELECT LEAST(COALESCE(sum(s.eval_count), 0), ${SAFE_MAX})::text AS count,
           max(s.bucket_hour)                                      AS "lastEvaluatedAt"
      FROM flag_evaluation_stats s
     WHERE s.flag_id = ${flagId}::uuid
       AND s.eval_count > 0
       AND s.bucket_hour >= ${since.toISOString()}::timestamptz`;
  const row = rows[0];
  return {
    evalCount: row === undefined ? 0 : countOf(row.count),
    lastEvaluatedAt: row?.lastEvaluatedAt ?? null,
  };
}

export interface VariantTotalRow {
  environmentId: string;
  variantKey: string;
  count: number;
  lastEvaluatedAt: Date;
}

/** Tổng theo (environment, variant) trong cửa sổ — `totals` và `byEnv[].variants` */
export async function variantTotalsOf(
  db: Reader,
  flagId: string,
  window: StatsWindow,
  environmentId?: string,
): Promise<VariantTotalRow[]> {
  const rows = await db.$queryRaw<
    {
      environmentId: string;
      variantKey: string;
      count: string;
      lastEvaluatedAt: Date;
    }[]
  >`
    SELECT s.environment_id::text AS "environmentId",
           s.variant_key          AS "variantKey",
           LEAST(sum(s.eval_count), ${SAFE_MAX})::text AS count,
           max(s.bucket_hour)     AS "lastEvaluatedAt"
      FROM flag_evaluation_stats s
     WHERE s.flag_id = ${flagId}::uuid
       AND s.eval_count > 0
       ${envFilterOf(environmentId)}
       ${windowFilter(window)}
     GROUP BY 1, 2
     ORDER BY 1, 2`;
  return rows.map((row) => ({ ...row, count: countOf(row.count) }));
}

export interface SeriesPointRow {
  environmentId: string;
  at: string;
  count: number;
}

/**
 * Series DÀY của từng environment CÓ dữ liệu trong cửa sổ.
 *
 * `CROSS JOIN` giữa tập environment và tập điểm rồi `LEFT JOIN` phần gộp: bucket
 * trống thành 0 ngay trong SQL, nên JS không phải dựng lại trục thời gian — chính
 * chỗ mà "start + i × 86 400 000" lệch một giờ sau ngày đổi giờ (V17).
 */
export async function seriesOf(
  db: Reader,
  flagId: string,
  window: StatsWindow,
  environmentId?: string,
): Promise<SeriesPointRow[]> {
  const rows = await db.$queryRaw<
    { environmentId: string; at: string; count: string }[]
  >`
    WITH agg AS (
      SELECT s.environment_id                        AS environment_id,
             ${bucketKey(window)}                    AS at,
             LEAST(sum(s.eval_count), ${SAFE_MAX})   AS count
        FROM flag_evaluation_stats s
       WHERE s.flag_id = ${flagId}::uuid
         AND s.eval_count > 0
         ${envFilterOf(environmentId)}
         ${windowFilter(window)}
       GROUP BY 1, 2
    ), envs AS (
      SELECT DISTINCT environment_id FROM agg
    ), points AS (
      ${seriesPoints(window)}
    )
    SELECT e.environment_id::text     AS "environmentId",
           ${atLabel(window)}         AS at,
           COALESCE(a.count, 0)::text AS count
      FROM envs e
     CROSS JOIN points d
      LEFT JOIN agg a
             ON a.environment_id = e.environment_id AND a.at = d.at
     ORDER BY e.environment_id, d.at`;
  return rows.map((row) => ({ ...row, count: countOf(row.count) }));
}

export interface StaleAggregateRow {
  flagId: string;
  environmentId: string;
  variantKey: string;
  countUnusedWindow: number;
  countSettledWindow: number;
  /** Cửa sổ chốt archive — cùng con số với 409 `FLAG_RECENTLY_EVALUATED` */
  countGuardWindow: number;
  lastEvaluatedAt: Date;
}

/**
 * MỘT câu cho cả trang Cleanup Center: tổng theo (flag, environment, variant) với
 * BA cửa sổ lồng nhau — `unusedSince` là cửa sổ ngoài (30 ngày), `settledSince`
 * (14 ngày) và `guardSince` (7 ngày) lấy bằng `FILTER` trên cùng lần quét.
 *
 * Ba câu riêng cho ba cửa sổ sẽ quét bảng ba lần trên cùng khoảng thời gian; và
 * `GROUP BY flag_id` là đúng khuyến nghị của R20 (h) cho 200 flag × 3 env × 30 ngày.
 *
 * `GROUP BY` là CỘT GỐC, không phải `GROUP BY 1, 2, 3` — đây là chỗ đắt nhất của
 * cả trang và khác biệt không hề nhỏ. `1, 2` trỏ vào cột KẾT QUẢ, tức vào
 * `flag_id::text` và `environment_id::text`, nên Postgres phải gọi `uuid_out` rồi
 * cấp phát một varlena 37 byte cho MỖI uuid của MỖI hàng — 1,7 triệu lần cấp phát
 * trên 864 000 hàng — chỉ để rồi băm chuỗi vừa dựng. Gộp theo `uuid` (16 byte, so
 * bằng memcmp) rồi mới ép `::text` ở 1 200 hàng KẾT QUẢ cho cùng các nhóm ấy, vì
 * `uuid → text` là đơn ánh nên phân hoạch không đổi. Đo thật ở 864 000 hàng:
 * `Execution Time` 382 ms ⇒ 260 ms, `width` của hàng vào bộ gộp 83 ⇒ 51 byte.
 *
 * `ORDER BY 1, 2, 3` thì GIỮ NGUYÊN trên cột kết quả, dù `ORDER BY` cột gốc đo
 * được nhanh hơn 0,2 ms: thứ tự hàng của câu này là thứ tự `byEnv` và `variants`
 * trong phản hồi (`stats.service.ts` đọc theo đúng thứ tự trả về), và thứ tự
 * `text` theo collation `en_US.UTF-8` chỉ TRÙNG với thứ tự nhị phân của `uuid`
 * nhờ hình dạng canonical của uuid — một lập luận đúng, nhưng không phải thứ nên
 * đem đổi lấy 0,2 ms. Sắp 1 200 hàng là chi phí đo được bằng 0.
 *
 * KHÔNG có index phủ `(flag_id, environment_id, variant_key, bucket_hour,
 * eval_count)`: đã dựng thật và đo, nó làm câu này CHẬM HƠN. Index 64 MB cho
 * `Index Only Scan` sạch (`Heap Fetches: 54`) nhưng Postgres chạy nó MỘT LUỒNG
 * mất 370 ms, còn `Parallel Seq Scan` trên heap 84 MB có thêm một worker nên chỉ
 * mất 260 ms — `max_parallel_workers_per_gather` = 1 vẫn là 2 tiến trình. Tệ hơn:
 * planner TƯỞNG index rẻ hơn (cost 29 186 < 32 355) nên hễ index tồn tại là nó tự
 * chọn kế hoạch chậm hơn. Thêm index ở đây vừa mất 64 MB, vừa thêm chi phí cho
 * UPSERT của telemetry, vừa làm trang chậm đi 32%.
 */
export async function staleAggregatesOf(
  db: Reader,
  flagIds: readonly string[],
  window: { unusedSince: Date; settledSince: Date; guardSince: Date },
): Promise<StaleAggregateRow[]> {
  if (flagIds.length === 0) return [];
  const rows = await db.$queryRaw<
    {
      flagId: string;
      environmentId: string;
      variantKey: string;
      countUnusedWindow: string;
      countSettledWindow: string;
      countGuardWindow: string;
      lastEvaluatedAt: Date;
    }[]
  >`
    SELECT s.flag_id::text        AS "flagId",
           s.environment_id::text AS "environmentId",
           s.variant_key          AS "variantKey",
           LEAST(sum(s.eval_count), ${SAFE_MAX})::text AS "countUnusedWindow",
           LEAST(COALESCE(sum(s.eval_count) FILTER (
                   WHERE s.bucket_hour >= ${window.settledSince.toISOString()}::timestamptz
                 ), 0), ${SAFE_MAX})::text              AS "countSettledWindow",
           LEAST(COALESCE(sum(s.eval_count) FILTER (
                   WHERE s.bucket_hour >= ${window.guardSince.toISOString()}::timestamptz
                 ), 0), ${SAFE_MAX})::text              AS "countGuardWindow",
           max(s.bucket_hour)     AS "lastEvaluatedAt"
      FROM flag_evaluation_stats s
     WHERE s.flag_id = ANY(${[...flagIds]}::text[]::uuid[])
       AND s.eval_count > 0
       AND s.bucket_hour >= ${window.unusedSince.toISOString()}::timestamptz
     GROUP BY s.flag_id, s.environment_id, s.variant_key
     ORDER BY 1, 2, 3`;
  return rows.map((row) => ({
    ...row,
    countUnusedWindow: countOf(row.countUnusedWindow),
    countSettledWindow: countOf(row.countSettledWindow),
    countGuardWindow: countOf(row.countGuardWindow),
  }));
}

/**
 * Lần báo cáo ĐẦU TIÊN của project — `telemetryStartedAt` của L2.
 *
 * Không có cửa sổ thời gian: đây là câu trả lời cho "project này quan sát được từ
 * bao giờ", và `null` nghĩa là chưa từng nhận báo cáo nào ⇒ KHÔNG xếp
 * UNUSED/SETTLED cho flag nào (R01 (c): ngay sau khi deploy, bảng còn rỗng).
 *
 * `ORDER BY bucket_hour LIMIT 1` chứ không `min(bucket_hour)`, dù hai câu cho cùng
 * một giá trị: `min` phải gộp MỌI hàng của project (đo được: quét song song 864 000
 * hàng ≈ 195 ms), còn dạng này đi theo index `bucket_hour` và dừng ở hàng đầu tiên
 * thuộc project (≈ 1 ms). Cùng lý lẽ với mọi "tồn tại hay không" của file này:
 * câu hỏi chỉ cần một hàng thì đừng đọc cả bảng.
 */
export async function firstReportAtOf(
  db: Reader,
  projectId: string,
): Promise<Date | null> {
  const rows = await db.$queryRaw<{ firstReportAt: Date }[]>`
    SELECT s.bucket_hour AS "firstReportAt"
      FROM flag_evaluation_stats s
      JOIN feature_flags f ON f.id = s.flag_id
     WHERE f.project_id = ${projectId}::uuid
     ORDER BY s.bucket_hour
     LIMIT 1`;
  return rows[0]?.firstReportAt ?? null;
}

export interface EnvironmentTelemetryRow {
  environmentId: string;
  /** Có khoá SERVER được dùng trong cửa sổ `telemetryGapDays` */
  serverKeyActive: boolean;
  /** Có khoá CLIENT được dùng trong cửa sổ `clientTrafficDays` */
  clientKeyActive: boolean;
  /** Có hàng stats nào trong cửa sổ `telemetryGapDays` */
  hasStats: boolean;
}

/**
 * Độ phủ telemetry của từng environment (V9) — nguồn của `telemetryGaps` và
 * `clientTrafficUnobserved`.
 *
 * Ba `EXISTS` trong MỘT câu thay vì ba câu: cả ba đều đi từ cùng danh sách
 * environment, và cả ba đều chỉ cần biết "có hay không". Khoá đã thu hồi vẫn được
 * tính: `last_used_at` trong cửa sổ nghĩa là đã có lưu lượng thật trong cửa sổ đó,
 * bất kể hôm nay khoá còn sống hay không.
 */
export async function environmentTelemetryOf(
  db: Reader,
  projectId: string,
  window: { serverSince: Date; clientSince: Date },
  environmentId?: string,
): Promise<EnvironmentTelemetryRow[]> {
  const serverSince = window.serverSince.toISOString();
  const only =
    environmentId === undefined
      ? Prisma.empty
      : Prisma.sql`AND e.id = ${environmentId}::uuid`;
  return db.$queryRaw<EnvironmentTelemetryRow[]>`
    SELECT e.id::text AS "environmentId",
           EXISTS (
             SELECT 1 FROM sdk_keys k
              WHERE k.environment_id = e.id
                AND k.key_type = 'SERVER'
                AND k.last_used_at >= ${serverSince}::timestamptz
           ) AS "serverKeyActive",
           EXISTS (
             SELECT 1 FROM sdk_keys k
              WHERE k.environment_id = e.id
                AND k.key_type = 'CLIENT'
                AND k.last_used_at >= ${window.clientSince.toISOString()}::timestamptz
           ) AS "clientKeyActive",
           EXISTS (
             SELECT 1 FROM flag_evaluation_stats s
              WHERE s.environment_id = e.id
                AND s.bucket_hour >= ${serverSince}::timestamptz
           ) AS "hasStats"
      FROM environments e
     WHERE e.project_id = ${projectId}::uuid
       ${only}
     ORDER BY e.id`;
}

export interface SummaryPointRow {
  flagId: string;
  at: string;
  count: number;
  /** Tổng cửa sổ chốt archive — lặp trên mọi điểm của cùng flag */
  evalCount7d: number;
}

/**
 * Sparkline `daily14` + `evalCount7d` của cả một trang danh sách flag, MỘT câu
 * (V19).
 *
 * `evalCount7d` dùng ĐÚNG cửa sổ của chốt archive (`guardSince`, theo giờ) chứ
 * không phải "7 ngày địa phương cuối" của sparkline: số trên huy hiệu và lý do
 * 409 `FLAG_RECENTLY_EVALUATED` phải là cùng một con số. Nó được lặp trên cả 14
 * điểm của flag — rẻ hơn một câu thứ hai, và bên gọi chỉ đọc một lần.
 */
export async function summarySeriesOf(
  db: Reader,
  flagIds: readonly string[],
  environmentId: string,
  window: StatsWindow,
  guardSince: Date,
): Promise<SummaryPointRow[]> {
  if (flagIds.length === 0) return [];
  const ids = Prisma.sql`ANY(${[...flagIds]}::text[]::uuid[])`;
  const rows = await db.$queryRaw<
    { flagId: string; at: string; count: string; evalCount7d: string }[]
  >`
    WITH agg AS (
      SELECT s.flag_id                               AS flag_id,
             ${bucketKey(window)}                    AS at,
             LEAST(sum(s.eval_count), ${SAFE_MAX})   AS count
        FROM flag_evaluation_stats s
       WHERE s.flag_id = ${ids}
         AND s.environment_id = ${environmentId}::uuid
         AND s.eval_count > 0
         ${windowFilter(window)}
       GROUP BY 1, 2
    ), week AS (
      SELECT s.flag_id                             AS flag_id,
             LEAST(sum(s.eval_count), ${SAFE_MAX}) AS count
        FROM flag_evaluation_stats s
       WHERE s.flag_id = ${ids}
         AND s.environment_id = ${environmentId}::uuid
         AND s.eval_count > 0
         AND s.bucket_hour >= ${guardSince.toISOString()}::timestamptz
       GROUP BY 1
    ), flags AS (
      SELECT x::uuid AS flag_id FROM unnest(${[...flagIds]}::text[]) AS x
    ), points AS (
      ${seriesPoints(window)}
    )
    SELECT f.flag_id::text          AS "flagId",
           ${atLabel(window)}       AS at,
           COALESCE(a.count, 0)::text AS count,
           COALESCE(w.count, 0)::text AS "evalCount7d"
      FROM flags f
     CROSS JOIN points d
      LEFT JOIN agg a ON a.flag_id = f.flag_id AND a.at = d.at
      LEFT JOIN week w ON w.flag_id = f.flag_id
     ORDER BY f.flag_id, d.at`;
  return rows.map((row) => ({
    ...row,
    count: countOf(row.count),
    evalCount7d: countOf(row.evalCount7d),
  }));
}

// ------------------------------------------------------------- đường GHI

export interface StatsRepository {
  /** Ghi một lô đã gộp (≤ `SDK_STATS.ingest.flushBatchRows` hàng) */
  upsertBatch(rows: readonly StatsRow[]): Promise<void>;
  /** Gộp ngày hàng giờ CŨ NHẤT quá hạn; trả số hàng giờ đã xoá (0 = hết việc) */
  rollupOldestDay(hourlyDays: number): Promise<number>;
}

export function createStatsRepository(prisma: PrismaClient): StatsRepository {
  return {
    async upsertBatch(rows) {
      if (rows.length === 0) return;
      if (rows.length > SDK_STATS.ingest.flushBatchRows) {
        throw new Error(
          `Lô stats ${String(rows.length)} hàng vượt flushBatchRows — chia lô trước khi ghi`,
        );
      }

      try {
        await prisma.$executeRaw(upsertStatsSql(rows));
      } catch (err) {
        /**
         * `23503` nghĩa là một environment (hoặc flag) biến mất trong khe giữa
         * lúc JOIN chọn hàng và lúc kiểm khoá ngoại. Chạy lại ĐÚNG câu đó một
         * lần là đủ: lần này JOIN không còn thấy env đã mất, nên lô đi qua mà
         * không cần tìm "hàng độc". Lỗi khác — và cả lần thử lại hỏng — ném lên
         * cho flusher giữ lại lô và thử ở lượt sau.
         */
        if (!hasSqlState(err, FOREIGN_KEY_VIOLATION)) throw err;
        await prisma.$executeRaw(upsertStatsSql(rows));
      }
    },

    async rollupOldestDay(hourlyDays) {
      const rows = await prisma.$queryRaw<{ deleted: number }[]>(
        rollupOldestDaySql(hourlyDays),
      );
      return rows[0]?.deleted ?? 0;
    },
  };
}

import { INT4_MAX, SDK_STATS } from "@udp/config/constants";
import { z } from "zod";
import { FLAG_TYPES } from "./flag-value.js";

/**
 * [v4.9] Hợp đồng ĐỌC số đếm đánh giá (§6.7, §9): stats theo flag, Cleanup Center
 * (`/flags/stale`) và sparkline của danh sách flag. Service 2 là nơi duy nhất biết
 * SQL của `flag_evaluation_stats`; Service 1 kiểm quyền, parse lại response bằng
 * đúng các schema này (lệch hợp đồng nổ ở biên, như `testerResultSchema`) rồi gắn
 * tên environment trước khi trả Portal.
 *
 * Query export object GỐC cộng hàm refine riêng, cùng khuôn `flag-api.ts`: mỗi
 * biên thêm trường của mình (`envId` ở S1, `environmentId`/`projectId` ở S2) rồi
 * mới `.strict()`, mà zod 3 không `.extend` được schema đã `superRefine`.
 */

type Refine<T> = (data: T, ctx: z.RefinementCtx) => void;

const HOUR_MS = 3_600_000;

/**
 * Đầu giờ UTC chứa `at` — khoá bucket của `flag_evaluation_stats`.
 *
 * MỘT công thức cho bộ gộp của Service 2 (bucket = giờ server NHẬN báo cáo), chốt
 * archive 7 ngày và test dựng dữ liệu: lệch nhau một giờ là một lượt đánh giá rơi
 * ra ngoài cửa sổ mà không ai thấy.
 */
export function hourFloor(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Mốc lùi `hours` giờ / `days` ngày — MỘT công thức cho mọi cửa sổ của §6.7 (chốt
 * archive, Cleanup Center, sparkline). Ngày ở đây là 24 giờ CHẴN, không phải ngày
 * địa phương: biên cửa sổ phải độc lập với múi giờ người xem, còn việc chia điểm
 * theo ngày địa phương là chuyện của SQL sinh series.
 */
export const hoursBefore = (at: Date, hours: number): Date =>
  new Date(at.getTime() - hours * HOUR_MS);

export const hoursAfter = (at: Date, hours: number): Date =>
  hoursBefore(at, -hours);

export const daysBefore = (at: Date, days: number): Date =>
  hoursBefore(at, days * 24);

/**
 * Hình dạng múi giờ: `UTC` hoặc tên IANA dạng `Area/Location[/…]`.
 *
 * Từ chối dạng POSIX có chủ ý: Postgres hiểu `UTC+7` theo quy ước POSIX, tức
 * UTC−7 — người dùng ở Việt Nam gõ đúng thứ mình nghĩ và nhận series lệch 14 giờ.
 * Hình dạng đúng chưa đủ: bên nhận còn phải tra tên trong `pg_timezone_names`
 * (`loadTimezoneNames` của `@udp/db`), vì tzdata của ICU và của Postgres có thể
 * khác nhau.
 */
export const tzSchema = z
  .string()
  .max(SDK_STATS.query.tzMaxLength)
  .regex(
    /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/,
    "Múi giờ phải là UTC hoặc tên IANA dạng Area/Location",
  );

export const STATS_GRANULARITIES = ["hour", "day"] as const;

const isoInstant = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative();

// ------------------------------------------------------------- stats theo flag

export const flagStatsQueryFields = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(SDK_STATS.query.maxDays)
    .default(SDK_STATS.query.defaultDays),
  granularity: z.enum(STATS_GRANULARITIES).default("day"),
  tz: tzSchema.default("UTC"),
});

/** Bucket giờ chỉ cho cửa sổ ngắn: 90 ngày × 24 điểm là một biểu đồ không đọc được */
export const flagStatsQueryRefine: Refine<
  z.infer<typeof flagStatsQueryFields>
> = (query, ctx) => {
  if (
    query.granularity === "hour" &&
    query.days > SDK_STATS.query.maxHourlyDays
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["granularity"],
      message: `granularity=hour chỉ khi days ≤ ${SDK_STATS.query.maxHourlyDays}`,
    });
  }
};

/**
 * Trạng thái archive của một flag — cùng dữ liệu với chốt 409
 * `FLAG_RECENTLY_EVALUATED`, ở dạng có cấu trúc: Problem chỉ mang `detail` bằng
 * lời, Portal đọc số liệu ở đây trước khi mở hộp thoại archive.
 */
export const archiveStatusSchema = z.object({
  allowed: z.boolean(),
  blockedBy: z.enum(["RECENT_EVALUATIONS", "LIVE_ROLLOUT"]).optional(),
  evalCount7d: count,
  lastEvaluatedAt: isoInstant.nullable(),
  /** Mốc sớm nhất archive được nếu từ giờ không còn lượt nào */
  archivableAfter: isoInstant.optional(),
  rolloutId: z.string().uuid().optional(),
});

/** Cặp (variant, số lượt); `__disabled__`/`__error__` giữ nguyên key, Portal tự đặt nhãn */
const variantCount = z.object({ variantKey: z.string(), count });

export const flagStatsResponseSchema = z.object({
  window: z.object({
    from: isoInstant,
    to: isoInstant,
    granularity: z.enum(STATS_GRANULARITIES),
    tz: tzSchema,
  }),
  totals: z.object({
    evalCount: count,
    lastEvaluatedAt: isoInstant.nullable(),
  }),
  byEnv: z.array(
    z.object({
      environmentId: z.string().uuid(),
      evalCount: count,
      lastEvaluatedAt: isoInstant.nullable(),
      variants: z.array(
        variantCount.extend({
          share: z.number().min(0).max(1),
          /** `false` với variant đã bị xoá khỏi flag */
          known: z.boolean(),
        }),
      ),
      /**
       * Dày: đủ mọi bucket của cửa sổ, bucket trống = 0. `at` là ngày địa phương
       * `YYYY-MM-DD` với granularity `day`, mốc ISO với `hour`.
       */
      series: z.array(
        z.object({
          at: z.union([z.string().date(), isoInstant]),
          count,
        }),
      ),
    }),
  ),
  archive: archiveStatusSchema,
  /** Có env mà CLIENT key được dùng gần đây — OFREP bulk không đếm, số ở đây là cận dưới */
  clientTrafficUnobserved: z.boolean(),
  /** Env có SERVER key được dùng mà không có hàng stats nào */
  telemetryGaps: z.array(z.string().uuid()),
});

// ------------------------------------------------------------- Cleanup Center

export const STALE_CATEGORIES = ["UNUSED", "SETTLED", "STALE_DRAFT"] as const;

export const staleFlagsQuerySchema = z.object({
  category: z.enum(STALE_CATEGORIES).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SDK_STATS.query.staleList.maxLimit)
    .default(SDK_STATS.query.staleList.defaultLimit),
  // OFFSET của Postgres nhận bigint, nhưng số cực lớn vẫn là 22003 ⇒ 500 thay vì 400
  offset: z.coerce.number().int().min(0).max(INT4_MAX).default(0),
});

export const staleFlagsResponseSchema = z.object({
  telemetry: z.object({
    /** `null` = project chưa từng nhận báo cáo: chưa xét UNUSED/SETTLED */
    firstReportAt: isoInstant.nullable(),
    observedDays: count,
  }),
  telemetryGaps: z.array(z.string().uuid()),
  /** Toàn bộ, không theo trang — cho tab và badge */
  counts: z.object({ UNUSED: count, SETTLED: count, STALE_DRAFT: count }),
  total: count,
  items: z.array(
    z.object({
      flag: z.object({
        id: z.string().uuid(),
        key: z.string(),
        description: z.string().nullable(),
        lifecycleStatus: z.enum(["DRAFT", "ACTIVE"]),
        flagType: z.enum(FLAG_TYPES),
        createdAt: isoInstant,
        activatedAt: isoInstant.nullable(),
        /** = `lastKnownUpdatedAt` khi archive */
        updatedAt: isoInstant,
      }),
      category: z.enum(STALE_CATEGORIES),
      lastEvaluatedAt: isoInstant.nullable(),
      evalCount30d: count,
      /** Chỉ với SETTLED: variant duy nhất nhận mọi lượt */
      settled: variantCount.optional(),
      /** Cửa sổ `STALE_FLAG_THRESHOLDS.settledDays`, cộng mọi env */
      distribution: z.array(variantCount),
      byEnv: z.array(
        z.object({
          environmentId: z.string().uuid(),
          evalCount14d: count,
          variants: z.array(variantCount),
        }),
      ),
      archive: archiveStatusSchema,
      clientTrafficUnobserved: z.boolean(),
    }),
  ),
});

// ------------------------------------------------------------- danh sách flag

/** `GET /flags?include=stats` — MỘT truy vấn gộp cho cả trang */
export const flagStatsSummarySchema = z.object({
  items: z.array(
    z.object({
      flagId: z.string().uuid(),
      evalCount7d: count,
      daily14: z.array(count).length(SDK_STATS.query.sparklineDays),
    }),
  ),
});

export type ArchiveStatus = z.infer<typeof archiveStatusSchema>;
export type StatsGranularity = (typeof STATS_GRANULARITIES)[number];
export type FlagStatsQuery = z.infer<typeof flagStatsQueryFields>;
export type FlagStatsResponse = z.infer<typeof flagStatsResponseSchema>;
export type StaleCategory = (typeof STALE_CATEGORIES)[number];
export type StaleFlagsQuery = z.infer<typeof staleFlagsQuerySchema>;
export type StaleFlagsResponse = z.infer<typeof staleFlagsResponseSchema>;
export type FlagStatsSummary = z.infer<typeof flagStatsSummarySchema>;

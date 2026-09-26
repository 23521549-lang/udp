import { STALE_FLAG_THRESHOLDS } from "@udp/config";
import { FlagLifecycleStatus, type FlagType, type RuleType } from "@udp/db";
import {
  createFlagFields,
  createFlagRefine,
  evaluationContextSchema,
  flagKeySchema,
  flagStatsQueryFields,
  flagStatsQueryRefine,
  replaceRulesFields,
  replaceRulesRefine,
  staleFlagsQuerySchema,
  tzSchema,
  updateEnvConfigFields,
  updateEnvConfigRefine,
  updateFlagFields,
  updateFlagRefine,
  type ErrorCode,
  type FlagServe,
  type FlagStatsResponse,
  type FlagStatsSummary,
} from "@udp/shared-types";
import { z } from "zod";

/**
 * Hợp đồng HTTP của Luồng 4 ở Service 1 (§8.4, §9 "Feature Flag") [v4.5].
 *
 * Body ghi cấu hình là HỢP ĐỒNG DÙNG CHUNG với biên trong của Service 2
 * (`@udp/shared-types/flag-api`): S1 và S2 không thể hiểu cùng một request theo
 * hai cách. S1 chỉ thêm `confirmFlagKey` — xác nhận hai bước trên production
 * (§8.4) — và bóc nó ra trước khi gửi xuống S2 (biên trong là `.strict()`).
 */

/** Gõ lại key của flag — Portal hỏi khi Service 1 trả 428 `CONFIRMATION_REQUIRED` */
const confirmFlagKey = flagKeySchema.optional();

export const createFlagBodySchema = createFlagFields
  .strict()
  .superRefine(createFlagRefine);
export type CreateFlagBody = z.infer<typeof createFlagBodySchema>;

export const updateFlagBodySchema = updateFlagFields
  .extend({ confirmFlagKey })
  .strict()
  .superRefine(updateFlagRefine);
export type UpdateFlagBody = z.infer<typeof updateFlagBodySchema>;

export const updateEnvBodySchema = updateEnvConfigFields
  .extend({ confirmFlagKey })
  .strict()
  .superRefine(updateEnvConfigRefine);
export type UpdateEnvBody = z.infer<typeof updateEnvBodySchema>;

export const replaceRulesBodySchema = replaceRulesFields
  .strict()
  .superRefine(replaceRulesRefine);
export type ReplaceRulesBody = z.infer<typeof replaceRulesBodySchema>;

/**
 * [v4.6] Flag Evaluation Tester (§10.12). Validate ở S1 bằng CÙNG schema với S2:
 * một 400 của S2 tới S1 là lỗi hợp đồng (500), không phải lỗi của người dùng.
 */
export const evaluateBodySchema = z
  .object({ envId: z.string().uuid(), context: evaluationContextSchema })
  .strict();
export type EvaluateBody = z.infer<typeof evaluateBodySchema>;

export const listFlagsQuerySchema = z
  .object({
    /** Có ⇒ mỗi hàng kèm trạng thái của flag ở environment đó (§10.14 khoá theo envId) */
    envId: z.string().uuid().optional(),
    /** Tìm trong key và mô tả, không phân biệt hoa thường */
    search: z.string().trim().min(1).max(100).optional(),
    status: z.nativeEnum(FlagLifecycleStatus).optional(),
    /** [v4.11, Plan #41] Chỉ flag đang bật (hay đang tắt) ở `envId` — tổng quan đếm bằng nó */
    isEnabled: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    /** [v4.9] `stats` ⇒ mỗi hàng kèm `evalCount7d` và sparkline 14 ngày (§3.1) */
    include: z.literal("stats").optional(),
    tz: tzSchema.default("UTC"),
  })
  .strict()
  .superRefine((query, ctx) => {
    /**
     * Số đếm luôn thuộc về MỘT environment (bảng stats khoá theo env), nên
     * `include=stats` mà không nói env nào là một câu hỏi không có câu trả lời —
     * 400 ở đây rõ hơn là gộp mọi env lại rồi để người đọc tự đoán.
     */
    if (query.include === "stats" && query.envId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["envId"],
        message: "include=stats cần envId",
      });
    }
    // Bật/tắt là trạng thái Ở MỘT environment — cùng lý lẽ với `include=stats`
    if (query.isEnabled !== undefined && query.envId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["envId"],
        message: "isEnabled cần envId",
      });
    }
  });
export type ListFlagsQuery = z.infer<typeof listFlagsQuerySchema>;

/** [v4.9] `GET /flags/:flagId/stats` — `envId` là tên của S1 cho `environmentId` */
export const flagStatsQuerySchema = flagStatsQueryFields
  .extend({ envId: z.string().uuid().optional() })
  .strict()
  .superRefine(flagStatsQueryRefine);
export type FlagStatsQueryBody = z.infer<typeof flagStatsQuerySchema>;

/** [v4.9] `GET /flags/stale` — hình dùng chung, chỉ thêm `.strict()` của biên ngoài */
export const staleFlagsQueryBodySchema = staleFlagsQuerySchema.strict();
export type StaleFlagsQueryBody = z.infer<typeof staleFlagsQueryBodySchema>;

/**
 * [v4.9] `POST /flags/bulk-archive` (V16).
 *
 * `confirmProjectName` là TUỲ CHỌN trong schema và bắt buộc trong service: thiếu
 * nó phải là 428 `CONFIRMATION_REQUIRED` — Portal mở hộp xác nhận rồi gửi lại —
 * còn 400 chỉ nói "body sai" và không mở hộp nào (F10). Sai KIỂU thì vẫn là 400:
 * một số hay một boolean ở đó là lỗi của client, không phải của người dùng.
 */
export const bulkArchiveBodySchema = z
  .object({
    flags: z
      .array(
        z
          .object({
            flagId: z.string().uuid(),
            lastKnownUpdatedAt: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .min(1)
      .max(STALE_FLAG_THRESHOLDS.bulkArchiveMax),
    confirmProjectName: z.string().max(255).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const ids = body.flags.map((flag) => flag.flagId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["flags"],
        message: "Một flag xuất hiện hai lần trong lô",
      });
    }
  });
export type BulkArchiveBody = z.infer<typeof bulkArchiveBodySchema>;

// ------------------------------------------------------------- response

export interface FlagEnvState {
  environment: { id: string; name: string; isProduction: boolean };
  configId: string;
  isEnabled: boolean;
  defaultVariantId: string | null;
  /** Đang gắn nhãn `ff` cho một rollout (§6.6) */
  isTracked: boolean;
  ruleCount: number;
  /** Mốc optimistic lock của env-config — `lastKnownUpdatedAt` của lần PUT rule */
  updatedAt: string;
}

export interface FlagSummary {
  id: string;
  key: string;
  flagType: FlagType;
  description: string | null;
  lifecycleStatus: FlagLifecycleStatus;
  /** Lần chuyển sang ACTIVE gần nhất (trigger DB đặt); chưa từng kích hoạt thì null */
  activatedAt: string | null;
  updatedAt: string;
  /** Chỉ khi truy vấn có `envId` */
  env?: Omit<FlagEnvState, "environment" | "defaultVariantId" | "updatedAt">;
  /** [v4.9] Chỉ khi truy vấn có `include=stats` — số của environment đã chọn */
  stats?: Omit<FlagStatsSummary["items"][number], "flagId">;
}

/**
 * [v4.9] Stats theo flag như Portal nhận: hình của S2, nhưng mỗi environment mang
 * TÊN thay vì chỉ id.
 *
 * Tên environment là dữ liệu của Service 1 (`environments` là bảng của S1 về mặt
 * ghi), và S2 không đọc nó cho đường này — nên phép ghép xảy ra ở đây, đúng một
 * lần, thay vì để Portal tự tra bằng một lời gọi thứ hai.
 */
export interface FlagStatsEnvView extends Omit<
  FlagStatsResponse["byEnv"][number],
  "environmentId"
> {
  environment: { id: string; name: string; isProduction: boolean };
}

export interface FlagStatsView extends Omit<FlagStatsResponse, "byEnv"> {
  byEnv: FlagStatsEnvView[];
}

/**
 * [v4.9] Kết quả của MỘT flag trong lô archive (V16).
 *
 * Lô không nguyên tử: mỗi flag là một transaction riêng ở S2 (R31), nên phản hồi
 * phải nói được từng flag một. Problem của S2 đi lên nguyên vẹn — Portal đã biết
 * dịch `code`, nên không cần một từ vựng lỗi thứ hai chỉ cho lô.
 */
export interface BulkArchiveProblem {
  status: number;
  title: string;
  detail?: string;
  code?: ErrorCode;
  resourceId?: string;
}

export type BulkArchiveOutcome =
  | { flagId: string; ok: true; flag: FlagDetail }
  | { flagId: string; ok: false; problem: BulkArchiveProblem };

export interface FlagVariantView {
  id: string;
  key: string;
  value: unknown;
}

export interface FlagDetail {
  id: string;
  key: string;
  flagType: FlagType;
  description: string | null;
  lifecycleStatus: FlagLifecycleStatus;
  stickinessAttribute: string;
  defaultVariantId: string | null;
  permanent: boolean;
  /** Lần chuyển sang ACTIVE gần nhất (trigger DB đặt); chưa từng kích hoạt thì null */
  activatedAt: string | null;
  createdAt: string;
  /** Mốc optimistic lock của flag — `lastKnownUpdatedAt` của lần PATCH */
  updatedAt: string;
  variants: FlagVariantView[];
  envs: FlagEnvState[];
}

/**
 * Rule của một env-config, ĐỦ để sửa rồi PUT lại: `id` (giữ `bucket_salt`, I1) và
 * `updatedAt` (optimistic lock). Không có `bucketSalt`: bí mật phân nhóm không rời
 * máy chủ.
 */
export interface RuleView {
  id: string;
  priority: number;
  ruleType: RuleType;
  condition: unknown;
  /** [v4.11] Có hình — `sendJson` kiểm nó bằng `ruleWire` trước khi lên dây */
  serve: FlagServe;
  description: string | null;
}

export interface RulesView {
  updatedAt: string;
  rules: RuleView[];
}

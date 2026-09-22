import { FlagLifecycleStatus, type FlagType } from "@udp/db";
import {
  createFlagFields,
  createFlagRefine,
  evaluationContextSchema,
  flagKeySchema,
  replaceRulesFields,
  replaceRulesRefine,
  updateEnvConfigFields,
  updateEnvConfigRefine,
  updateFlagFields,
  updateFlagRefine,
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
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListFlagsQuery = z.infer<typeof listFlagsQuerySchema>;

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
  updatedAt: string;
  /** Chỉ khi truy vấn có `envId` */
  env?: Omit<FlagEnvState, "environment" | "defaultVariantId" | "updatedAt">;
}

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
  ruleType: string;
  condition: unknown;
  serve: unknown;
  description: string | null;
}

export interface RulesView {
  updatedAt: string;
  rules: RuleView[];
}

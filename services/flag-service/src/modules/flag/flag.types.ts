import { z } from "zod";
import {
  createFlagFields,
  createFlagRefine,
  evaluationContextSchema,
  replaceVariantsFields,
  replaceVariantsRefine,
  updateFlagFields,
  updateFlagRefine,
} from "@udp/shared-types";
import type { FlagLifecycleStatus, FlagType } from "@udp/db";

/**
 * Hợp đồng của `/internal/flags` (§8.4, §9).
 *
 * Đây là API máy-tới-máy: Portal gọi `/api/v1/projects/:id/flags` của Service 1,
 * S1 xác thực và kiểm quyền rồi mới gọi xuống đây. Hình của body là HỢP ĐỒNG DÙNG
 * CHUNG ở `@udp/shared-types/flag-api` [v4.5]; ở đây chỉ thêm thứ riêng của biên
 * trong: `projectId` (S1 lấy từ URL) và `.strict()`.
 */

export const createFlagSchema = createFlagFields
  .extend({ projectId: z.string().uuid() })
  .strict()
  .superRefine(createFlagRefine);

export const updateFlagSchema = updateFlagFields
  .strict()
  .superRefine(updateFlagRefine);

/** [v4.11, Plan #44] `PUT /internal/flags/:id/variants` — S1 đã bóc `confirmFlagKey` */
export const replaceVariantsSchema = replaceVariantsFields
  .strict()
  .superRefine(replaceVariantsRefine);

/** [v4.6] Flag Evaluation Tester — context cùng trần với OFREP */
export const evaluateFlagSchema = z
  .object({
    environmentId: z.string().uuid(),
    context: evaluationContextSchema,
  })
  .strict();

export type CreateFlagInput = z.infer<typeof createFlagSchema>;
export type EvaluateFlagInput = z.infer<typeof evaluateFlagSchema>;
export type ReplaceVariantsInput = z.infer<typeof replaceVariantsSchema>;
export type UpdateFlagInput = z.infer<typeof updateFlagSchema>;

export interface PublicFlag {
  id: string;
  projectId: string;
  key: string;
  flagType: FlagType;
  description: string | null;
  lifecycleStatus: FlagLifecycleStatus;
  defaultVariantId: string | null;
  stickinessAttribute: string;
  /** [v4.9] Miễn cảnh báo UNUSED/SETTLED của Cleanup Center (§6.7) */
  permanent: boolean;
  /** Lần chuyển sang ACTIVE gần nhất — trigger DB đặt; DRAFT chưa kích hoạt thì null */
  activatedAt: Date | null;
  updatedAt: Date;
  variants: { id: string; key: string; value: unknown }[];
}

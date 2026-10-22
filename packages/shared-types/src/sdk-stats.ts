import { SDK_STATS } from "@udp/config/constants";
import { z } from "zod";
import type { Evaluation } from "./evaluation.js";
import { flagKeySchema } from "./flag-api.js";

/**
 * [v4.9] Hợp đồng dây của `POST /sdk/stats` (§2.2 FlagEvaluationStat, §6.8) — MỘT
 * định nghĩa cho provider (gửi) và Service 2 (nhận), cùng lý do với `flag-api.ts`.
 */

/**
 * Hai nhãn stats KHÔNG phải variant: lượt đánh giá trả DISABLED (flag tắt ở env,
 * hoặc bia mộ ARCHIVED) và lượt lỗi của một flag CÓ trong snapshot. Tiền tố `__`
 * bị cấm ở key variant (`flag-api.ts`), nên hai chuỗi này không bao giờ trùng một
 * variant thật. Chỉ được khai ở đây — design-lint canh (INV-23.7).
 */
export const STATS_VARIANT = {
  disabled: "__disabled__",
  error: "__error__",
} as const;

/**
 * Nhãn stats của MỘT lần đánh giá, hoặc `undefined` = không đếm.
 *
 * Provider (đánh giá tại chỗ) và OFREP (đánh giá ở Service 2) cùng gọi hàm này,
 * nên cùng một kết quả luôn mang cùng một nhãn (INV-23.9) — cùng lý do với I26.
 *
 * `FLAG_NOT_FOUND` và `PROVIDER_NOT_READY` không đếm: key lạ do ứng dụng khách tự
 * gõ sẽ làm phình bộ đếm trong tiến trình của họ, và Service 2 cũng bỏ qua flag
 * không có trong snapshot. `__error__` vì vậy chỉ dành cho flag CÓ mặt mà đánh
 * giá lỗi (cấu hình hỏng, sai kiểu).
 */
export function statsVariantOf(evaluation: Evaluation): string | undefined {
  if (
    evaluation.errorCode === "FLAG_NOT_FOUND" ||
    evaluation.errorCode === "PROVIDER_NOT_READY"
  ) {
    return undefined;
  }
  if (evaluation.reason === "ERROR") return STATS_VARIANT.error;
  // Lõi chỉ bỏ trống `variant` ở DISABLED (kể cả bia mộ) và ERROR — ERROR đã ở trên
  return evaluation.variant ?? STATS_VARIANT.disabled;
}

/**
 * Báo cáo của provider.
 *
 * `.strip()` ở CẢ BA cấp (báo cáo, `sdk`, từng mục) là tương thích TIẾN: provider
 * mới thêm trường thì Service 2 cũ bỏ qua nó, thay vì từ chối cả báo cáo và làm
 * mất số đếm. Giá trị của các trường ĐÃ BIẾT vẫn kiểm chặt — sai ⇒ 400.
 *
 * Không có mốc thời gian: bucket là giờ Service 2 NHẬN báo cáo, không tin đồng hồ
 * của máy khách.
 */
export const sdkStatsReportSchema = z
  .object({
    counts: z
      .array(
        z
          .object({
            flagKey: flagKeySchema,
            // FlagVariant.key là VARCHAR(100)
            variant: z.string().min(1).max(100),
            count: z
              .number()
              .int()
              .min(1)
              .max(SDK_STATS.report.maxCountPerEntry),
          })
          .strip(),
      )
      .min(1)
      .max(SDK_STATS.report.maxEntriesPerReport),
    /** Chỉ để ghi log */
    sdk: z
      .object({
        name: z.string().max(SDK_STATS.report.sdkLabelMaxLength).optional(),
        version: z.string().max(SDK_STATS.report.sdkLabelMaxLength).optional(),
      })
      .strip()
      .optional(),
  })
  .strip();

export type SdkStatsReport = z.infer<typeof sdkStatsReportSchema>;

import { z } from "zod";

/**
 * Hợp đồng của `PATCH /internal/flag-envs/:id` (§9, §8.4).
 *
 * Hai trường, cả hai tuỳ chọn nhưng phải có ÍT NHẤT MỘT. §3.2 giao cho module
 * `env-config` đúng hai việc — "bật/tắt và default variant theo env" — và
 * `PATCH` này là đường DUY NHẤT §9 mở ra cho `FlagEnvConfig`. Chỉ nhận
 * `isEnabled` thì override default variant của từng environment không có đường
 * nào để đặt, trong khi cả evaluator lẫn snapshot đều đọc nó (§6.5).
 *
 * `.strict()`: một trường gõ sai tên (`isEnable`) mà bị nuốt im lặng thì request
 * trả 200 trong khi không có gì đổi — người gọi tin là đã bật flag.
 */
export const updateEnvConfigSchema = z
  .object({
    isEnabled: z.boolean().optional(),
    /**
     * `null` = bỏ override, quay về default của flag (§6.5:
     * `envConfig.defaultVariantId ?? flag.defaultVariantId`).
     *
     * Quyền sở hữu — variant phải thuộc CHÍNH flag này — do trigger ở tầng
     * database cưỡng chế (`orphan_rule_hardening`), nên vi phạm tới đây dưới dạng
     * 422 `ORPHAN_RULE`. Kiểm lại ở đây là viết bản cài đặt thứ hai của cùng một
     * luật, và hai bản thì trôi khỏi nhau.
     */
    defaultVariantId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine(
    (d) => d.isEnabled !== undefined || d.defaultVariantId !== undefined,
    { message: "Phải có ít nhất một trong isEnabled, defaultVariantId" },
  );

export type UpdateEnvConfigInput = z.infer<typeof updateEnvConfigSchema>;

export interface PublicEnvConfig {
  id: string;
  flagId: string;
  environmentId: string;
  isEnabled: boolean;
  defaultVariantId: string | null;
  updatedAt: Date;
}

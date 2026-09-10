import { z } from "zod";
import { FLAG_TYPES, FLAG_VALUE_SCHEMAS } from "@udp/shared-types";
import type { FlagLifecycleStatus, FlagType } from "@udp/db";

/**
 * Hợp đồng của `/internal/flags` (§8.4, §9).
 *
 * Đây là API máy-tới-máy: Portal gọi `/api/v1/projects/:id/flags` của Service 1,
 * S1 xác thực và kiểm quyền rồi mới gọi xuống đây. Nên ở tầng này không có gì về
 * người dùng ngoài `X-Udp-Actor-Id` để ghi vào outbox.
 */

const flagKey = z
  .string()
  .trim()
  .min(1, "Chưa có key")
  .max(255)
  /**
   * Key đi vào nhãn Prometheus (`ff="<key>=<variant>"`, §6.6) và vào URL của
   * SDK. Cho phép khoảng trắng hay dấu là mời một lớp lỗi thoát chuỗi ở ba nơi
   * khác nhau về sau.
   */
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "Key chỉ gồm chữ thường, số và dấu gạch ngang",
  );

const variantKey = z.string().trim().min(1).max(100);

export const createFlagSchema = z
  .object({
    projectId: z.string().uuid(),
    key: flagKey,
    /** Một danh sách cho cả hệ thống — chốt với enum Prisma ở design-lint */
    flagType: z.enum(FLAG_TYPES),
    /**
     * TUỲ CHỌN với `BOOLEAN`: §2.2 nói flag boolean tự sinh hai variant `on` và
     * `off`. Bắt người gọi khai lại hai thứ đó là mời họ khai sai.
     */
    variants: z
      .array(z.object({ key: variantKey, value: z.unknown() }))
      .min(2, "Flag phải có ít nhất hai variant")
      .optional(),
    /** Key của variant làm mặc định; thiếu thì lấy variant đầu tiên */
    defaultVariantKey: variantKey.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.flagType !== "BOOLEAN" && data.variants === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["variants"],
        message:
          "Chỉ flag BOOLEAN mới tự sinh variant; các kiểu khác phải khai",
      });
    }

    const keys = data.variants?.map((v) => v.key) ?? [];
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["variants"],
        message: "Key variant bị trùng",
      });
    }

    /**
     * Giá trị phải khớp kiểu flag (§2.2). Thiếu chốt này thì flag `STRING` nhận được
     * variant mang số, và lỗi chỉ lộ ra ở SDK của khách dưới dạng `TYPE_MISMATCH` —
     * xa khỏi chỗ gây ra nó, và sau khi nó đã được phục vụ cho mọi người dùng.
     */
    for (const [i, v] of (data.variants ?? []).entries()) {
      if (!FLAG_VALUE_SCHEMAS[data.flagType].safeParse(v.value).success) {
        ctx.addIssue({
          code: "custom",
          path: ["variants", i, "value"],
          message: `Giá trị không khớp kiểu flag ${data.flagType}`,
        });
      }
    }

    if (
      data.defaultVariantKey !== undefined &&
      keys.length > 0 &&
      !keys.includes(data.defaultVariantKey)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultVariantKey"],
        message: "defaultVariantKey không nằm trong danh sách variant",
      });
    }
  });

export const updateFlagSchema = z.object({
  /**
   * Optimistic lock. §2.2 dùng `FeatureFlag.updated_at` làm mốc so sánh — bảng
   * không có cột `version` riêng. Thiếu trường này thì hai người sửa cùng lúc,
   * người lưu sau ghi đè người lưu trước mà không ai biết.
   */
  lastKnownUpdatedAt: z.string().datetime({ offset: true }),
  description: z.string().trim().max(1000).nullable().optional(),
  lifecycleStatus: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
  stickinessAttribute: z.string().trim().min(1).max(100).optional(),
});

export type CreateFlagInput = z.infer<typeof createFlagSchema>;
export type UpdateFlagInput = z.infer<typeof updateFlagSchema>;

export interface PublicFlag {
  id: string;
  projectId: string;
  key: string;
  flagType: FlagType;
  lifecycleStatus: FlagLifecycleStatus;
  defaultVariantId: string | null;
  stickinessAttribute: string;
  updatedAt: Date;
  variants: { id: string; key: string; value: unknown }[];
}

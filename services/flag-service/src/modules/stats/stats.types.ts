import { isTest, SDK_STATS } from "@udp/config";
import { UUID_PATTERN } from "@udp/http";
import {
  flagStatsQueryFields,
  flagStatsQueryRefine,
  staleFlagsQuerySchema,
  tzSchema,
} from "@udp/shared-types";
import { z } from "zod";

/**
 * Hợp đồng của ba route ĐỌC stats ở biên trong (§3.2).
 *
 * Cùng khuôn `flag.types.ts`: hình dùng chung nằm ở `@udp/shared-types`, ở đây chỉ
 * thêm thứ riêng của biên trong (`environmentId`, `projectId`, `flagIds`) rồi
 * `.strict()`.
 */

/**
 * `asOf` là SEAM cho test (T3), không phải tham số của API.
 *
 * Mọi cửa sổ của §6.7 đo từ một mốc "bây giờ", và test của biên chính xác tới giờ
 * không được phụ thuộc đồng hồ máy chạy test. `NODE_ENV` là bắt buộc và không có
 * mặc định (`env.ts`), nên production không có đường nhận tham số này: gửi nó vào
 * một tiến trình production là 400, không phải một cửa sổ bị dịch.
 */
const asOfField = { asOf: z.string().datetime({ offset: true }).optional() };

const refuseAsOfOutsideTests: (
  data: { asOf?: string | undefined },
  ctx: z.RefinementCtx,
) => void = (data, ctx) => {
  if (data.asOf !== undefined && !isTest) {
    ctx.addIssue({
      code: "custom",
      path: ["asOf"],
      message: "asOf chỉ nhận khi NODE_ENV=test",
    });
  }
};

export const internalFlagStatsQuerySchema = flagStatsQueryFields
  .extend({ environmentId: z.string().uuid().optional(), ...asOfField })
  .strict()
  .superRefine((data, ctx) => {
    flagStatsQueryRefine(data, ctx);
    refuseAsOfOutsideTests(data, ctx);
  });

export const internalStaleFlagsQuerySchema = staleFlagsQuerySchema
  .extend({ projectId: z.string().uuid(), ...asOfField })
  .strict()
  .superRefine(refuseAsOfOutsideTests);

/**
 * `flagIds` là CSV chứ không phải `flagIds[]` lặp lại: một trang danh sách flag
 * gọi route này đúng một lần với tối đa `summaryMaxFlags` id, và CSV giữ URL ngắn
 * hơn giới hạn của mọi proxy trên đường (100 × 37 ký tự ≈ 3,7 KB).
 *
 * Kiểm ở dạng CHUỖI rồi tách ở `flagIdsOf`, không `.transform()` thành mảng ngay
 * trong schema: `validateQuery` đòi schema có kiểu vào bằng kiểu ra (nó GHI ĐÈ
 * `req.query` bằng kết quả parse), nên một trường đổi kiểu sẽ khoá cả schema khỏi
 * middleware đó.
 */
const flagIdsCsv = z
  .string()
  .min(1)
  .superRefine((raw, ctx) => {
    const ids = raw.split(",");
    if (ids.length > SDK_STATS.query.summaryMaxFlags) {
      ctx.addIssue({
        code: "custom",
        message: `Tối đa ${String(SDK_STATS.query.summaryMaxFlags)} flag mỗi lần`,
      });
    }
    if (!ids.every((id) => UUID_PATTERN.test(id))) {
      ctx.addIssue({
        code: "custom",
        message: "flagIds phải là UUID, cách nhau bằng dấu phẩy",
      });
    }
  });

/** CSV đã qua schema ⇒ danh sách id, đã khử trùng (id trùng nhân đôi series) */
export const flagIdsOf = (csv: string): string[] => [
  ...new Set(csv.split(",")),
];

export const internalStatsSummaryQuerySchema = z
  .object({
    environmentId: z.string().uuid(),
    flagIds: flagIdsCsv,
    tz: tzSchema.default("UTC"),
    ...asOfField,
  })
  .strict()
  .superRefine(refuseAsOfOutsideTests);

export type InternalFlagStatsQuery = z.infer<
  typeof internalFlagStatsQuerySchema
>;
export type InternalStaleFlagsQuery = z.infer<
  typeof internalStaleFlagsQuerySchema
>;
export type InternalStatsSummaryQuery = z.infer<
  typeof internalStatsSummaryQuerySchema
>;

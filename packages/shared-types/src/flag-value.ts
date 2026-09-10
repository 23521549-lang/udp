import { z } from "zod";

/**
 * Bốn kiểu flag — PHẢI trùng enum `FlagType` của Prisma.
 *
 * Bản chép thứ hai của một enum sống ở `@udp/db`, vì package này không được
 * import `@udp/db`. Chốt giữ hai bản khỏi trôi nằm ở `design-lint`
 * (`enum-mirrors.test.ts`) — package duy nhất thấy được cả hai.
 */
export const FLAG_TYPES = ["BOOLEAN", "STRING", "NUMBER", "JSON"] as const;

/**
 * Giá trị một variant phải khớp kiểu của flag (§2.2: "FlagVariant.value phải
 * khớp FeatureFlag.flag_type — validate ở tầng application bằng Zod").
 *
 * Nguyên văn `FLAG_TYPE_VALIDATORS` của §2.2. Trước đợt này `POST /flags` nhận
 * `value: z.unknown()`, nên flag `STRING` nhận được variant mang giá trị số — và
 * lỗi chỉ lộ ra ở SDK của khách, dưới dạng `TYPE_MISMATCH` lúc đánh giá, xa
 * khỏi chỗ gây ra nó hàng tuần.
 *
 * Hai chi tiết đáng nói:
 *
 *   - `JSON` là OBJECT (`z.record`), không phải mảng hay giá trị nguyên thuỷ:
 *     nó ánh xạ sang `resolveObjectValue` của OpenFeature, vốn trả một object.
 *   - `NUMBER` nhận số THỰC. Trước v4.1, `canonicalJson` từ chối mọi số không
 *     nguyên, nên flag `NUMBER` mang `0.15` ném ngay trong transaction ghi và
 *     thành 500. Nay số tuần tự theo RFC 8785 nên giá trị thập phân băm được.
 */
export const FLAG_VALUE_SCHEMAS = {
  BOOLEAN: z.boolean(),
  STRING: z.string(),
  NUMBER: z.number(),
  JSON: z.record(z.unknown()),
} as const satisfies Record<(typeof FLAG_TYPES)[number], z.ZodTypeAny>;

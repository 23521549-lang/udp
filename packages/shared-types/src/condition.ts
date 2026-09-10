import { z } from "zod";

/**
 * Nửa "AI KHỚP" của một targeting rule (§2.2 `FlagTargetingRule.condition`).
 *
 * Ở package dùng chung vì hai bên cùng phải hiểu nó GIỐNG HỆT nhau: Service 2
 * validate lúc ghi, và evaluator trong SDK của khách đọc nó lúc đánh giá (I26).
 * Hai bộ schema song song thì một rule được S2 nhận có thể bị SDK hiểu khác.
 */

/**
 * Bốn loại rule — PHẢI trùng enum `RuleType` của Prisma.
 *
 * Package này không được import `@udp/db` (vòng phụ thuộc `db → shared-types →
 * db`), nên danh sách này là bản thứ hai của enum đó. Hai danh sách không gì so
 * với nhau là đúng hình dạng của lỗi PAUSED ở v3 — nên có một test ở
 * `design-lint` so hai bên, vì chỉ package đó được thấy cả hai.
 */
export const RULE_TYPES = [
  "ALL",
  "USER_BASED",
  "ATTRIBUTE_BASED",
  "SEGMENT",
] as const;

export type RuleType = (typeof RULE_TYPES)[number];

/** Mười bốn toán tử của §2.2 — thứ tự không mang nghĩa */
export const ATTRIBUTE_OPERATORS = [
  "eq",
  "neq",
  "in",
  "nin",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "startsWith",
  "endsWith",
  "semverGt",
  "semverLt",
  "regex",
] as const;

/**
 * Schema `condition` theo từng `rule_type` — đúng §2.2, cộng thêm `.strict()`.
 *
 * `.strict()` là chỗ DUY NHẤT lệch khỏi §2.2, và lệch theo hướng chặt hơn, cùng
 * khuôn `flagServeUnion` của file bên cạnh: không có nó, `{ userIds: [...],
 * segmentId }` gửi nhầm vào một rule `USER_BASED` parse thành công và
 * `segmentId` bị nuốt im lặng. Người gọi tưởng đã giới hạn theo segment, còn rule
 * thật thì khớp theo danh sách user.
 */
export const conditionSchemas = {
  ALL: z.object({}).strict(),

  USER_BASED: z
    .object({ userIds: z.array(z.string()).min(1).max(10_000) })
    .strict(),

  ATTRIBUTE_BASED: z
    .object({
      // AND của nhiều điều kiện (§2.2)
      all: z
        .array(
          z
            .object({
              attribute: z.string(),
              operator: z.enum(ATTRIBUTE_OPERATORS),
              value: z.union([
                z.string(),
                z.number(),
                z.boolean(),
                z.array(z.string()),
              ]),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),

  SEGMENT: z.object({ segmentId: z.string().uuid() }).strict(),
} as const satisfies Record<RuleType, z.ZodTypeAny>;

/**
 * Lỗi của `condition` so với schema của `ruleType`, hoặc `undefined` nếu hợp lệ.
 *
 * Trả chuỗi thay vì ném, để bên gọi gắn lỗi vào đúng đường dẫn của rule trong
 * request (`rules.3.condition`) — người sửa một danh sách hai mươi rule cần biết
 * rule NÀO sai, không chỉ "có rule sai".
 */
export function conditionIssue(
  ruleType: RuleType,
  condition: unknown,
): string | undefined {
  const result = conditionSchemas[ruleType].safeParse(condition);
  if (result.success) return undefined;

  return result.error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ` : "") + i.message)
    .join("; ");
}

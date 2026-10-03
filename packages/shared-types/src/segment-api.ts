import { z } from "zod";
import { segmentConditionsSchema } from "./condition.js";

/**
 * [v4.9] Hợp đồng ghi Segment (§2.2, §6.5, §9) — MỘT định nghĩa cho biên ngoài
 * của Service 1 và biên trong của Service 2, cùng khuôn `flag-api.ts`: export
 * object GỐC, mỗi biên tự `.extend()` (S2 thêm `projectId`) rồi `.strict()`.
 */

/**
 * NUL (U+0000) hoặc một nửa cặp surrogate đứng lẻ.
 *
 * Postgres không lưu được cả hai: `text`/`jsonb` từ chối NUL (22P05) và chuỗi
 * không phải UTF-8 hợp lệ. Lọt tới đó là 500 thay vì 400. Cờ `u` khiến một cặp
 * surrogate hợp lệ là MỘT code point (không thuộc `Cs`), nên `\p{Cs}` chỉ khớp
 * nửa đứng lẻ.
 */
const UNSTORABLE = /[\0\p{Cs}]/u;
const UNSTORABLE_MESSAGE = "Chuỗi chứa ký tự NUL hoặc surrogate lẻ";

const storable = (s: string): boolean => !UNSTORABLE.test(s);

/** Mọi chuỗi nằm ở bất kỳ độ sâu nào của `conditions` — tên thuộc tính, giá trị, userId */
function* stringsOf(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* stringsOf(item);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) yield* stringsOf(item);
  }
}

/**
 * `segmentConditionsSchema` chỉ mô tả HÌNH DẠNG và trần kích thước, dùng chung
 * một bộ điều kiện với rule; chốt NUL/surrogate bọc ngoài nó ở đây vì hôm nay chỉ
 * đường ghi segment có chốt này — đường ghi rule có cùng lỗ hổng, chặn riêng sau.
 */
const storableConditions = segmentConditionsSchema.superRefine(
  (conditions, ctx) => {
    for (const s of stringsOf(conditions)) {
      if (!storable(s)) {
        ctx.addIssue({ code: "custom", message: UNSTORABLE_MESSAGE });
        return;
      }
    }
  },
);

// Segment.name là VARCHAR(100), UNIQUE (project_id, name); description VARCHAR(255)
const segmentName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(storable, UNSTORABLE_MESSAGE);
const segmentDescription = z
  .string()
  .trim()
  .max(255)
  .refine(storable, UNSTORABLE_MESSAGE)
  .nullable();

export const createSegmentFields = z.object({
  name: segmentName,
  description: segmentDescription.optional(),
  conditions: storableConditions,
});

/** PUT = thay TOÀN BỘ; optimistic lock theo `Segment.updated_at` */
export const updateSegmentFields = z.object({
  name: segmentName,
  description: segmentDescription,
  conditions: storableConditions,
  lastKnownUpdatedAt: z.string().datetime({ offset: true }),
});

export type CreateSegmentFields = z.infer<typeof createSegmentFields>;
export type UpdateSegmentFields = z.infer<typeof updateSegmentFields>;

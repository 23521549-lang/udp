import { z } from "zod";
import { createSegmentFields, updateSegmentFields } from "@udp/shared-types";

/**
 * Hợp đồng của ba route `/internal/segments` (§3.2, §9) — hình dùng chung ở
 * `@udp/shared-types/segment-api`, cùng khuôn `flag-api.ts`: Service 1 kiểm đúng
 * hình này ở biên ngoài, Service 2 `.extend()` thêm phần chỉ nó cần rồi
 * `.strict()`.
 */

/** `projectId` chỉ có ở biên TRONG: ngoài kia nó nằm trên đường dẫn (§3.1) */
export const createSegmentSchema = createSegmentFields
  .extend({ projectId: z.string().uuid() })
  .strict();

export const updateSegmentSchema = updateSegmentFields.strict();

/**
 * `projectId` của PUT và DELETE đi bằng QUERY, không bằng body.
 *
 * Nó là lớp phòng thủ thứ hai của R05: Service 1 đã kiểm segment thuộc project
 * trước khi gọi, nhưng route nội bộ không được tin mọi id nó nhận — `projectId`
 * đi vào chính điều kiện của service, và lệch thì 404. Thiếu nó thì một lỗi ở
 * Service 1 (hay một bên gọi nội bộ tương lai) đủ để sửa segment của tenant khác
 * chỉ bằng một id, và S2 sẽ vui vẻ ghi.
 *
 * Query chứ không body: DELETE không mang thân (`call` của Service 1 không gửi
 * `content-type` cho DELETE), và để PUT dùng CHUNG một hình với DELETE thì thân
 * của PUT giữ đúng `updateSegmentFields` của §3.2 — không có trường nào ở hai
 * chỗ.
 */
export const segmentProjectQuerySchema = z
  .object({ projectId: z.string().uuid() })
  .strict();

export type CreateSegmentInput = z.infer<typeof createSegmentSchema>;
export type UpdateSegmentInput = z.infer<typeof updateSegmentSchema>;
export type SegmentProjectQuery = z.infer<typeof segmentProjectQuerySchema>;

/** `conditions` đã qua schema ghi — và, ở service, đã khử trùng `userIds` (V13) */
export type SegmentConditions = CreateSegmentInput["conditions"];

/**
 * Thứ DUY NHẤT ba route nội bộ trả về (§3.2).
 *
 * Không trả hình đầy đủ của segment: Service 1 đọc lại view của chính nó sau khi
 * Service 2 commit (cùng khuôn `createFlag`), nên hình nội bộ chỉ cần mang mốc
 * optimistic lock mới và id. Trả `conditions` ở đây là chuyển tới 4 MiB qua mạng
 * nội bộ cho một thứ bên gọi sẽ đọc lại ngay.
 */
export interface SegmentStamp {
  id: string;
  updatedAt: Date;
}

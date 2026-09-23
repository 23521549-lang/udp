import { z } from "zod";
import {
  createSegmentFields,
  updateSegmentFields,
  type SegmentConditions,
} from "@udp/shared-types";

/**
 * Hợp đồng HTTP của segment ở biên NGOÀI (§3.1) — cùng hình `segment-api` mà
 * Service 2 kiểm lại ở biên trong [v4.9].
 *
 * `projectId` không có trong body: nó nằm trên đường dẫn, và Service 1 tự gắn nó
 * khi gọi xuống. Nhận nó từ body là mở một đường cho người dùng chọn project
 * khác project họ vừa được kiểm quyền trên (I14).
 */
export const createSegmentBodySchema = createSegmentFields.strict();
export const updateSegmentBodySchema = updateSegmentFields.strict();

export const listSegmentsQuerySchema = z
  .object({
    /** Khớp một phần của tên, không phân biệt hoa thường; trần = độ dài cột */
    search: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export type CreateSegmentBody = z.infer<typeof createSegmentBodySchema>;
export type UpdateSegmentBody = z.infer<typeof updateSegmentBodySchema>;
export type ListSegmentsQuery = z.infer<typeof listSegmentsQuerySchema>;

/**
 * Tóm tắt một segment cho danh sách (§3.1).
 *
 * `userIdCount` thay vì `userIds` (L6): danh sách segment của Portal phải dưới
 * 10 KB (AC-3.11), mà `userIds` một mình đã tới 2,5 MB — và không trang danh sách
 * nào cần tới định danh người dùng.
 */
export interface SegmentSummaryView {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  summary: {
    conditionCount: number;
    userIdCount: number;
    hasRegex: boolean;
    /** Số byte `conditions` chiếm trong snapshot — cùng thước đo với `quota` */
    payloadBytes: number;
  };
  usage: { flagCount: number; productionFlagCount: number };
}

/** Flag còn rule trỏ tới segment, kèm environment nào có rule đó */
export interface SegmentFlagUsageView {
  flagId: string;
  flagKey: string;
  lifecycleStatus: string;
  envs: { id: string; name: string; isProduction: boolean }[];
}

/** Chi tiết một segment (§3.1): tóm tắt + điều kiện đầy đủ + ai đang dùng */
export interface SegmentDetailView extends SegmentSummaryView {
  conditions: SegmentConditions;
  usage: {
    flagCount: number;
    productionFlagCount: number;
    /** Tối đa `SEGMENT.referencesInView` flag */
    flags: SegmentFlagUsageView[];
  };
}

/**
 * Hai trần của project, trả cùng danh sách (V21).
 *
 * Portal cần cả số ĐANG DÙNG và trần để cảnh báo trước khi người dùng gõ xong
 * một segment 4 MiB rồi nhận 422.
 */
export interface SegmentQuotaView {
  segmentCount: number;
  maxSegments: number;
  payloadBytes: number;
  maxPayloadBytes: number;
}

export interface SegmentListView {
  segments: SegmentSummaryView[];
  quota: SegmentQuotaView;
}

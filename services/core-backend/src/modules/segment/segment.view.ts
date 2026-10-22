import { SEGMENT } from "@udp/config";
import { readSegmentConditionsSchema } from "@udp/shared-types";
import type {
  DetailRow,
  FlagUsageRow,
  QuotaRow,
  SummaryRow,
} from "./segment.repository.js";
import type {
  SegmentDetailView,
  SegmentFlagUsageView,
  SegmentListView,
  SegmentQuotaView,
  SegmentSummaryView,
} from "./segment.types.js";

/**
 * Hàng database → hình dạng §3.1.
 *
 * Tách khỏi service cùng lý do `rollout.view.ts`: mốc thời gian ra ISO và các
 * con số gộp lại thành `summary`/`usage` ở MỘT chỗ, nên bốn đường (list, detail,
 * và hai đường ghi đọc lại detail) không thể trả hai hình khác nhau cho cùng một
 * segment.
 */

export function summaryView(row: SummaryRow): SegmentSummaryView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    summary: {
      conditionCount: row.conditionCount,
      userIdCount: row.userIdCount,
      hasRegex: row.hasRegex,
      payloadBytes: row.payloadBytes,
    },
    usage: {
      flagCount: row.flagCount,
      productionFlagCount: row.productionFlagCount,
    },
  };
}

const flagUsageView = (row: FlagUsageRow): SegmentFlagUsageView => ({
  flagId: row.flagId,
  flagKey: row.flagKey,
  lifecycleStatus: row.lifecycleStatus,
  /** `jsonb_agg` không hứa thứ tự; sắp ở đây để response tất định */
  envs: [...row.envs].sort((a, b) => (a.name < b.name ? -1 : 1)),
});

/**
 * Chi tiết segment — `conditions` đi qua schema ĐỌC chứ không ép kiểu.
 *
 * Cột là JSONB nên TypeScript chỉ biết nó là `JsonValue`. Schema đọc là cùng một
 * định nghĩa hình dạng mà database CHECK cưỡng chế, nên một hàng không khớp là
 * dấu hiệu dữ liệu đã bị ghi bằng đường khác — nổ ở biên còn hơn trôi tới Portal
 * dưới dạng một object thiếu trường.
 */
export function detailView(
  row: DetailRow,
  flags: readonly FlagUsageRow[],
): SegmentDetailView {
  const summary = summaryView(row);
  return {
    ...summary,
    conditions: readSegmentConditionsSchema.parse(row.conditions),
    usage: { ...summary.usage, flags: flags.map(flagUsageView) },
  };
}

const quotaView = (row: QuotaRow): SegmentQuotaView => ({
  segmentCount: row.segmentCount,
  maxSegments: SEGMENT.maxPerProject,
  payloadBytes: row.payloadBytes,
  maxPayloadBytes: SEGMENT.maxProjectBytes,
});

export const listView = (
  rows: readonly SummaryRow[],
  quota: QuotaRow,
): SegmentListView => ({
  segments: rows.map(summaryView),
  quota: quotaView(quota),
});

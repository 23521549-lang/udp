import type { PublicProjectWire } from "@udp/shared-types/wire";
import { count, defineMessages } from "../../i18n";
import { formatNumber } from "../../lib/format";

/**
 * Trạng thái project — dùng ở danh sách project, Tổng quan, Trang chủ và Bảng điều khiển.
 * [Plan #58 UX-5, UX-8] `status` là VÒNG ĐỜI (đã dựng hạ tầng chưa), không phải sức khoẻ: ACTIVE là "Đang hoạt
 * động", còn sức khoẻ ("3 việc cần xử lý") là nhãn riêng `health`, như Argo CD tách "đồng bộ" và "sức khoẻ".
 */
export const projectStatusMessages = defineMessages({
  vi: {
    status: {
      DRAFT: "Nháp",
      PROVISIONING: "Đang dựng hạ tầng",
      ACTIVE: "Đang hoạt động",
      ERROR: "Lỗi",
      DELETED: "Đã xoá",
    } satisfies Record<PublicProjectWire["status"], string>,
    expired: "Hết hạn",
    health: {
      issues: (n: number) => `${formatNumber(n)} việc cần xử lý`,
      none: "Không có vấn đề",
    },
  },
  en: {
    status: {
      DRAFT: "Draft",
      PROVISIONING: "Provisioning",
      ACTIVE: "Active",
      ERROR: "Error",
      DELETED: "Deleted",
    },
    expired: "Expired",
    health: {
      issues: (n: number) => `${count(n, "issue", "issues")} to handle`,
      none: "No issues",
    },
  },
});

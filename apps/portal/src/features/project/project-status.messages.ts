import type { PublicProjectWire } from "@udp/shared-types/wire";
import { defineMessages } from "../../i18n";

/** Trạng thái project — dùng ở danh sách project, Tổng quan, Trang chủ và Bảng điều khiển */
export const projectStatusMessages = defineMessages({
  vi: {
    status: {
      DRAFT: "Nháp",
      PROVISIONING: "Đang dựng hạ tầng",
      ACTIVE: "Ổn định",
      ERROR: "Cần xem",
      DELETED: "Đã xoá",
    } satisfies Record<PublicProjectWire["status"], string>,
    expired: "Hết hạn",
  },
  en: {
    status: {
      DRAFT: "Draft",
      PROVISIONING: "Provisioning",
      ACTIVE: "Healthy",
      ERROR: "Needs attention",
      DELETED: "Deleted",
    },
    expired: "Expired",
  },
});

import type { FlagDetailWire } from "@udp/shared-types/wire";

export const LIFECYCLE_LABEL: Record<
  FlagDetailWire["lifecycleStatus"],
  string
> = {
  DRAFT: "Nháp",
  ACTIVE: "Đang dùng",
  ARCHIVED: "Đã lưu trữ",
};

/** Thứ tự nhóm trong danh sách: đang dùng trước, nháp sau, lưu trữ cuối */
export const LIFECYCLE_ORDER: FlagDetailWire["lifecycleStatus"][] = [
  "ACTIVE",
  "DRAFT",
  "ARCHIVED",
];

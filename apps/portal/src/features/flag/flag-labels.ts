import type { FlagDetailWire } from "@udp/shared-types/wire";
import { messagesOf } from "../../i18n";
import { flagMessages } from "./flag.messages";

/**
 * Nhãn vòng đời theo ngôn ngữ đang chọn (Plan #54) — đọc ngôn ngữ lúc gọi; component gọi nó đã theo dõi
 * ngôn ngữ qua chữ của chính nó. Chữ ở `flag.messages.tsx`.
 */
export const lifecycleLabel = (
  status: FlagDetailWire["lifecycleStatus"],
): string => messagesOf(flagMessages).lifecycle[status];

/** Thứ tự nhóm trong danh sách: đang dùng trước, nháp sau, lưu trữ cuối */
export const LIFECYCLE_ORDER: FlagDetailWire["lifecycleStatus"][] = [
  "ACTIVE",
  "DRAFT",
  "ARCHIVED",
];

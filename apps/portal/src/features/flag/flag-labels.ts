import type { FlagDetailWire, FlagSummaryWire } from "@udp/shared-types/wire";
import { messagesOf } from "../../i18n";
import { flagMessages } from "./flag.messages";

/**
 * Nhãn vòng đời theo ngôn ngữ đang chọn (Plan #54) — đọc ngôn ngữ lúc gọi; component gọi nó đã theo dõi
 * ngôn ngữ qua chữ của chính nó. Chữ ở `flag.messages.tsx`.
 */
export const lifecycleLabel = (
  status: FlagDetailWire["lifecycleStatus"],
): string => messagesOf(flagMessages).lifecycle[status];

/**
 * [Plan #58 UX-4] Flag có đang PHỤC VỤ ở environment không. Nháp và lưu trữ thì SDK không thấy, dù công tắc của
 * environment đang bật — trước đây danh sách ghi "Bật" cho flag nháp.
 */
export type Serving = "on" | "off" | "draft" | "archived";

export function servingOf(
  flag: Pick<FlagSummaryWire, "lifecycleStatus" | "env">,
): Serving {
  if (flag.lifecycleStatus === "DRAFT") return "draft";
  if (flag.lifecycleStatus === "ARCHIVED") return "archived";
  return flag.env?.isEnabled === true ? "on" : "off";
}

/** Thứ tự nhóm trong danh sách: đang dùng trước, nháp sau, lưu trữ cuối */
export const LIFECYCLE_ORDER: FlagDetailWire["lifecycleStatus"][] = [
  "ACTIVE",
  "DRAFT",
  "ARCHIVED",
];

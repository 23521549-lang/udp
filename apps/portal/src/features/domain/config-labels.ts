import { messagesOf } from "../../i18n";
import { configLabelMessages } from "./config-labels.messages";

/**
 * Nhãn cho khoá cấu hình của tool (Plan #53 QĐ-9) — chữ ở `config-labels.messages.ts` (Plan #54). Khoá gốc
 * vẫn hiện bên cạnh bằng chữ mono: nó là thứ người dùng gặp trong tài liệu của tool.
 *
 * `CONFIG_LABELS` là bản tiếng Việt: `tests/config-labels.test.ts` đối chiếu nó với MỌI khoá trong mẫu golden
 * của catalog — adapter mới thêm khoá mà quên nhãn là test đỏ. Bản tiếng Anh có đúng bộ khoá đó vì
 * `defineMessages` bắt thiếu/thừa khoá lúc biên dịch.
 */
export const CONFIG_LABELS: Readonly<Record<string, string>> =
  configLabelMessages.vi;

/**
 * Nhãn của một khoá theo ngôn ngữ đang chọn (đọc lúc gọi, như `formatNumber`; component gọi nó tự theo dõi
 * ngôn ngữ). Khoá chưa có nhãn (chỉ lọt khi test bị bỏ qua) hiện nguyên khoá.
 */
export const configLabel = (key: string): string => {
  const labels: Readonly<Record<string, string>> =
    messagesOf(configLabelMessages);
  return labels[key] ?? key;
};

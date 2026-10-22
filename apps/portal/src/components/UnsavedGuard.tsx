import { useBlocker } from "@tanstack/react-router";
import { useMessages } from "../i18n";
import { componentsMessages } from "./components.messages";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Chặn rời chỗ đang sửa khi còn thay đổi chưa lưu (Plan #53 QĐ-9).
 *
 * Mọi lối ra đều là một điều hướng của router — bấm flag khác, `j`/`k`, đổi environment bằng tab hay
 * phím `1`–`9`, Esc đóng panel, thanh bên, Back — nên MỘT blocker phủ hết, thay vì mỗi lối tự nhớ
 * hỏi. Tải lại hay đóng tab thì trình duyệt tự hỏi (`beforeunload`).
 */
export function UnsavedGuard({
  dirty,
  what,
}: {
  dirty: boolean;
  what: string;
}) {
  const m = useMessages(componentsMessages).unsaved;
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    disabled: !dirty,
    withResolver: true,
  });
  if (blocker.status !== "blocked") return null;
  return (
    <ConfirmDialog
      title={m.title}
      description={m.description(what)}
      confirmLabel={m.confirm}
      danger
      onConfirm={() => blocker.proceed()}
      onClose={() => blocker.reset()}
    />
  );
}

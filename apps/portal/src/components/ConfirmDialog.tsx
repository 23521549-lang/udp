import { useState } from "react";
import { Dialog } from "./Dialog";

/**
 * Xác nhận cho việc nặng (DESIGN.md §6: rollback, lên 100%, bật/tắt ở production).
 *
 * `typeToConfirm`: người dùng phải gõ lại đúng chuỗi (key flag, tên project) — cùng cơ
 * chế với 428 `CONFIRMATION_REQUIRED` của backend (§8.4). So sau `trim` và NFC, như
 * backend so, để "đúng mà vẫn bị từ chối" không xảy ra với chữ có dấu.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  danger = false,
  typeToConfirm,
  busy = false,
  disabled = false,
  error,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
  busy?: boolean;
  /** [Plan #45] Chặn xác nhận vì lý do ngoài ô gõ — vd validator báo lỗi */
  disabled?: boolean;
  error?: string | undefined;
  onConfirm: (typed: string | undefined) => void;
  onClose: () => void;
  /** Nội dung thêm giữa mô tả và ô gõ xác nhận */
  children?: React.ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const norm = (s: string) => s.trim().normalize("NFC");
  const ok = typeToConfirm === undefined || norm(typed) === norm(typeToConfirm);

  return (
    <Dialog
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            Huỷ
          </button>
          <button
            type="button"
            className={danger ? "btn danger-fill" : "btn pri"}
            disabled={!ok || busy || disabled}
            onClick={() =>
              onConfirm(typeToConfirm === undefined ? undefined : typed.trim())
            }
          >
            {busy ? "Đang thực hiện..." : confirmLabel}
          </button>
        </>
      }
    >
      {children}
      {typeToConfirm !== undefined && (
        <div className="f">
          <label htmlFor="confirm-typed">
            Gõ <span className="mono">{typeToConfirm}</span> để xác nhận
          </label>
          <input
            id="confirm-typed"
            className="inp"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
      )}
      {error !== undefined && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}

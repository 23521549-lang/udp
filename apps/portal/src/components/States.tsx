import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { messageOf } from "../lib/errors";
import { Icon } from "./Icon";

export function Loading({ label = "Đang tải..." }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      {label}
    </div>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="state">
      <b>{title}</b>
      {children !== undefined && <div className="c3">{children}</div>}
    </div>
  );
}

/** Lỗi tải dữ liệu: nói lỗi gì và cho thử lại — không bao giờ màn hình trắng (§10.10) */
export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <div className="state" role="alert">
      <span className="stt warn">
        <Icon of={AlertCircle} />
        {messageOf(error)}
      </span>
      {onRetry !== undefined && (
        <button type="button" className="btn" onClick={onRetry}>
          Thử lại
        </button>
      )}
    </div>
  );
}

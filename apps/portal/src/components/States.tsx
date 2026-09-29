import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { messageOf } from "../lib/errors";
import { isApiError } from "../lib/http";
import { Icon } from "./Icon";

export function Loading({ label = "Đang tải…" }: { label?: string }) {
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

/**
 * Lỗi tải dữ liệu: nói lỗi gì và chỉ đường tiếp (§10.10) — không bao giờ màn hình trắng.
 *
 * 404 không có "Thử lại": tải lại một thứ không tồn tại vẫn không tồn tại. Chỗ gọi đưa `back` (link về
 * danh sách chứa nó) và đó là lối ra duy nhất được đưa.
 */
export function ErrorState({
  error,
  onRetry,
  back,
}: {
  error: unknown;
  onRetry?: () => void;
  back?: ReactNode;
}) {
  const notFound = isApiError(error) && error.status === 404;
  return (
    <div className="state" role="alert">
      <span className="stt warn">
        <Icon of={AlertCircle} />
        {messageOf(error)}
      </span>
      {notFound
        ? back
        : onRetry !== undefined && (
            <button type="button" className="btn" onClick={onRetry}>
              Thử lại
            </button>
          )}
    </div>
  );
}

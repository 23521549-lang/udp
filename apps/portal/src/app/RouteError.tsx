import { Link, type ErrorComponentProps } from "@tanstack/react-router";
import { ErrorState } from "../components/States";

/**
 * Ranh giới lỗi của route (§10.10, hai tầng): một màn hình ném thì chỉ màn hình đó hiện
 * lỗi kèm nút thử lại, khung ứng dụng và thanh bên vẫn dùng được.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="page">
      <ErrorState error={error} onRetry={reset} />
    </div>
  );
}

export function NotFound() {
  return (
    <div className="page">
      <div className="state">
        <b>Không tìm thấy trang</b>
        <Link to="/app/projects" className="btn">
          Về danh sách project
        </Link>
      </div>
    </div>
  );
}

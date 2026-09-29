import {
  Link,
  useLocation,
  type ErrorComponentProps,
} from "@tanstack/react-router";
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

/**
 * Đường dẫn không khớp route nào. Là `defaultNotFoundComponent` của router nên hiện NGAY TRONG
 * khung đang đứng (Portal hay Bảng điều khiển), với lối về đúng khung đó — không phải chữ
 * "Not Found" mặc định của thư viện.
 */
export function NotFound() {
  const { pathname } = useLocation();
  const inConsole = pathname.startsWith("/admin");
  return (
    <div className="page">
      <div className="state" role="alert">
        <h1 className="title">Không tìm thấy trang</h1>
        <p className="c3">
          Đường dẫn{" "}
          <span className="mono" translate="no">
            {pathname}
          </span>{" "}
          không có trong {inConsole ? "Bảng điều khiển nền tảng" : "Portal"}.
        </p>
        {inConsole ? (
          <Link to="/admin/overview" className="btn">
            Về Bảng điều khiển
          </Link>
        ) : (
          <Link to="/app/home" className="btn">
            Về trang chủ
          </Link>
        )}
      </div>
    </div>
  );
}

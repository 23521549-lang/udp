import { formatNumber } from "../lib/format";

/**
 * Điều hướng theo trang của một danh sách có `total` ở máy chủ. Một component cho mọi danh sách
 * (flag, project, nhật ký, bảng điều khiển): cùng chữ, cùng cách đếm, cùng nhãn cho trình đọc màn hình.
 * Không hiện gì khi mọi thứ nằm vừa một trang.
 */
export function Pager({
  label,
  offset,
  pageSize,
  total,
  onChange,
}: {
  /** "Trang của danh sách flag" */
  label: string;
  offset: number;
  pageSize: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  if (total <= pageSize) return null;
  const last = Math.min(offset + pageSize, total);
  return (
    <nav className="line pager" aria-label={label}>
      <button
        type="button"
        className="btn"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - pageSize))}
      >
        Trang trước
      </button>
      <span className="c3 num" aria-live="polite">
        {formatNumber(offset + 1)}–{formatNumber(last)} / {formatNumber(total)}
      </span>
      <button
        type="button"
        className="btn"
        disabled={last >= total}
        onClick={() => onChange(offset + pageSize)}
      >
        Trang sau
      </button>
    </nav>
  );
}

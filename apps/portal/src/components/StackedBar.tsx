/**
 * Thanh xếp chồng một hàng bằng HTML (không SVG): một tổng chia theo phần — project theo trạng thái, deploy thành
 * công/thất bại, project theo cloud. Cả thanh là MỘT hình có nhãn đầy đủ cho trình đọc màn hình; chú giải bên dưới
 * mang cùng số cho mắt.
 *
 * Màu (DESIGN.md §2): `error` chỉ cho phần lỗi; phần còn lại dùng màu dữ liệu (`--v2` trung tính, `--accent`,
 * `--v3`, `--v4`) — không màu trạng thái cho thứ không phải trạng thái.
 */

export type StackTone = "neutral" | "accent" | "error" | "c3" | "c4";

export interface StackPart {
  label: string;
  value: number;
  tone: StackTone;
}

export function StackedBar({
  label,
  parts,
  format,
}: {
  label: string;
  parts: readonly StackPart[];
  format: (n: number) => string;
}) {
  const text = `${label}: ${parts.map((p) => `${p.label} ${format(p.value)}`).join(", ")}`;
  return (
    <div className="sb">
      <div className="sb-bar" role="img" aria-label={text}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <i
              key={p.label}
              className={`sb-${p.tone}`}
              style={{ flexGrow: p.value }}
            />
          ))}
      </div>
      <ul className="sb-lg" aria-hidden="true">
        {parts.map((p) => (
          <li key={p.label}>
            <i className={`sb-${p.tone}`} />
            {p.label} <span className="num">{format(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Đường xu hướng không trục (DESIGN.md §6 "Danh sách"): số lượt theo ngày của một flag, lưu lượng
 * của một workload. Chỉ để thấy hình dáng — con số đi kèm ở cột bên cạnh.
 */
export function Sparkline({
  values,
  width = 64,
  height = 18,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <span />;
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const d = values
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - (v / max) * (height - 2) - 1).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg className="spark" width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--ink-3)" strokeWidth="1.25" />
    </svg>
  );
}

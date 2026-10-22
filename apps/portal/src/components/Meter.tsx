/**
 * Thanh mức dùng (DESIGN.md §6): rãnh `--sunk`, phần đã dùng `--ink-3`; vượt 80% thì cam, vượt 95%
 * thì đỏ. Luôn kèm số — màu một mình không phải thông tin.
 */
export function Meter({
  label,
  value,
  max,
  format,
}: {
  label: string;
  value: number;
  max: number;
  format: (n: number) => string;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const level = ratio >= 0.95 ? "crit" : ratio >= 0.8 ? "high" : "";
  const text = `${format(value)} / ${format(max)}`;
  return (
    <div className="meter">
      <div className="meter-h">
        <span>{label}</span>
        <span className="num c3">{text}</span>
      </div>
      <div
        className={`meter-t ${level}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
      >
        <i style={{ transform: `scaleX(${String(ratio)})` }} />
      </div>
    </div>
  );
}

/**
 * Vòng tiến độ (DESIGN.md §5): rãnh `--line-2` cộng một cung dài đúng bằng %, nét 1.6,
 * đầu tròn. `tone="accent"` khi đang rollout, `"muted"` khi dùng bình thường; `dashed`
 * cho flag nháp.
 */
export function ProgressRing({
  percent,
  tone = "muted",
  dashed = false,
  size = 16,
}: {
  percent: number;
  tone?: "accent" | "muted";
  dashed?: boolean;
  size?: number;
}) {
  const r = 6.2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="var(--line-2)"
        strokeWidth="1.6"
        strokeDasharray={dashed ? "2 2" : undefined}
      />
      {!dashed && p > 0 && (
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke={tone === "accent" ? "var(--accent)" : "var(--ink-3)"}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeDasharray={`${(c * p) / 100} ${c}`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  );
}

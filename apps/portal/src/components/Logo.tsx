/** Logo "Công tắc" (DESIGN.md §8): viên thuốc viền, núm tròn bên phải */
export function Logo() {
  return (
    <span className="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <rect
          x="3"
          y="7"
          width="18"
          height="10"
          rx="5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
        />
        <circle cx="16" cy="12" r="3" fill="currentColor" />
      </svg>
    </span>
  );
}

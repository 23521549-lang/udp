import type { LucideIcon, LucideProps } from "lucide-react";

/**
 * Icon DUY NHẤT của Portal: bọc Lucide với nét và cỡ của hệ thống thiết kế (DESIGN.md §5:
 * lưới 24px, nét 1.75 ở cỡ 16px). Không bộ icon nào khác, không SVG tự vẽ ngoài logo và
 * vòng tiến độ — `tests/design-lint.test.ts` canh điều này.
 */
export function Icon({
  of: Glyph,
  size = 16,
  ...rest
}: { of: LucideIcon; size?: number } & Omit<LucideProps, "ref">) {
  return (
    <Glyph
      className="i"
      width={size}
      height={size}
      strokeWidth={1.75}
      aria-hidden="true"
      {...rest}
    />
  );
}

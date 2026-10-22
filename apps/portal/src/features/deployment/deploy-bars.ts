import type { DeployDayWire } from "@udp/shared-types/wire";
import type { BarDatum } from "../../components/BarChart";
import { dayLabel } from "../../lib/format";

/**
 * Kết cục deploy theo ngày UTC ⇒ cột của `BarChart`: thành công là màu dữ liệu trung tính, CHỈ thất bại mang màu
 * lỗi (DESIGN.md §2). Một cách vẽ cho trang chủ, E10 của trang Bằng chứng và thẻ deploy của trang Kiến trúc.
 */
export function deployBars(
  days: readonly DeployDayWire[],
  labels: { success: string; failure: string },
): BarDatum[] {
  return days.map((d) => {
    const label = dayLabel(d.date);
    return {
      key: d.date,
      short: label.short,
      full: label.full,
      parts: [
        { label: labels.success, value: d.success, tone: "neutral" },
        { label: labels.failure, value: d.failure, tone: "error" },
      ],
    };
  });
}

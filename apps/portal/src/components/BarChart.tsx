import type { ReactNode } from "react";

/**
 * Biểu đồ cột xếp chồng bằng HTML (không SVG): số deploy theo ngày, lượt đánh giá theo ngày. Mỗi
 * cột là một điểm dừng của phím Tab với nhãn đầy đủ, nên trình đọc màn hình đọc được từng ngày mà
 * không cần bảng riêng.
 *
 * Màu (DESIGN.md §2): phần bình thường là màu dữ liệu trung tính, CHỈ phần lỗi mang màu trạng
 * thái — một cột toàn xanh lá không nói thêm gì ngoài "nhiều".
 */

export type BarTone = "neutral" | "accent" | "error";

export interface BarPart {
  label: string;
  value: number;
  tone: BarTone;
}

export interface BarDatum {
  key: string;
  /** Nhãn ngắn dưới cột ("29/9") */
  short: string;
  /** Nhãn đầy đủ cho tooltip và trình đọc màn hình ("Thứ Hai, 29/9") */
  full: string;
  parts: readonly BarPart[];
}

export function BarChart({
  title,
  level,
  data,
  format,
  height = 120,
  aside,
  captionHidden = false,
}: {
  title: string;
  level: 2 | 3 | 4;
  data: readonly BarDatum[];
  format: (n: number) => string;
  height?: number;
  aside?: ReactNode;
  /** Ẩn tiêu đề và chú giải khỏi mắt (vẫn là tên của hình cho trình đọc màn hình) — khi thẻ bao quanh đã nói đủ */
  captionHidden?: boolean;
}) {
  const totals = data.map((d) => d.parts.reduce((s, p) => s + p.value, 0));
  const max = Math.max(1, ...totals);
  const Heading = `h${String(level)}` as "h2" | "h3" | "h4";
  const legend = data[0]?.parts ?? [];
  return (
    <figure className="bc">
      <figcaption className={captionHidden ? "visually-hidden" : "lc-h"}>
        <Heading>{title}</Heading>
        <span className="lc-lg">
          {legend.map((p) => (
            <span key={p.label} className="lg">
              <i className={`bc-${p.tone}`} />
              {p.label}
            </span>
          ))}
          {aside}
        </span>
      </figcaption>
      <div className="bc-plot" style={{ height }}>
        <span className="bc-max num c3" aria-hidden="true">
          {format(max)}
        </span>
        {data.map((d, i) => {
          const total = totals[i] ?? 0;
          const text = `${d.full}: ${d.parts.map((p) => `${p.label} ${format(p.value)}`).join(", ")}`;
          return (
            <div
              key={d.key}
              className="bc-col"
              tabIndex={0}
              role="img"
              aria-label={text}
            >
              <div
                className="bc-stack"
                style={{ height: `${String((total / max) * 100)}%` }}
              >
                {d.parts
                  .filter((p) => p.value > 0)
                  .map((p) => (
                    <i
                      key={p.label}
                      className={`bc-${p.tone}`}
                      style={{ flexGrow: p.value }}
                    />
                  ))}
              </div>
              <span className="bc-tip" aria-hidden="true">
                {text}
              </span>
            </div>
          );
        })}
      </div>
      <div className="bc-x" aria-hidden="true">
        {data.map((d, i) => (
          <span key={d.key}>
            {i === 0 || i === data.length - 1 || i % 7 === 0 ? d.short : ""}
          </span>
        ))}
      </div>
    </figure>
  );
}

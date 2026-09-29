import { useLayoutEffect, useState, type RefObject } from "react";
import type { ArchitectureWire } from "@udp/shared-types/wire";

/**
 * Lớp cạnh của sơ đồ kiến trúc (DESIGN.md §6 "Sơ đồ kiến trúc"): nét mảnh `--line-2` giữa công cụ tiêu
 * thụ và công cụ cung cấp; cạnh của công cụ đang chọn hay đang trỏ dùng `--accent`, cạnh khác mờ đi.
 *
 * Vị trí đọc SAU layout (`useLayoutEffect` + `ResizeObserver`), không bao giờ trong render: nút là HTML
 * thường xếp bằng CSS grid, lớp này chỉ vẽ lên trên. Cạnh là trang trí cho mắt — quan hệ đầy đủ bằng
 * chữ nằm ở panel và ở danh sách phụ thuộc, nên lớp này `aria-hidden`.
 */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function EdgeLayer({
  container,
  edges,
  active,
  version,
}: {
  container: RefObject<HTMLDivElement>;
  edges: ArchitectureWire["edges"];
  /** Công cụ đang chọn hoặc đang trỏ — cạnh của nó nổi lên */
  active: string | undefined;
  /** Đổi khi dữ liệu đổi — đo lại */
  version: string;
}) {
  const [boxes, setBoxes] = useState<Map<string, Box>>(new Map());
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const root = container.current;
    if (root === null) return;
    const measure = (): void => {
      const origin = root.getBoundingClientRect();
      const next = new Map<string, Box>();
      root.querySelectorAll<HTMLElement>("[data-tool]").forEach((el) => {
        const key = el.dataset.tool;
        // Công cụ cấp namespace hiện ở mỗi env — cạnh nối bản đầu tiên (thứ tự của tài liệu)
        if (key === undefined || next.has(key)) return;
        const r = el.getBoundingClientRect();
        next.set(key, {
          x: r.left - origin.left,
          y: r.top - origin.top,
          w: r.width,
          h: r.height,
        });
      });
      setBoxes(next);
      setSize({ w: root.scrollWidth, h: root.scrollHeight });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [container, version]);

  if (size.w === 0) return null;
  return (
    <svg
      className="arch-edges"
      width={size.w}
      height={size.h}
      aria-hidden="true"
    >
      <defs>
        <marker
          id="arch-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="var(--line-2)" />
        </marker>
        <marker
          id="arch-arrow-on"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="var(--accent)" />
        </marker>
      </defs>
      {edges.map((e) => {
        const from = boxes.get(e.from);
        const to = boxes.get(e.to);
        if (from === undefined || to === undefined) return null;
        const on =
          active !== undefined && (e.from === active || e.to === active);
        const dim = active !== undefined && !on;
        return (
          <path
            key={`${e.from}>${e.to}>${e.capabilityId}`}
            d={pathBetween(from, to)}
            className={on ? "on" : dim ? "dim" : undefined}
            markerEnd={on ? "url(#arch-arrow-on)" : "url(#arch-arrow)"}
          />
        );
      })}
    </svg>
  );
}

/**
 * Đường cong từ công cụ tiêu thụ tới công cụ cung cấp (mũi tên chỉ vào bên cung cấp: "cần"). Hai nút
 * cạnh nhau theo chiều ngang nối mép trái–phải; chồng theo chiều dọc (công cụ cấp namespace dưới cụm)
 * nối mép trên–dưới.
 */
function pathBetween(from: Box, to: Box): string {
  const fromCx = from.x + from.w / 2;
  const toCx = to.x + to.w / 2;
  const horizontal = Math.abs(fromCx - toCx) > (from.w + to.w) / 2;
  if (horizontal) {
    const leftToRight = fromCx > toCx;
    const sx = leftToRight ? from.x : from.x + from.w;
    const ex = leftToRight ? to.x + to.w : to.x;
    const sy = from.y + from.h / 2;
    const ey = to.y + to.h / 2;
    const bend = Math.max(24, Math.abs(ex - sx) / 2);
    const c1 = leftToRight ? sx - bend : sx + bend;
    const c2 = leftToRight ? ex + bend : ex - bend;
    return `M${sx.toFixed(1)},${sy.toFixed(1)} C${c1.toFixed(1)},${sy.toFixed(1)} ${c2.toFixed(1)},${ey.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`;
  }
  const below = from.y > to.y;
  const sy = below ? from.y : from.y + from.h;
  const ey = below ? to.y + to.h : to.y;
  const bend = Math.max(20, Math.abs(ey - sy) / 2);
  const c1 = below ? sy - bend : sy + bend;
  const c2 = below ? ey + bend : ey - bend;
  return `M${fromCx.toFixed(1)},${sy.toFixed(1)} C${fromCx.toFixed(1)},${c1.toFixed(1)} ${toCx.toFixed(1)},${c2.toFixed(1)} ${toCx.toFixed(1)},${ey.toFixed(1)}`;
}

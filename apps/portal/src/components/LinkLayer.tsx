import { useId, useLayoutEffect, useState } from "react";

/**
 * Lớp cạnh chung của các sơ đồ (Plan #53 sơ đồ hạ tầng, Plan #57 tổng quan hệ thống và kiến trúc nền tảng; DESIGN.md
 * §6): nút là HTML thường xếp bằng CSS grid, lớp này chỉ vẽ lên trên.
 *
 * - Vị trí đọc SAU layout (`useLayoutEffect` + `ResizeObserver`), không bao giờ trong render.
 * - Đường nằm DƯỚI thẻ; nhãn nằm trên một lớp HTML riêng PHÍA TRÊN thẻ — nhãn dưới thẻ bị che (bản mẫu Plan #57).
 * - Cạnh của nút đang chọn hay đang trỏ nổi lên (`--accent`), cạnh khác mờ đi.
 * - Cạnh là trang trí cho mắt: quan hệ đầy đủ bằng chữ nằm ở bảng hay danh sách thay thế, nên cả hai lớp
 *   `aria-hidden`.
 */

export interface LayerLink {
  /** Khoá ổn định của cạnh */
  id: string;
  from: string;
  to: string;
  label?: string;
  /** Nét đứt: giao hàng, điều khiển, telemetry; nét liền: yêu cầu và dữ liệu */
  dashed?: boolean;
  /**
   * Ép hướng nối: `x` mép trái–phải, `y` mép trên–dưới, `under` vòng dưới từ đáy nút này tới đáy nút kia (hai nút
   * cùng hàng mà giữa chúng có nút khác); không có thì chọn theo vị trí hai nút.
   */
  axis?: "x" | "y" | "under";
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

export function LinkLayer({
  container,
  links,
  active,
  version,
  attr = "node",
  className,
}: {
  /**
   * Khung chứa các nút, nhận qua STATE (callback ref) chứ không qua `RefObject`: ref của phần tử cha được gắn SAU
   * layout effect của con, nên một `RefObject` còn `null` đúng lúc lớp này đo lần đầu.
   */
  container: HTMLElement | null;
  links: readonly LayerLink[];
  /** Nút đang chọn hoặc đang trỏ — cạnh của nó nổi lên */
  active: string | undefined;
  /** Đổi khi dữ liệu đổi — đo lại */
  version: string;
  /** Nút là phần tử có `data-<attr>="<id>"`; nút trùng id thì cạnh nối bản đầu tiên (thứ tự của tài liệu) */
  attr?: string;
  className: string;
}) {
  const marker = `lk${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [boxes, setBoxes] = useState<Map<string, Box>>(new Map());
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const root = container;
    if (root === null) return;
    const measure = (): void => {
      const origin = root.getBoundingClientRect();
      const next = new Map<string, Box>();
      root.querySelectorAll<HTMLElement>(`[data-${attr}]`).forEach((el) => {
        const id = el.getAttribute(`data-${attr}`);
        if (id === null || next.has(id)) return;
        const r = el.getBoundingClientRect();
        next.set(id, {
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
  }, [container, version, attr]);

  if (size.w === 0) return null;
  const routes = links.flatMap((link) => {
    const from = boxes.get(link.from);
    const to = boxes.get(link.to);
    if (from === undefined || to === undefined) return [];
    const on =
      active !== undefined && (link.from === active || link.to === active);
    const state = on ? "on" : active !== undefined ? "dim" : "";
    return [{ link, state, ...route(from, to, link.axis) }];
  });

  return (
    <>
      <svg
        className={className}
        width={size.w}
        height={size.h}
        aria-hidden="true"
      >
        <defs>
          <Arrow id={marker} fill="currentColor" />
          <Arrow id={`${marker}on`} fill="var(--accent)" />
        </defs>
        {routes.map(({ link, state, d }) => (
          <path
            key={link.id}
            d={d}
            className={
              [state, link.dashed === true ? "dash" : ""]
                .filter(Boolean)
                .join(" ") || undefined
            }
            markerEnd={`url(#${marker}${state === "on" ? "on" : ""})`}
          />
        ))}
      </svg>
      {routes.some((r) => r.link.label !== undefined) && (
        <div
          className="link-labels"
          style={{ width: size.w, height: size.h }}
          aria-hidden="true"
        >
          {routes.flatMap(({ link, state, mid }) =>
            link.label === undefined
              ? []
              : [
                  <span
                    key={link.id}
                    className={state || undefined}
                    style={{ left: mid.x, top: mid.y }}
                  >
                    {link.label}
                  </span>,
                ],
          )}
        </div>
      )}
    </>
  );
}

function Arrow({ id, fill }: { id: string; fill: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 8 8"
      refX="7"
      refY="4"
      markerWidth="7"
      markerHeight="7"
      orient="auto-start-reverse"
    >
      <path d="M0,0 L8,4 L0,8 z" fill={fill} />
    </marker>
  );
}

/** Độ võng của cạnh vòng dưới — cặp với khoảng cách hàng 48px của các sơ đồ */
const UNDER_BEND = 44;

/**
 * Đường cong bezier giữa hai nút và điểm giữa của nó (chỗ đặt nhãn). Hai nút không chồng nhau theo chiều ngang nối
 * mép trái–phải; chồng nhau (cùng cột, hay dải trên với khung giữa) nối mép trên–dưới.
 */
function route(
  from: Box,
  to: Box,
  axis: LayerLink["axis"],
): { d: string; mid: Point } {
  const fromCx = from.x + from.w / 2;
  const toCx = to.x + to.w / 2;
  const horizontal =
    axis === undefined
      ? Math.abs(fromCx - toCx) > (from.w + to.w) / 2
      : axis === "x";
  let p0: Point;
  let p3: Point;
  let c1: Point;
  let c2: Point;
  if (axis === "under") {
    // Đỉnh vòng sâu ¾ × UNDER_BEND dưới đáy: nằm trong khoảng cách giữa hai hàng, không chạm hàng dưới
    p0 = { x: fromCx, y: from.y + from.h };
    p3 = { x: toCx, y: to.y + to.h };
    c1 = { x: p0.x, y: p0.y + UNDER_BEND };
    c2 = { x: p3.x, y: p3.y + UNDER_BEND };
  } else if (horizontal) {
    const leftward = fromCx > toCx;
    p0 = { x: leftward ? from.x : from.x + from.w, y: from.y + from.h / 2 };
    p3 = { x: leftward ? to.x + to.w : to.x, y: to.y + to.h / 2 };
    const bend = Math.max(24, Math.abs(p3.x - p0.x) / 2);
    c1 = { x: leftward ? p0.x - bend : p0.x + bend, y: p0.y };
    c2 = { x: leftward ? p3.x + bend : p3.x - bend, y: p3.y };
  } else {
    const upward = from.y > to.y;
    p0 = { x: fromCx, y: upward ? from.y : from.y + from.h };
    p3 = { x: toCx, y: upward ? to.y + to.h : to.y };
    const bend = Math.max(20, Math.abs(p3.y - p0.y) / 2);
    c1 = { x: p0.x, y: upward ? p0.y - bend : p0.y + bend };
    c2 = { x: p3.x, y: upward ? p3.y + bend : p3.y - bend };
  }
  const f = (n: number) => n.toFixed(1);
  return {
    d: `M${f(p0.x)},${f(p0.y)} C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(p3.x)},${f(p3.y)}`,
    // B(½) của bezier bậc ba
    mid: {
      x: (p0.x + 3 * c1.x + 3 * c2.x + p3.x) / 8,
      y: (p0.y + 3 * c1.y + 3 * c2.y + p3.y) / 8,
    },
  };
}

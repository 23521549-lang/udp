import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useMessages } from "../i18n";
import {
  formatClock,
  formatDayMonth,
  formatDayMonthClock,
} from "../lib/format";
import { componentsMessages } from "./components.messages";

/**
 * Biểu đồ đường theo thời gian (DESIGN.md §6 "Biểu đồ" và "Trục biểu đồ"). Một component cho mọi
 * chuỗi thời gian của Portal: canary so với đối chứng của rollout, request/lỗi/độ trễ của trang
 * Giám sát, chi phí theo ngày.
 *
 * - Thang CO THEO DỮ LIỆU. Ngưỡng chỉ vào khung khi nó không làm dữ liệu dẹt (≤ 3 lần đỉnh dữ
 *   liệu); ngoài ra nó được ghi ở chú giải. Biểu đồ rollout cũ ép thang tới ngưỡng 5% nên đường
 *   0,4% nằm dẹt dưới đáy.
 * - Điểm `null` là KHÔNG CÓ DỮ LIỆU: đường đứt ở đó, không vẽ thành 0 (I7).
 * - Rê chuột hoặc phím mũi tên hiện đường dọc, điểm và tooltip; có bảng số liệu thay thế.
 */

export type SeriesTone = "accent" | "baseline" | "v3" | "v4";

export interface ChartSeries {
  key: string;
  label: string;
  values: readonly (number | null)[];
  tone: SeriesTone;
}

export interface ChartThreshold {
  value: number;
  label: string;
}

const STROKE: Record<SeriesTone, string> = {
  accent: "var(--accent)",
  baseline: "var(--ink-4)",
  v3: "var(--v3)",
  v4: "var(--v4)",
};

const PAD = { top: 10, right: 12, bottom: 24, left: 52 };

/** Bước chia "đẹp" 1–2–2,5–5 × 10ⁿ cho khoảng [0, top] */
export function niceTicks(
  top: number,
  count = 4,
): { max: number; ticks: number[] } {
  const safeTop = top > 0 && Number.isFinite(top) ? top : 1;
  const raw = safeTop / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const unit =
    norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = unit * mag;
  const steps = Math.ceil(safeTop / step - 1e-9);
  const ticks = Array.from({ length: steps + 1 }, (_, i) =>
    Number((i * step).toPrecision(12)),
  );
  return { max: ticks[ticks.length - 1] ?? safeTop, ticks };
}

/** Miền trục tung: dữ liệu và (nếu không làm dữ liệu dẹt) ngưỡng */
export function chartDomain(
  series: readonly ChartSeries[],
  threshold?: ChartThreshold,
): {
  max: number;
  ticks: number[];
  hasData: boolean;
  thresholdInside: boolean;
} {
  let dataMax = 0;
  let hasData = false;
  for (const s of series) {
    for (const v of s.values) {
      if (v !== null && Number.isFinite(v)) {
        hasData = true;
        dataMax = Math.max(dataMax, v);
      }
    }
  }
  const t = threshold?.value;
  const thresholdInside =
    t !== undefined && t > 0 && (dataMax === 0 || t <= dataMax * 3);
  const top = Math.max(dataMax, thresholdInside ? t : 0);
  const { max, ticks } = niceTicks(top > 0 ? top * 1.1 : 1);
  return { max, ticks, hasData, thresholdInside };
}

const fx = (n: number): string => n.toFixed(1);

/** Phần tử thứ `i` của một mảng số — chỉ số luôn nằm trong mảng ở mọi chỗ gọi; 0 là rào an toàn kiểu */
const nth = (a: readonly number[], i: number): number => a[i] ?? 0;

/** Đường cong đơn điệu (Fritsch–Carlson): mượt nhưng không vọt quá điểm dữ liệu, không xuống dưới 0 */
function monotone(pts: readonly [number, number][]): string {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const n = pts.length;
  if (n === 0) return "";
  const start = `M${fx(nth(xs, 0))},${fx(nth(ys, 0))}`;
  if (n === 1) return `${start}h0.01`;
  const slope = Array.from(
    { length: n - 1 },
    (_, i) => (nth(ys, i + 1) - nth(ys, i)) / (nth(xs, i + 1) - nth(xs, i)),
  );
  const tan = Array.from({ length: n }, (_, i) => {
    if (i === 0) return nth(slope, 0);
    if (i === n - 1) return nth(slope, n - 2);
    const m0 = nth(slope, i - 1);
    const m1 = nth(slope, i);
    if (m0 * m1 <= 0) return 0;
    const d0 = nth(xs, i) - nth(xs, i - 1);
    const d1 = nth(xs, i + 1) - nth(xs, i);
    return (3 * (d0 + d1)) / ((2 * d1 + d0) / m0 + (d1 + 2 * d0) / m1);
  });
  let d = start;
  for (let i = 0; i < n - 1; i++) {
    const x0 = nth(xs, i);
    const y0 = nth(ys, i);
    const x1 = nth(xs, i + 1);
    const y1 = nth(ys, i + 1);
    const h = (x1 - x0) / 3;
    d += `C${fx(x0 + h)},${fx(y0 + nth(tan, i) * h)},${fx(x1 - h)},${fx(y1 - nth(tan, i + 1) * h)},${fx(x1)},${fx(y1)}`;
  }
  return d;
}

/** Các đoạn liên tục (không `null`) của một chuỗi */
function runs(
  values: readonly (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (cur.length > 0) out.push(cur);
      cur = [];
    } else cur.push([x(i), y(v)]);
  });
  if (cur.length > 0) out.push(cur);
  return out;
}

export function LineChart({
  title,
  level,
  times,
  series,
  format,
  threshold,
  height = 170,
}: {
  title: string;
  /** Bậc tiêu đề theo chỗ đặt — không nhảy bậc (h1 → h3) */
  level: 2 | 3 | 4;
  /** Mốc thời gian (epoch ms), chung cho mọi chuỗi */
  times: readonly number[];
  /** Tối đa bốn chuỗi (DESIGN.md §2) */
  series: readonly ChartSeries[];
  format: (v: number) => string;
  threshold?: ChartThreshold;
  height?: number;
}) {
  const m = useMessages(componentsMessages).chart;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [at, setAt] = useState<number | null>(null);
  const [byKey, setByKey] = useState(false);
  const gradient = `lc-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    const el = box.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined && w > 0) setWidth(Math.max(240, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const domain = useMemo(
    () => chartDomain(series, threshold),
    [series, threshold],
  );
  const n = times.length;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number): number =>
    PAD.left + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v: number): number =>
    PAD.top + plotH - (Math.min(v, domain.max) / domain.max) * plotH;
  const bottom = PAD.top + plotH;

  const spanMs = n > 1 ? nth(times, n - 1) - nth(times, 0) : 0;
  const tickFmt = spanMs > 36 * 3600_000 ? formatDayMonth : formatClock;
  const xTicks =
    n <= 1
      ? [0]
      : Array.from(
          new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1)))),
        );

  const Heading = `h${String(level)}` as "h2" | "h3" | "h4";

  const indexAt = (e: PointerEvent<SVGRectElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * plotW;
    return Math.max(0, Math.min(n - 1, Math.round((px / plotW) * (n - 1))));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (n === 0) return;
    const cur = at ?? n - 1;
    const next =
      e.key === "ArrowLeft"
        ? Math.max(0, cur - 1)
        : e.key === "ArrowRight"
          ? Math.min(n - 1, cur + 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : undefined;
    if (e.key === "Escape") {
      setAt(null);
      return;
    }
    if (next === undefined) return;
    e.preventDefault();
    setByKey(true);
    setAt(next);
  };

  const tipText = (i: number): string =>
    [
      formatDayMonthClock(nth(times, i)),
      ...series.map((s) => {
        const v = s.values[i];
        return `${s.label}: ${v === null || v === undefined ? m.noData : format(v)}`;
      }),
    ].join(", ");

  return (
    <figure className="lc">
      <figcaption className="lc-h">
        <Heading>{title}</Heading>
        <span className="lc-lg">
          {series.map((s) => (
            <span key={s.key} className="lg">
              <i style={{ background: STROKE[s.tone] }} />
              {s.label}
            </span>
          ))}
          {threshold !== undefined && (
            <span className="lg">
              <i style={{ background: "var(--red)" }} />
              {threshold.label}
              {!domain.thresholdInside && domain.hasData && m.aboveFrame}
            </span>
          )}
        </span>
      </figcaption>
      <div
        ref={box}
        className="chart"
        tabIndex={0}
        role="group"
        aria-roledescription={m.role}
        aria-label={m.keyboardHint(title)}
        onKeyDown={onKey}
        onBlur={() => setAt(null)}
      >
        <svg width={width} height={height} aria-hidden="true">
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.16" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {domain.ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--line)"
              />
              <text
                x={PAD.left - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="lc-ax"
              >
                {format(t)}
              </text>
            </g>
          ))}
          {n > 0 &&
            xTicks.map((i) => (
              <text
                key={i}
                x={x(i)}
                y={height - 6}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                className="lc-ax"
              >
                {tickFmt(nth(times, i))}
              </text>
            ))}
          {domain.hasData &&
            domain.thresholdInside &&
            threshold !== undefined && (
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(threshold.value)}
                y2={y(threshold.value)}
                stroke="var(--red)"
                strokeDasharray="4 4"
              />
            )}
          {domain.hasData &&
            series.map((s) => {
              const parts = runs(s.values, x, y);
              return (
                <g key={s.key}>
                  {s.tone === "accent" &&
                    parts.map((p, k) => (
                      <path
                        key={k}
                        d={`${monotone(p)}L${fx(p[p.length - 1]?.[0] ?? 0)},${fx(bottom)}L${fx(p[0]?.[0] ?? 0)},${fx(bottom)}Z`}
                        fill={`url(#${gradient})`}
                      />
                    ))}
                  {parts.map((p, k) => (
                    <path
                      key={k}
                      d={monotone(p)}
                      fill="none"
                      stroke={STROKE[s.tone]}
                      strokeWidth={s.tone === "accent" ? 2 : 1.5}
                      strokeDasharray={
                        s.tone === "baseline" ? "4 3" : undefined
                      }
                      strokeLinecap="round"
                    />
                  ))}
                </g>
              );
            })}
          {at !== null && domain.hasData && (
            <g>
              <line
                x1={x(at)}
                x2={x(at)}
                y1={PAD.top}
                y2={bottom}
                stroke="var(--line-2)"
              />
              {series.map((s) => {
                const v = s.values[at];
                return v === null || v === undefined ? null : (
                  <circle
                    key={s.key}
                    cx={x(at)}
                    cy={y(v)}
                    r={3.5}
                    fill="var(--raised)"
                    stroke={STROKE[s.tone]}
                    strokeWidth={2}
                  />
                );
              })}
            </g>
          )}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={Math.max(0, plotW)}
            height={Math.max(0, plotH)}
            fill="transparent"
            onPointerMove={(e) => {
              setByKey(false);
              setAt(indexAt(e));
            }}
            onPointerLeave={() => setAt(null)}
          />
        </svg>
        {!domain.hasData && <div className="lc-empty">{m.empty}</div>}
        {at !== null && domain.hasData && (
          <div
            className="tip"
            style={{
              left: Math.min(Math.max(x(at), 90), width - 90),
              top: PAD.top,
              opacity: 1,
            }}
          >
            <div className="c3">{formatDayMonthClock(nth(times, at))}</div>
            {series.map((s) => {
              const v = s.values[at];
              return (
                <div key={s.key} className="r2">
                  <span className="lg">
                    <i style={{ background: STROKE[s.tone] }} />
                    {s.label}
                  </span>
                  <b>{v === null || v === undefined ? "–" : format(v)}</b>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <span className="visually-hidden" aria-live="polite">
        {at !== null && byKey ? tipText(at) : ""}
      </span>
      <details className="lc-tbl">
        <summary>{m.table}</summary>
        <div className="table-wrap">
          <table className="dtable">
            <caption className="visually-hidden">{title}</caption>
            <thead>
              <tr>
                <th scope="col">{m.time}</th>
                {series.map((s) => (
                  <th key={s.key} scope="col" className="num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {times.map((t, i) => (
                <tr key={t}>
                  <td>{formatDayMonthClock(t)}</td>
                  {series.map((s) => {
                    const v = s.values[i];
                    return (
                      <td key={s.key} className="num">
                        {v === null || v === undefined ? "–" : format(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

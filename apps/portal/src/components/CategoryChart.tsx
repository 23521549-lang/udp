import { useEffect, useMemo, useRef, useState } from "react";
import { useMessages } from "../i18n";
import { downloadText, toCsv } from "../lib/download";
import { componentsMessages } from "./components.messages";
import { niceTicks, type ChartThreshold, type SeriesTone } from "./LineChart";

/**
 * [Plan #56] Biểu đồ cột theo NHÓM (DESIGN.md §6 "Trục biểu đồ"): mỗi nhóm trên trục hoành là một ô của một lưới
 * đo ("10 flag · 50 rule", "T = 3, V = 2"), mỗi cột trong nhóm là một chuỗi (tối đa bốn). Dùng cho số đo của
 * trang Bằng chứng, nơi `LineChart` (trục thời gian) không vừa.
 *
 * - **Thang log** khi dữ liệu trải nhiều bậc độ lớn (µs của lõi và ms của OFREP, 260 series và 52 260 series):
 *   vạch chia là lũy thừa của 10. Giá trị ≤ 0 không có chỗ trên thang log — cột đó bỏ trống, bảng ghi đúng số.
 * - Ngưỡng (500 ms của danh sách flag, giá trị tới hạn của χ²) là đường đứt đỏ, như `LineChart`.
 * - Bảng số liệu thay thế (trình đọc màn hình, và người muốn đọc số chính xác), và — khi có `csvFileName` — một
 *   nút tải CSV với số THÔ để vẽ lại trong luận văn.
 */

export interface CategorySeries {
  key: string;
  label: string;
  /** Một giá trị cho mỗi nhóm, cùng thứ tự với `categories`; `null` là không có dữ liệu */
  values: readonly (number | null)[];
  tone: SeriesTone;
}

export interface Category {
  key: string;
  /** Nhãn ngắn dưới trục ("10×50") */
  short: string;
  /** Nhãn đầy đủ trong bảng và CSV ("10 flag · 50 rule") */
  label: string;
}

const FILL: Record<SeriesTone, string> = {
  accent: "var(--accent)",
  baseline: "var(--ink-4)",
  v3: "var(--v3)",
  v4: "var(--v4)",
};

const PAD = { top: 10, right: 12, bottom: 24, left: 60 };

interface Axis {
  ticks: number[];
  /** Vị trí 0–1 (đáy → đỉnh) của một giá trị; `null` khi không vẽ được (≤ 0 trên thang log) */
  at: (v: number) => number | null;
}

/** Trục tuyến tính từ 0, co theo dữ liệu; ngưỡng vào khung khi không làm dữ liệu dẹt (≤ 3 lần đỉnh) */
function linearAxis(max: number, threshold?: number): Axis {
  const inside =
    threshold !== undefined && threshold > 0 && threshold <= max * 3;
  const top = Math.max(max, inside ? threshold : 0);
  const { max: domainMax, ticks } = niceTicks(top > 0 ? top * 1.1 : 1);
  return { ticks, at: (v) => Math.min(v, domainMax) / domainMax };
}

/** Trục log: từ lũy thừa của 10 dưới giá trị nhỏ nhất tới lũy thừa trên giá trị lớn nhất; tối đa năm vạch */
export function logAxis(min: number, max: number): Axis {
  const lo = Math.floor(Math.log10(min));
  const hi = Math.max(lo + 1, Math.ceil(Math.log10(max)));
  const span = hi - lo;
  const every = Math.ceil(span / 4);
  const ticks: number[] = [];
  for (let e = lo; e <= hi; e += every) ticks.push(10 ** e);
  return {
    ticks,
    at: (v) => (v > 0 ? (Math.log10(v) - lo) / span : null),
  };
}

/** CSV của biểu đồ: một hàng mỗi nhóm, một cột mỗi chuỗi — số thô */
export function categoryCsv(
  categories: readonly Category[],
  series: readonly CategorySeries[],
  groupHeader: string,
): string {
  return toCsv(
    [groupHeader, ...series.map((s) => s.label)],
    categories.map((c, i) => [
      c.label,
      ...series.map((s) => s.values[i] ?? null),
    ]),
  );
}

export function CategoryChart({
  title,
  level,
  categories,
  series,
  format,
  scale = "linear",
  threshold,
  groupHeader,
  csvFileName,
  height = 200,
}: {
  title: string;
  level: 2 | 3 | 4;
  categories: readonly Category[];
  /** Tối đa bốn chuỗi (DESIGN.md §2) */
  series: readonly CategorySeries[];
  format: (v: number) => string;
  scale?: "linear" | "log";
  threshold?: ChartThreshold;
  /** Tên cột nhóm trong bảng và CSV ("Ô lưới", "Kịch bản") */
  groupHeader: string;
  /** Có ⇒ nút "Tải CSV" với tên tệp này */
  csvFileName?: string;
  height?: number;
}) {
  const m = useMessages(componentsMessages).chart;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);

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

  const values = useMemo(
    () =>
      series.flatMap((s) =>
        s.values.filter((v): v is number => v !== null && Number.isFinite(v)),
      ),
    [series],
  );
  const hasData = values.length > 0;
  const axis = useMemo((): Axis => {
    if (scale === "log") {
      const positive = [
        ...values.filter((v) => v > 0),
        ...(threshold !== undefined && threshold.value > 0
          ? [threshold.value]
          : []),
      ];
      return positive.length === 0
        ? linearAxis(1)
        : logAxis(Math.min(...positive), Math.max(...positive));
    }
    return linearAxis(Math.max(0, ...values), threshold?.value);
  }, [scale, values, threshold]);

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const bottom = PAD.top + plotH;
  const y = (f: number): number => bottom - f * plotH;
  const groupW = categories.length === 0 ? plotW : plotW / categories.length;
  const barW = Math.max(2, (groupW * 0.72) / Math.max(1, series.length));
  const thresholdAt = threshold === undefined ? null : axis.at(threshold.value);
  const Heading = `h${String(level)}` as "h2" | "h3" | "h4";

  return (
    <figure className="lc cc">
      <figcaption className="lc-h">
        <Heading>{title}</Heading>
        <span className="lc-lg">
          {series.map((s) => (
            <span key={s.key} className="lg">
              <i style={{ background: FILL[s.tone] }} />
              {s.label}
            </span>
          ))}
          {threshold !== undefined && (
            <span className="lg">
              <i style={{ background: "var(--red)" }} />
              {threshold.label}
            </span>
          )}
          {scale === "log" && <span className="c3">{m.logScale}</span>}
        </span>
      </figcaption>
      <div ref={box} className="chart">
        <svg width={width} height={height} aria-hidden="true">
          {axis.ticks.map((t) => {
            const f = axis.at(t);
            return f === null ? null : (
              <g key={t}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(f)}
                  y2={y(f)}
                  stroke="var(--line)"
                />
                <text
                  x={PAD.left - 8}
                  y={y(f)}
                  dy="0.32em"
                  textAnchor="end"
                  className="lc-ax"
                >
                  {format(t)}
                </text>
              </g>
            );
          })}
          {hasData &&
            categories.map((c, ci) => {
              const left =
                PAD.left + ci * groupW + (groupW - barW * series.length) / 2;
              return (
                <g key={c.key}>
                  {series.map((s, si) => {
                    const v = s.values[ci];
                    const f = v === null || v === undefined ? null : axis.at(v);
                    if (f === null || f <= 0) return null;
                    return (
                      <rect
                        key={s.key}
                        x={left + si * barW}
                        y={y(f)}
                        width={Math.max(1, barW - 1)}
                        height={Math.max(0, bottom - y(f))}
                        fill={FILL[s.tone]}
                        rx={1.5}
                      >
                        <title>{`${c.label}, ${s.label}: ${format(v ?? 0)}`}</title>
                      </rect>
                    );
                  })}
                  <text
                    x={PAD.left + ci * groupW + groupW / 2}
                    y={height - 6}
                    textAnchor="middle"
                    className="lc-ax"
                  >
                    {c.short}
                  </text>
                </g>
              );
            })}
          {hasData && thresholdAt !== null && thresholdAt <= 1 && (
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(thresholdAt)}
              y2={y(thresholdAt)}
              stroke="var(--red)"
              strokeDasharray="4 4"
            />
          )}
        </svg>
        {!hasData && <div className="lc-empty">{m.empty}</div>}
      </div>
      <div className="cc-foot">
        <details className="lc-tbl">
          <summary>{m.table}</summary>
          <div className="table-wrap">
            <table className="dtable">
              <caption className="visually-hidden">{title}</caption>
              <thead>
                <tr>
                  <th scope="col">{groupHeader}</th>
                  {series.map((s) => (
                    <th key={s.key} scope="col" className="num">
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {categories.map((c, ci) => (
                  <tr key={c.key}>
                    <th scope="row">{c.label}</th>
                    {series.map((s) => {
                      const v = s.values[ci];
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
        {csvFileName !== undefined && (
          <button
            type="button"
            className="btn"
            onClick={() =>
              downloadText(
                csvFileName,
                "text/csv;charset=utf-8",
                categoryCsv(categories, series, groupHeader),
              )
            }
          >
            {m.csv}
          </button>
        )}
      </div>
    </figure>
  );
}

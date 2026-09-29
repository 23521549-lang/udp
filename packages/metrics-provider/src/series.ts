import type {
  MetricSeries,
  SeriesKind,
  SeriesPoint,
  SeriesWindow,
} from "./provider.js";

/**
 * Luật chung của chuỗi thời gian (Plan #53 QĐ-4) — trang Giám sát vẽ RED của một workload.
 *
 * Một chỗ cho bốn thứ mà mọi nguồn metrics phải làm giống nhau: lưới thời gian (điểm nào, bao
 * nhiêu điểm), cửa sổ rate của PromQL, đơn vị của từng loại chuỗi, và lỗi khi không hỏi được.
 * Nguồn nào tự tính lưới là mỗi nguồn một kiểu làm tròn — hai đồ thị cạnh nhau lệch một bước.
 */

/** Số bước nhiều nhất của một lần hỏi — che backend khỏi một `rangeSec/stepSec` vô lý */
export const MAX_SERIES_STEPS = 500;

/**
 * Cửa sổ rate không ngắn hơn 60 giây: scrape 30 giây thì cửa sổ 60 giây vẫn có hai mẫu, và
 * `rate()` cần ít nhất hai mẫu mới ra số — ngắn hơn là đồ thị thủng lỗ dù app vẫn có lưu lượng.
 */
export const MIN_SERIES_RATE_WINDOW_SEC = 60;

/** Cửa sổ `[…s]` của `rate()` cho bước `stepSec` — CHỈ tính ở đây */
export function seriesRateWindowSec(stepSec: number): number {
  return Math.max(stepSec, MIN_SERIES_RATE_WINDOW_SEC);
}

export const SERIES_UNIT: Readonly<Record<SeriesKind, MetricSeries["unit"]>> = {
  requestRate: "rps",
  errorRatio: "ratio",
  latencyP99: "ms",
};

/**
 * Không hỏi được nguồn metrics — HTTP lỗi, hết giờ, trả sai hình. Service 1 đổi thành 503.
 *
 * Chuỗi thời gian KHÔNG có đường lùi "trả toàn 0": một đồ thị phẳng ở 0 lúc Prometheus chết
 * đọc y hệt "không ai gọi service" — đúng lớp lỗi I7 đã cấm ở phép đo tức thời.
 */
export class MetricsQueryError extends Error {
  override readonly name = "MetricsQueryError";

  constructor(
    readonly providerId: string,
    /** Truy vấn đã hỏng — để người vận hành chạy lại tay */
    readonly query: string,
    detail = "HTTP lỗi, hết giờ hoặc trả sai hình",
  ) {
    super(`${providerId}: truy vấn chuỗi thời gian hỏng (${detail})`);
  }
}

/** Lưới của một lần hỏi: mốc đầu, mốc cuối (đều chia hết cho bước) và mọi mốc ở giữa */
export interface SeriesGrid {
  startSec: number;
  endSec: number;
  stepSec: number;
  times: number[];
}

const isPositiveInteger = (n: number): boolean => Number.isInteger(n) && n > 0;

/**
 * Lưới theo hợp đồng của `MetricsProvider.series`: từ `⌊(end − range)/step⌋·step` tới
 * `⌊end/step⌋·step`, mỗi bước một điểm, tăng dần. Mốc chia hết cho bước nên hai lần hỏi cách
 * nhau vài giây ra CÙNG các mốc — đồ thị không nhảy khi trang tự làm mới.
 *
 * `RangeError` khi cửa sổ vô lý: bước/khoảng không phải số giây nguyên dương, `end` không phải
 * thời điểm, hay quá `MAX_SERIES_STEPS` bước. Bên gọi tính bước sao cho không bao giờ chạm.
 */
export function seriesGrid(window: SeriesWindow): SeriesGrid {
  const { rangeSec, stepSec } = window;
  if (!isPositiveInteger(rangeSec) || !isPositiveInteger(stepSec)) {
    throw new RangeError(
      `Khoảng và bước của chuỗi thời gian phải là số giây nguyên dương, nhận rangeSec=${String(rangeSec)}, stepSec=${String(stepSec)}`,
    );
  }
  if (rangeSec / stepSec > MAX_SERIES_STEPS) {
    throw new RangeError(
      `Chuỗi thời gian quá dày: ${String(rangeSec)}s / ${String(stepSec)}s vượt ${String(MAX_SERIES_STEPS)} bước`,
    );
  }
  const endMs = (window.end ?? new Date()).getTime();
  if (!Number.isFinite(endMs)) {
    throw new RangeError("Mốc cuối của chuỗi thời gian không phải thời điểm");
  }
  const end = endMs / 1000;
  const startSec = Math.floor((end - rangeSec) / stepSec) * stepSec;
  const endSec = Math.floor(end / stepSec) * stepSec;
  const times: number[] = [];
  for (let t = startSec; t <= endSec; t += stepSec) times.push(t);
  return { startSec, endSec, stepSec, times };
}

/**
 * Đặt các điểm nguồn trả vào lưới: mốc gần nhất (nguồn trả `1700000060.0` hay lệch vài mili
 * giây vẫn vào đúng ô), ngoài lưới thì bỏ, ô không ai điền là `null` — KHÔNG có dữ liệu, không
 * phải 0 (I7). Hai điểm rơi cùng ô thì điểm có số đến sau thắng.
 */
export function alignSeries(
  grid: SeriesGrid,
  points: readonly SeriesPoint[],
): SeriesPoint[] {
  const values: (number | null)[] = grid.times.map(() => null);
  for (const p of points) {
    if (p.v === null || !Number.isFinite(p.v)) continue;
    const index = Math.round((p.t - grid.startSec) / grid.stepSec);
    // Mốc hỏng (`NaN`) cho chỉ số không nguyên — bỏ như điểm ngoài lưới
    if (!Number.isInteger(index) || index < 0 || index >= values.length) {
      continue;
    }
    values[index] = p.v;
  }
  return grid.times.map((t, i) => ({ t, v: values[i] ?? null }));
}

/** Số hữu hạn ⇒ chính nó; `NaN`, `±Inf`, thiếu ⇒ `null` */
export function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

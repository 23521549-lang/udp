import { hourFloor } from "@udp/shared-types/flag-stats";

/**
 * [v4.9] Bộ gộp số đếm lượt đánh giá trong bộ nhớ (§2.2 FlagEvaluationStat, §6.8).
 *
 * Thuần, không I/O, không timer: `stats.flusher.ts` mới biết database, và nhờ
 * vậy mọi tính chất khó của bộ gộp — gộp đúng khoá, trần bộ nhớ, bảo toàn số
 * đếm — kiểm được bằng đồng hồ giả, không cần database.
 *
 * Ba quyết định định hình toàn bộ file:
 *
 *   - **Bucket giờ tính LÚC NHẬN, theo UTC, bằng đồng hồ tiêm vào** (T2, R12).
 *     Đồng hồ máy khách không tin được (lệch, giả), và `date_trunc('hour', …)`
 *     của Postgres thì phụ thuộc `TimeZone` của phiên — hai kết nối khác múi
 *     sinh hai hàng cho cùng một giờ thật và làm vỡ ngữ nghĩa của unique index.
 *     Sai số tối đa bằng chu kỳ báo cáo của provider (60 giây), vô nghĩa ở độ
 *     phân giải giờ.
 *   - **Chia theo environment ở tầng ngoài.** Trần theo env là thứ giữ cho một
 *     khoá SERVER bị lộ (bơm flagKey rác) không làm đói env khác trên cùng
 *     replica (R10).
 *   - **Khoá gộp là `JSON.stringify([bucketHour, flagKey, variant])`.** Ghép
 *     chuỗi bằng dấu phân cách thì một `flagKey` chứa dấu đó gộp nhầm hai mục;
 *     `JSON.stringify` không có ca đó. Khoá này TRÙNG với khoá xung đột của
 *     `flag_evaluation_stats`, nên một lô không bao giờ chứa hai hàng cùng khoá
 *     — đúng điều kiện mà `ON CONFLICT DO UPDATE` đòi (R7 V1, INV-23.5).
 */

/** Một hàng đã gộp, sẵn sàng cho `upsertBatch` */
export interface StatsRow {
  environmentId: string;
  flagKey: string;
  variant: string;
  count: number;
  /** Mốc đầu giờ UTC, tính bằng epoch ms */
  bucketHour: number;
}

/**
 * Vì sao một lượt đếm bị bỏ — nhãn của `udp_flag_stats_dropped_total`:
 *
 *   - `env-cap`, `total-cap`: mục MỚI vượt trần bộ nhớ (mục đã có vẫn cộng, vì
 *     cộng vào một khoá sẵn có không tốn thêm bộ nhớ nào);
 *   - `flush-failed`: lô bị trả về sau khi ghi database hỏng mà chỗ đã hết;
 *   - `saturated`: tổng của một khoá vượt `Number.MAX_SAFE_INTEGER`.
 */
export type StatsDropReason =
  "env-cap" | "total-cap" | "flush-failed" | "saturated";

export interface StatsAggregatorDeps {
  now?: () => number;
  maxPendingEntries: number;
  maxPendingEntriesPerEnvironment: number;
  /** `count` lượt đếm đã bị bỏ vì `reason` */
  onDrop?: (reason: StatsDropReason, count: number) => void;
}

export interface StatsAggregator {
  /** Cộng `count` lượt cho `(env, flagKey, variant)` vào bucket giờ HIỆN TẠI */
  record(
    environmentId: string,
    flagKey: string,
    variant: string,
    count: number,
  ): void;
  /** Lấy hết số đang giữ và để lại bộ gộp rỗng — TRÁO đồng bộ, không `await` ở giữa */
  drain(): StatsRow[];
  /** Cộng ngược một lô chưa ghi được; phần không còn chỗ bị bỏ (`flush-failed`) */
  restore(rows: readonly StatsRow[]): void;
  /** Số mục (khoá) đang giữ — cho test và cho trần */
  size(): number;
}

/** Khoá gộp trong một environment */
const keyOf = (bucketHour: number, flagKey: string, variant: string): string =>
  JSON.stringify([bucketHour, flagKey, variant]);

export function createStatsAggregator({
  now = Date.now,
  maxPendingEntries,
  maxPendingEntriesPerEnvironment,
  onDrop,
}: StatsAggregatorDeps): StatsAggregator {
  let pending = new Map<string, Map<string, number>>();
  let total = 0;

  const drop = (reason: StatsDropReason, count: number): void => {
    onDrop?.(reason, count);
  };

  /**
   * Cộng dồn BÃO HOÀ: `Number.MAX_SAFE_INTEGER` là trần, phần vượt được ĐẾM là
   * bỏ chứ không lặng lẽ mất độ chính xác. Một số vượt 2^53 chỉ tới được ở
   * trường hợp đối nghịch (khoá SERVER bị lộ bơm `count` ở trần), nhưng nếu tới
   * thì lệch âm thầm là kết cục tệ nhất: `eval_count` sai không có cách nào phát
   * hiện lại từ dữ liệu.
   */
  const add = (slot: Map<string, number>, key: string, count: number): void => {
    const current = slot.get(key) ?? 0;
    const sum = current + count;
    if (Number.isSafeInteger(sum)) {
      slot.set(key, sum);
      return;
    }
    slot.set(key, Number.MAX_SAFE_INTEGER);
    drop("saturated", sum - Number.MAX_SAFE_INTEGER);
  };

  /**
   * Nhận một lượt đếm vào đúng khoá, hoặc bỏ nó và nói vì sao.
   *
   * Trần chỉ chặn mục MỚI. Mục đã có vẫn được cộng kể cả khi đã chạm trần: nó
   * không làm bảng băm to thêm, và bỏ nó là đếm THIẾU — hướng nguy hiểm, vì
   * đếm thiếu làm flag bị xếp UNUSED rồi archive lọt chốt 7 ngày (R01, R18).
   */
  const accept = (
    environmentId: string,
    key: string,
    count: number,
    restored: boolean,
  ): void => {
    const slot = pending.get(environmentId) ?? new Map<string, number>();
    if (slot.has(key)) {
      add(slot, key, count);
      return;
    }
    // Lô bị trả về mà hết chỗ thì lý do THẬT là "ghi hỏng", không phải "quá tải"
    if (slot.size >= maxPendingEntriesPerEnvironment) {
      drop(restored ? "flush-failed" : "env-cap", count);
      return;
    }
    if (total >= maxPendingEntries) {
      drop(restored ? "flush-failed" : "total-cap", count);
      return;
    }
    slot.set(key, count);
    total += 1;
    pending.set(environmentId, slot);
  };

  return {
    record(environmentId, flagKey, variant, count) {
      const bucketHour = hourFloor(new Date(now())).getTime();
      accept(environmentId, keyOf(bucketHour, flagKey, variant), count, false);
    },

    /**
     * Tráo Map trong MỘT khối đồng bộ.
     *
     * Không có `await` nào giữa lúc đọc và lúc thay: một `record` xảy ra trong khi
     * lô đang được ghi database rơi vào Map MỚI, nên nó không mất (Map cũ đã rời
     * tay bộ gộp) và cũng không bị đếm hai lần (nó chưa từng ở trong lô cũ).
     */
    drain() {
      const drained = pending;
      pending = new Map();
      total = 0;

      const rows: StatsRow[] = [];
      for (const [environmentId, slot] of drained) {
        for (const [key, count] of slot) {
          const [bucketHour, flagKey, variant] = JSON.parse(key) as [
            number,
            string,
            string,
          ];
          rows.push({ environmentId, flagKey, variant, count, bucketHour });
        }
      }
      return rows;
    },

    restore(rows) {
      for (const row of rows) {
        accept(
          row.environmentId,
          keyOf(row.bucketHour, row.flagKey, row.variant),
          row.count,
          true,
        );
      }
    },

    size() {
      return total;
    },
  };
}

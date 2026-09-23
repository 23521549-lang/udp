import type { SdkKeyType } from "@udp/db";
import type { Snapshot } from "@udp/flag-evaluator";
import { STATS_VARIANT, type SdkStatsReport } from "@udp/shared-types";
import type { StatsAggregator } from "./stats.aggregator.js";

/**
 * [v4.9] Nhận một báo cáo `POST /sdk/stats` (V6): kiểm từng mục bằng snapshot
 * của CHÍNH environment suy ra từ khoá, rồi cộng vào bộ gộp.
 *
 * Vì sao phải kiểm lúc NHẬN chứ không để database lọc lúc flush: một khoá SERVER
 * bị lộ gửi `flagKey` ngẫu nhiên sẽ làm Map trong bộ nhớ phình theo lưu lượng,
 * và trần bộ nhớ chỉ chặn được hậu quả chứ không chặn nguyên nhân (R10). Kiểm ở
 * đây còn trả lại cho client một con số có nghĩa: `ignored` nói "flag này tôi
 * không biết", để SDK sửa được mà không cần đọc log server.
 */

/** Nguồn snapshot — chỉ cần chừng này, nên `modules/stats` không phụ thuộc `changefeed/` */
export interface SnapshotSource {
  get(
    environmentId: string,
    keyType: SdkKeyType,
  ): Promise<{ snapshot: Snapshot }>;
}

export interface StatsIngest {
  /** Nhận một báo cáo đã qua zod; trả số mục đã nhận và số mục bị bỏ qua */
  acceptReport(
    environmentId: string,
    counts: SdkStatsReport["counts"],
  ): Promise<{ accepted: number; ignored: number }>;
  /** Ngừng nhận (đang tắt máy): từ đây `/sdk/stats` trả 503 */
  close(): void;
  /** Đang tắt máy hay không */
  readonly closing: boolean;
}

interface FlagFacts {
  archived: boolean;
  variants: Set<string>;
}

/**
 * Chỉ mục `flagKey ⇒ (trạng thái, tập variant)` của MỘT bộ ba cache, nhớ trong
 * `WeakMap` theo chính đối tượng entry (khuôn `snapshotChunks` của hub SSE).
 *
 * Bộ ba cache là bất biến: một `ConfigEntry` mới được dựng cho mỗi lần đổi cấu
 * hình, nên chỉ mục không bao giờ cũ, và `WeakMap` thả nó cùng lúc với entry —
 * không có cache thứ hai phải làm tươi hay phải dọn. Nếu quét mảng
 * `snapshot.flags` cho từng mục thì một báo cáo 2 000 mục trên env có 500 flag
 * là một triệu phép so chuỗi trên event loop (C-16).
 */
const indexes = new WeakMap<object, Map<string, FlagFacts>>();

function flagIndexOf(entry: { snapshot: Snapshot }): Map<string, FlagFacts> {
  const cached = indexes.get(entry);
  if (cached !== undefined) return cached;

  const index = new Map<string, FlagFacts>();
  for (const flag of entry.snapshot.flags) {
    index.set(
      flag.key,
      "archived" in flag
        ? { archived: true, variants: new Set() }
        : { archived: false, variants: new Set(Object.keys(flag.variants)) },
    );
  }
  indexes.set(entry, index);
  return index;
}

/**
 * Mục này có được đếm không.
 *
 * Flag KHÔNG có trong snapshot gồm cả flag DRAFT (§6.7: SDK chưa nhận) và flag
 * của project khác — cả hai bị bỏ qua IM LẶNG với 202, không 404: mã phản hồi
 * khác nhau theo sự tồn tại của flag là một kênh dò cho người cầm khoá.
 *
 * Bia mộ (ARCHIVED) chỉ nhận `__disabled__`, vì đó là kết quả DUY NHẤT lõi đánh
 * giá trả cho nó. Flag còn sống nhận variant thật của nó, cộng hai nhãn không
 * phải variant. Tiền tố `__` bị cấm ở key variant nên hai tập không chồng nhau.
 */
function counts(facts: FlagFacts | undefined, variant: string): boolean {
  if (facts === undefined) return false;
  if (variant === STATS_VARIANT.disabled) return true;
  if (facts.archived) return false;
  return variant === STATS_VARIANT.error || facts.variants.has(variant);
}

export function createStatsIngest({
  cache,
  aggregator,
}: {
  cache: SnapshotSource;
  aggregator: StatsAggregator;
}): StatsIngest {
  let closing = false;

  return {
    get closing() {
      return closing;
    },

    close() {
      closing = true;
    },

    async acceptReport(environmentId, reported) {
      /**
       * Snapshot SERVER: `/sdk/stats` chỉ nhận khoá SERVER (ADR-03), và đó cũng
       * là bộ ba mà `/sdk/config` của chính khoá này đọc — hai bề mặt không được
       * bất đồng về "flag nào có thật". Env chưa nằm trong cache thì tốn một lần
       * nạp (~77 ms), y như lần `/sdk/config` đầu tiên.
       */
      const entry = await cache.get(environmentId, "SERVER");
      const index = flagIndexOf(entry);

      let accepted = 0;
      let ignored = 0;
      for (const item of reported) {
        if (!counts(index.get(item.flagKey), item.variant)) {
          ignored += 1;
          continue;
        }
        aggregator.record(
          environmentId,
          item.flagKey,
          item.variant,
          item.count,
        );
        accepted += 1;
      }
      return { accepted, ignored };
    },
  };
}

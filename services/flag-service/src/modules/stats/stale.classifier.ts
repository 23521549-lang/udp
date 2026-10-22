import { STALE_FLAG_THRESHOLDS } from "@udp/config";
import type { FlagLifecycleStatus } from "@udp/db";
import { daysBefore, type StaleCategory } from "@udp/shared-types";

/**
 * [v4.9] Bảng quyết định của Cleanup Center (§6.7) — hàm THUẦN, không database,
 * không đồng hồ (R20, T4).
 *
 * Tách khỏi truy vấn vì đây là phần dễ sai nhất và cũng là phần rẻ nhất để kiểm:
 * mười hai ô của bảng quyết định thành mười hai ca unit, không cần seed một hàng
 * nào. Truy vấn chỉ còn nhiệm vụ đếm đúng hai cửa sổ.
 *
 * Bốn luật, mỗi luật một lý do:
 *
 *   - **Tối đa MỘT nhãn.** UNUSED đòi 0 lượt trong 30 ngày, SETTLED đòi ≥ 100 lượt
 *     trong 14 ngày, nên hai nhãn không thể cùng đúng; trả mảng (0 hoặc 1 phần tử)
 *     để chỗ gọi không phải phân biệt "chưa xếp" với "không có nhãn".
 *   - **Tuổi quan sát được**, không phải tuổi flag: `max(activatedAt,
 *     telemetryStartedAt)`. Flag nháp 40 ngày rồi mới ACTIVE hôm qua thì chưa có
 *     dữ liệu để nói nó chết (R20 (a)); project vừa bật telemetry hôm qua cũng vậy
 *     (R01 (c)).
 *   - **`permanent` miễn cả hai nhãn**, không chỉ UNUSED: kill-switch ổn định luôn
 *     rơi 100% vào một nhánh nên sẽ là SETTLED vĩnh viễn (R20 (g)).
 *   - **SETTLED chỉ trên variant THẬT.** Tiền tố `__` là không gian tên của nhãn
 *     stats (`flag-api.ts` cấm key variant bắt đầu bằng nó), nên "ổn định ở nhánh
 *     `__disabled__`" là câu nói về flag đang TẮT, không phải flag đã chốt kết quả
 *     — và một hàng `__error__` thì càng không (R20 (c), (d)).
 */

export interface StaleFlagFacts {
  lifecycleStatus: FlagLifecycleStatus;
  permanent: boolean;
  createdAt: Date;
  /** Lần chuyển sang ACTIVE gần nhất — trigger DB đặt; DRAFT thì null */
  activatedAt: Date | null;
}

/** Tổng theo VARIANT của một flag, đã cộng mọi environment, trong hai cửa sổ */
export interface StaleVariantTotal {
  variantKey: string;
  /** Cửa sổ `unusedDays` */
  countUnusedWindow: number;
  /** Cửa sổ `settledDays` */
  countSettledWindow: number;
}

export interface StaleContext {
  asOf: Date;
  /** `min(bucket_hour)` của project — `null` = chưa từng nhận báo cáo nào */
  telemetryStartedAt: Date | null;
}

export interface StaleVerdict {
  /** 0 hoặc 1 nhãn */
  categories: readonly StaleCategory[];
  /** Chỉ với SETTLED: variant duy nhất nhận mọi lượt của cửa sổ */
  settled?: { variantKey: string; count: number };
}

const NOTHING: StaleVerdict = { categories: [] };

/** Đã quan sát được ít nhất `days` ngày tính tới `asOf` */
function observedFor(
  flag: StaleFlagFacts,
  context: StaleContext,
  days: number,
): boolean {
  if (flag.activatedAt === null || context.telemetryStartedAt === null) {
    return false;
  }
  const since = Math.max(
    flag.activatedAt.getTime(),
    context.telemetryStartedAt.getTime(),
  );
  return since <= daysBefore(context.asOf, days).getTime();
}

export function classifyStale(
  flag: StaleFlagFacts,
  totals: readonly StaleVariantTotal[],
  context: StaleContext,
): StaleVerdict {
  if (flag.lifecycleStatus === "ARCHIVED") return NOTHING;

  if (flag.lifecycleStatus === "DRAFT") {
    const cutoff = daysBefore(
      context.asOf,
      STALE_FLAG_THRESHOLDS.staleDraftDays,
    );
    return flag.createdAt.getTime() <= cutoff.getTime()
      ? { categories: ["STALE_DRAFT"] }
      : NOTHING;
  }

  if (flag.permanent) return NOTHING;

  const unused = totals.some((t) => t.countUnusedWindow > 0);
  if (!unused && observedFor(flag, context, STALE_FLAG_THRESHOLDS.unusedDays)) {
    return { categories: ["UNUSED"] };
  }

  const live = totals.filter((t) => t.countSettledWindow > 0);
  const only = live.length === 1 ? live[0] : undefined;
  if (
    only !== undefined &&
    !only.variantKey.startsWith("__") &&
    only.countSettledWindow >= STALE_FLAG_THRESHOLDS.settledMinEvals &&
    observedFor(flag, context, STALE_FLAG_THRESHOLDS.settledDays)
  ) {
    return {
      categories: ["SETTLED"],
      settled: { variantKey: only.variantKey, count: only.countSettledWindow },
    };
  }

  return NOTHING;
}

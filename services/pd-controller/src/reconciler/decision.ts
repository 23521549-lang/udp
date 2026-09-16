import { ROLLOUT_ANALYSIS } from "@udp/config";
import type { MetricSample } from "@udp/metrics-provider";
import type { RolloutThresholds } from "@udp/shared-types";
import type { Decision, MetricSnapshot } from "../rollout-session/types.js";

/**
 * Phân tích metrics và ra quyết định (§7.1 `decide`, §7.4, §7.5) — hàm THUẦN.
 *
 * Không có I/O ở đây: reconciler đo bằng `MetricsProvider` rồi đưa năm mẫu vào.
 * Nhờ vậy sáu vấn đề của §7.5 kiểm được bằng fixture, không cần Prometheus:
 *   1. Ít dữ liệu ⇒ chờ `warmUpRequests`.
 *   2. Spike thoáng qua ⇒ chỉ rollback sau `maxConsecutiveBreaches` lần đo LIÊN
 *      TIẾP trên các cửa sổ KHÔNG chồng lấn.
 *   3. Nguồn metrics chết ⇒ `hasData = false` ⇒ HOLD, không bao giờ PROMOTE (I7).
 *   4. Traffic quá thấp ⇒ việc của `max_duration_seconds` ở reconciler.
 *   5. Độ phân giải kém ⇒ `minErrors` cho ngưỡng tuyệt đối, z-test cho tương đối.
 *   6. Đo lẫn dữ liệu bậc trước ⇒ `settleGate`: chỉ đo khi cửa sổ nằm TRỌN sau
 *      `lastStepAt + window + scrapeLag`.
 *
 * Giá trị của `decision` là `"PROMOTE"` (không phải "PROMOTE_OK"): đó là tên
 * trường/giá trị mà §2.2 và §9 khai cho Portal.
 */

export interface AnalysisContext {
  thresholds: RolloutThresholds;
  warmUpRequests: number;
  metricWindowSeconds: number;
  lastStepAt: Date | null;
  scrapeLagSeconds: number;
  previous: Decision | null;
  /** Epoch ms — đồng hồ JS tiêm vào */
  now: number;
}

export interface Samples {
  canaryRequests: MetricSample;
  canaryErrors: MetricSample;
  canaryP99: MetricSample;
  baselineRequests: MetricSample;
  baselineErrors: MetricSample;
}

/** Kiểm định hai tỉ lệ (pooled), một phía: H1 = canary lỗi nhiều hơn baseline (§7.4) */
export function twoProportionZ(
  e1: number,
  n1: number,
  e2: number,
  n2: number,
): number {
  if (n1 === 0 || n2 === 0) return 0;
  const p1 = e1 / n1;
  const p2 = e2 / n2;
  const p = (e1 + e2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (p1 - p2) / se;
}

/**
 * Cửa sổ metric đã nằm TRỌN sau bậc mới chưa. Trả lý do HOLD nếu chưa — reconciler
 * không đo gì cả trong lúc đó, tiết kiệm cả truy vấn lẫn một quyết định sai.
 */
export function settleGate(ctx: AnalysisContext): string | undefined {
  if (ctx.lastStepAt === null) return undefined;
  const readyAt =
    ctx.lastStepAt.getTime() +
    (ctx.metricWindowSeconds + ctx.scrapeLagSeconds) * 1000;
  if (ctx.now < readyAt) {
    const wait = Math.ceil((readyAt - ctx.now) / 1000);
    return `Chờ cửa sổ metric ổn định sau bậc mới (${String(wait)}s nữa)`;
  }
  return undefined;
}

function snapshotOf(
  s: Samples,
  windowSeconds: number,
  at: number,
): MetricSnapshot {
  const branch = (
    requests: MetricSample,
    errors: MetricSample,
    p99?: MetricSample,
  ): MetricSnapshot["canary"] => {
    const hasData = requests.hasData && errors.hasData;
    return {
      requestCount: hasData ? requests.value : 0,
      errorCount: hasData ? errors.value : 0,
      errorRate:
        hasData && requests.value > 0 ? errors.value / requests.value : 0,
      ...(p99?.hasData === true ? { latencyP99Ms: p99.value } : {}),
      hasData,
    };
  };
  const baseline = branch(s.baselineRequests, s.baselineErrors);
  return {
    canary: branch(s.canaryRequests, s.canaryErrors, s.canaryP99),
    baseline,
    zScore: baseline.hasData
      ? twoProportionZ(
          s.canaryErrors.value,
          s.canaryRequests.value,
          s.baselineErrors.value,
          s.baselineRequests.value,
        )
      : null,
    queries: {
      canary: [s.canaryRequests.query, s.canaryErrors.query, s.canaryP99.query],
      baseline: [s.baselineRequests.query, s.baselineErrors.query],
    },
    windowSeconds,
    at,
  };
}

export function decide(ctx: AnalysisContext, s: Samples): Decision {
  const snapshot = snapshotOf(s, ctx.metricWindowSeconds, ctx.now);
  const hold = (reason: string): Decision => ({
    decision: "HOLD",
    reason,
    at: ctx.now,
    breach: false,
    breachStreak: 0,
    breachAt: null,
    metricSnapshot: snapshot,
  });

  // [QUAN TRỌNG] Không có dữ liệu KHÔNG PHẢI là "không có lỗi" (I7)
  if (!s.canaryRequests.hasData || !s.canaryErrors.hasData) {
    return hold("Nguồn metrics không trả dữ liệu cho nhánh canary");
  }

  // Không có request nào thì không có tỉ lệ nào (0/0 = NaN qua mọi so sánh) —
  // kể cả khi warm-up cấu hình là 0. Đây vẫn là "không biết", không phải "sạch".
  if (
    !(s.canaryRequests.value > 0) ||
    s.canaryRequests.value < ctx.warmUpRequests
  ) {
    return hold(
      `Mới ${String(Math.floor(Math.max(0, s.canaryRequests.value)))}/${String(ctx.warmUpRequests)} request`,
    );
  }

  const t = ctx.thresholds;
  const canaryRate = s.canaryErrors.value / s.canaryRequests.value;
  const reasons: string[] = [];

  // (a) Ngưỡng tuyệt đối — kèm số lỗi tối thiểu, vì ở 100 request độ phân giải là 1%
  if (canaryRate > t.errorRate && s.canaryErrors.value >= t.minErrors) {
    reasons.push(
      `errorRate ${canaryRate.toFixed(4)} > ${String(t.errorRate)} (${String(s.canaryErrors.value)} lỗi ≥ minErrors ${String(t.minErrors)})`,
    );
  }

  // (b) Ngưỡng tương đối so với baseline + kiểm định hai tỉ lệ — lọc nền lỗi sẵn có
  if (
    t.relativeErrorRate !== null &&
    snapshot.baseline.hasData &&
    snapshot.baseline.requestCount >= ctx.warmUpRequests &&
    snapshot.zScore !== null
  ) {
    const baseRate = snapshot.baseline.errorRate;
    if (
      canaryRate > t.relativeErrorRate * baseRate &&
      snapshot.zScore > ROLLOUT_ANALYSIS.zCritical
    ) {
      reasons.push(
        `errorRate ${canaryRate.toFixed(4)} > ${String(t.relativeErrorRate)} × baseline ${baseRate.toFixed(4)} (z = ${snapshot.zScore.toFixed(2)})`,
      );
    }
  }

  // (c) Latency — chỉ khi có dữ liệu
  if (s.canaryP99.hasData && s.canaryP99.value > t.latencyP99Ms) {
    reasons.push(
      `p99 ${s.canaryP99.value.toFixed(0)}ms > ${String(t.latencyP99Ms)}ms`,
    );
  }

  if (reasons.length === 0) {
    return {
      decision: "PROMOTE",
      reason: "Không vượt ngưỡng",
      at: ctx.now,
      breach: false,
      breachStreak: 0,
      breachAt: null,
      metricSnapshot: snapshot,
    };
  }

  /**
   * Không rollback ngay ở lần vượt đầu tiên: spike thoáng qua không nên huỷ cả
   * rollout. Chỉ đếm "liên tiếp" khi hai phép đo cách nhau ≥ một cửa sổ.
   */
  const { streak, breachAt } = streakOf(ctx);
  const why = reasons.join("; ");
  if (streak >= t.maxConsecutiveBreaches) {
    return {
      decision: "ROLLBACK",
      reason: `${why} — trong ${String(streak)} lần đo liên tiếp`,
      at: ctx.now,
      breach: true,
      breachStreak: streak,
      breachAt,
      metricSnapshot: snapshot,
    };
  }
  return {
    decision: "HOLD",
    reason: `Vượt ngưỡng lần ${String(streak)}/${String(t.maxConsecutiveBreaches)}, chờ xác nhận: ${why}`,
    at: ctx.now,
    breach: true,
    breachStreak: streak,
    breachAt,
    metricSnapshot: snapshot,
  };
}

/**
 * Breach hiện tại là lần thứ mấy liên tiếp, và mốc để lần sau nối tiếp.
 *
 * Nối từ `breachAt` (lần vượt được ĐẾM gần nhất), không từ `at` của quyết định
 * trước: nhịp đo ngắn hơn cửa sổ nên một lần đo chồng lấn với lần trước là
 * chuyện thường — nó KHÔNG cộng chuỗi (cùng dữ liệu đếm hai lần) nhưng cũng
 * KHÔNG xoá chuỗi (lỗi vẫn đang đó). Chuỗi chỉ xoá khi một lần đo sạch.
 */
function streakOf(ctx: AnalysisContext): { streak: number; breachAt: number } {
  const prev = ctx.previous;
  if (prev !== null && prev.decision === "HOLD" && prev.breach) {
    const anchor = prev.breachAt ?? prev.at;
    if (ctx.now - anchor >= ctx.metricWindowSeconds * 1000) {
      return { streak: prev.breachStreak + 1, breachAt: ctx.now };
    }
    return { streak: prev.breachStreak, breachAt: anchor };
  }
  return { streak: 1, breachAt: ctx.now };
}

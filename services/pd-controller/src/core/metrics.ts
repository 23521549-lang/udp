import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  register,
} from "prom-client";

/**
 * Bốn số đo mà §9 khai cho `/metrics` của Service 3 — "số session đang xử lý,
 * độ trễ vòng lặp, số lần lock thất bại, số quyết định theo loại" — cộng hai
 * bộ đếm thiết kế gọi đích danh: `udp_rollback_blocked_total` (§7.6, I30) và
 * vi phạm fencing (§7.1 `promote`, chỗ "không thể xảy ra nếu (1)(2) đúng").
 *
 * Khai ở top-level của module, một lần cho mỗi tiến trình: `prom-client` ném
 * "already registered" khi khai cùng tên hai lần. Prometheus đã scrape cổng
 * 3003 trong `docker/prometheus.yml`.
 */
collectDefaultMetrics({ prefix: "udp_pd_" });

export const metrics = {
  /** Gauge, không phải counter: câu hỏi của §9 là "đang", không phải "đã" */
  sessionsInFlight: new Gauge({
    name: "udp_pd_sessions_in_flight",
    help: "Số rollout session reconciler đang giữ lease",
  }),
  loopDuration: new Histogram({
    name: "udp_pd_loop_duration_seconds",
    help: "Thời gian một vòng quét (tick) của reconciler",
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  }),
  claimFailures: new Counter({
    name: "udp_pd_claim_failures_total",
    help: "Số lần claim không nhận được hàng — replica khác đang giữ lease (SKIP LOCKED)",
  }),
  decisions: new Counter({
    name: "udp_pd_decisions_total",
    help: "Số quyết định theo loại",
    labelNames: ["decision"] as const,
  }),
  sessionsProcessed: new Counter({
    name: "udp_pd_sessions_processed_total",
    help: "Số lượt reconcileOne kết thúc, theo kết cục",
    labelNames: ["outcome"] as const,
  }),
  rollbackBlocked: new Counter({
    name: "udp_rollback_blocked_total",
    help: "Rollback không áp được vì Service 2 không phản hồi quá rollbackRetrySeconds (§7.6, I30)",
  }),
  /**
   * [v4.3] Kill-switch (§7.6, I30(a)): `applied` = traffic đã về baseline dù S2
   * chết; `stale` = worker khác đã tiếp quản, transaction lùi; `failed` = không ghi
   * được, traffic giữ nguyên — đi cùng `udp_rollback_blocked_total`.
   */
  killSwitch: new Counter({
    name: "udp_pd_kill_switch_total",
    help: "Kết cục của kill-switch khi Service 2 không phản hồi (§7.6)",
    labelNames: ["outcome"] as const,
  }),
  /** [v4.3] Gỡ nhãn `ff` (§6.6): `changed` = đã gỡ, `skipped` = không có gì để gỡ, `failed` = S2 không nhận */
  untrack: new Counter({
    name: "udp_pd_untrack_total",
    help: "Kết cục của lời gọi gỡ nhãn ff sang Service 2",
    labelNames: ["outcome"] as const,
  }),
  fencingViolations: new Counter({
    name: "udp_pd_fencing_violation_total",
    help: "updateIfVersion trả 0 hàng SAU khi side effect đã áp — cluster/S2 và DB lệch (§7.1)",
  }),
};

export { register as metricsRegistry };

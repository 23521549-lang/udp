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
  fencingViolations: new Counter({
    name: "udp_pd_fencing_violation_total",
    help: "updateIfVersion trả 0 hàng SAU khi side effect đã áp — cluster/S2 và DB lệch (§7.1)",
  }),
};

export { register as metricsRegistry };

import { observeQueries } from "@udp/db";
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  register,
} from "prom-client";
import { onIncrement } from "../changefeed/metrics.js";
import type { StatsDropReason } from "../modules/stats/stats.aggregator.js";
import type { SseChunkKind } from "../sdk/sse.manager.js";
import { prisma } from "./db.js";

/**
 * `/metrics` của Service 2 [v4.8] — chỗ nối mà `changefeed/metrics.ts` đã chừa.
 *
 * Mỗi bộ đếm ở đây có định nghĩa trong thiết kế (§1.4, §14 E4), không có bộ đếm
 * "để đó" — một con số không ai định nghĩa là con số E4 không được báo cáo:
 *
 *   - `udp_flag_db_queries_total` — MỌI sự kiện truy vấn của client Prisma của S2
 *     (Prisma phát `COMMIT` nhưng KHÔNG phát `BEGIN` — xem `observeQueries`), gồm
 *     cả transaction ghi lẫn vòng poll của change feed. E4 lấy delta quanh một lần
 *     đổi TRỪ tốc độ nền đo lúc rỗi.
 *   - `udp_flag_sse_bytes_total{event}` — byte ghi xuống stream SDK, theo loại
 *     khối (`snapshot`, `flag_changed`, `heartbeat`, `retry`), đếm ở chỗ ghi DUY
 *     NHẤT của hub (`writeTo`) sau khi khối thật sự được ghi.
 *   - `udp_flag_sdk_config_bytes_total` — byte body `/sdk/config` trả 200 (304
 *     không có body).
 *   - Hai bộ đếm ADR-05 (`changefeed_*`) — tên đúng như §1.4, phản chiếu từ bộ
 *     đếm đồng bộ của change feed.
 *
 * Cùng cổng với API như S1/S3; ingress công khai không route `/metrics` (§9).
 */
collectDefaultMetrics({ prefix: "udp_flag_" });

/** Mọi loại khối hub ghi — kiểu khai ở hub (`sse.manager.ts`), đây chỉ liệt kê */
const SSE_CHUNK_KINDS = [
  "snapshot",
  "flag_changed",
  "heartbeat",
  "retry",
] as const satisfies readonly SseChunkKind[];

/** [v4.9] Mọi lý do bỏ số đếm — kiểu khai ở bộ gộp, đây chỉ liệt kê */
const STATS_DROP_REASONS = [
  "env-cap",
  "total-cap",
  "flush-failed",
  "saturated",
] as const satisfies readonly StatsDropReason[];

export const metrics = {
  dbQueries: new Counter({
    name: "udp_flag_db_queries_total",
    help: "Số sự kiện truy vấn của client Prisma của Service 2 (COMMIT có, BEGIN không phát)",
  }),
  sseBytes: new Counter({
    name: "udp_flag_sse_bytes_total",
    help: "Byte đã ghi xuống stream SDK theo loại khối",
    labelNames: ["event"] as const,
  }),
  sdkConfigBytes: new Counter({
    name: "udp_flag_sdk_config_bytes_total",
    help: "Byte body của /sdk/config trả 200",
  }),
  /**
   * [v4.9] Telemetry đánh giá flag (§6.8). Bốn con số trả lời bốn câu khác nhau,
   * và câu thứ hai là câu quan trọng nhất: đếm THIẾU làm flag bị xếp UNUSED rồi
   * archive lọt chốt 7 ngày, nên mọi lượt đếm bị bỏ phải nhìn thấy được, kèm lý
   * do (trần bộ nhớ theo env, trần tiến trình, ghi database hỏng, bão hoà).
   */
  statsReports: new Counter({
    name: "udp_flag_stats_reports_total",
    help: "Số báo cáo POST /sdk/stats đã nhận (202)",
  }),
  statsDropped: new Counter({
    name: "udp_flag_stats_dropped_total",
    help: "Số lượt đánh giá bị bỏ không ghi được, theo lý do",
    labelNames: ["reason"] as const,
  }),
  statsRowsFlushed: new Counter({
    name: "udp_flag_stats_rows_flushed_total",
    help: "Số hàng đã gộp và UPSERT vào flag_evaluation_stats",
  }),
  statsFlushSeconds: new Histogram({
    name: "udp_flag_stats_flush_seconds",
    help: "Thời gian một lượt đẩy số đếm xuống database",
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  }),
  hashMismatch: new Counter({
    name: "changefeed_hash_mismatch_total",
    help: "Số lần config_hash lệch sau khi áp delta (ADR-05 §1.4) — là bug",
  }),
  fallback: new Counter({
    name: "changefeed_fallback_total",
    help: "Số lần change feed rơi về nạp snapshot (ADR-05 §1.4)",
  }),
};

// Nhãn khởi tạo sẵn: series có mặt từ lần scrape đầu, delta của E4 không phải
// đoán "vắng = 0"
for (const kind of SSE_CHUNK_KINDS) metrics.sseBytes.inc({ event: kind }, 0);
for (const reason of STATS_DROP_REASONS)
  metrics.statsDropped.inc({ reason }, 0);

onIncrement((name) => {
  if (name === "changefeed_hash_mismatch_total") metrics.hashMismatch.inc();
  else metrics.fallback.inc();
});

observeQueries(prisma, () => {
  metrics.dbQueries.inc();
});

export { register as metricsRegistry };

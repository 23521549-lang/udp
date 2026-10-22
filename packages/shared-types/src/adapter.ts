/**
 * Kết quả của một thao tác qua adapter (§4.1) — hình dạng dùng chung cho Cloud
 * Adapter, Domain Adapter và `MetricsProvider.probe()`.
 *
 * Người dùng hôm nay: `probe()` của `@udp/metrics-provider` (§5.4). Cloud Adapter
 * và Domain Adapter sẽ dùng cùng kiểu này khi ra đời (§4.2, §5.2) — khai ở đây
 * để hai nơi không mỗi nơi một `status` khác chữ.
 *
 * Bốn trạng thái đúng chữ §4.1, KHÔNG có `PRECONDITION_FAILED`: kết quả của
 * executor trong Service 3 (§7.1 `applyTraffic`) là một kiểu riêng, vì "bên nhận
 * từ chối fencing token" không phải một kết cục của adapter cloud.
 */
export type AdapterOperationStatus =
  "SUCCESS" | "FAILED" | "IN_PROGRESS" | "NOT_FOUND";

export interface AdapterResult<T = unknown> {
  status: AdapterOperationStatus;
  message?: string;
  data?: T;
  /** Thời gian thực thi, cho case study (§14) */
  durationMs?: number;
}

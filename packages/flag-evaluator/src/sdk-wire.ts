import type { SnapshotEntry, SnapshotSegment } from "./snapshot.js";

/**
 * Hình dạng DÂY giữa Service 2 và SDK (§9, §6.3) — nguồn DUY NHẤT cho cả hai phía.
 *
 * Ở `flag-evaluator` chứ không ở `shared-types`: entry trên dây là `SnapshotEntry`
 * sống ở đây, và provider trong ứng dụng của khách (§6.8) vốn đã phụ thuộc package
 * này để đánh giá tại chỗ. `shared-types` không import ngược `flag-evaluator` được,
 * nên đặt ở đó là phải khai lại hình dạng — hai bản song song thì trôi khỏi nhau.
 */

/** Body của `GET /sdk/config`, và cũng là `data` của `event: snapshot` */
export interface SdkConfigResponse {
  /** = ETag, con trỏ đọc của change feed (ADR-05) */
  configVersion: number;
  /**
   * sha256 của snapshot chuẩn hoá — luật chuẩn hoá ở `normalizeSnapshot` và §9.
   * Chuỗi RỖNG nghĩa là environment chưa có mốc, không phải lệch.
   */
  configHash: string;
  /** Tên environment — KHÔNG nằm trong hash */
  environment: string;
  trackedFlags: string[];
  flags: SnapshotEntry[];
  segments: SnapshotSegment[];
}

/** Tên event trên `GET /sdk/stream` — `flag_changed` giữ đúng tên của §6.3 */
export const SDK_STREAM_EVENTS = {
  snapshot: "snapshot",
  flagChanged: "flag_changed",
} as const;

export type SdkStreamEventName =
  (typeof SDK_STREAM_EVENTS)[keyof typeof SDK_STREAM_EVENTS];

/** Một flag đổi — phần tử duy nhất của `changes[]` hôm nay */
export interface SdkStreamFlagChange {
  configVersion: number;
  kind: "flag";
  flag: SnapshotEntry;
}

/**
 * Một phần tử của `changes[]` — union có `kind` ngay từ ngày đầu.
 *
 * Hash phủ cả `segments` lẫn `trackedFlags`, nên ngày hai thứ đó đổi qua stream,
 * phần tử của chúng thêm vào union này mà không phá hình dạng đã phát hành. Provider
 * gặp `kind` lạ thì RESYNC (§6.8), không đoán.
 */
export type SdkStreamChange = SdkStreamFlagChange;

/** `data` của `event: flag_changed` (§6.3) */
export interface SdkStreamDelta {
  /** Stream PHẢI đang ở version này — nếu không, server đã gửi snapshot thay thế */
  fromVersion: number;
  /** = `id` của event */
  toVersion: number;
  /** Hash TẠI `toVersion` — áp xong `changes` phải khớp (I15c) */
  configHash: string;
  /** Được phép rỗng: version tiến mà SDK không thấy gì đổi */
  changes: SdkStreamChange[];
}

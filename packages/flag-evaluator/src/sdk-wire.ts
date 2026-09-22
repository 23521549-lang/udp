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

/** Một flag đổi — thay entry cùng `key` */
export interface SdkStreamFlagChange {
  configVersion: number;
  kind: "flag";
  flag: SnapshotEntry;
}

/**
 * [v4.3] Tập flag đang gắn nhãn đổi (§6.6) — thay CẢ tập. Đã sắp theo phép so
 * chuỗi thường (`<`), đúng thứ tự `configHashOf` dùng.
 */
export interface SdkStreamTrackedFlagsChange {
  configVersion: number;
  kind: "trackedFlags";
  trackedFlags: string[];
}

/**
 * [v4.6] Flag KHÔNG có trong snapshot — flag DRAFT (§6.7: SDK chưa nhận). Mọi
 * lần ghi lên flag DRAFT vẫn tăng version; phần tử này nói điều đúng về nó. Áp =
 * xoá entry cùng `key` nếu có (idempotent).
 */
export interface SdkStreamFlagAbsentChange {
  configVersion: number;
  kind: "flagAbsent";
  key: string;
}

/**
 * Một phần tử của `changes[]` — union có `kind` ngay từ ngày đầu.
 *
 * Hash phủ cả `segments` lẫn `trackedFlags`, nên ngày hai thứ đó đổi qua stream,
 * phần tử của chúng thêm vào union này mà không phá hình dạng đã phát hành. Provider
 * gặp `kind` lạ thì RESYNC (§6.8), không đoán.
 */
export type SdkStreamChange =
  SdkStreamFlagChange | SdkStreamFlagAbsentChange | SdkStreamTrackedFlagsChange;

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

/**
 * ETag của `/sdk/config` [v4.7: chuyển từ Service 2 — provider tổng hợp đúng giá
 * trị này sau khi áp delta để polling revalidate được (304)].
 *
 * §9 khai `configVersion: number; // = ETag`, và §6.3 ràng thêm một đẳng thức
 * nữa: "`ETag` của lần GET đầu chính là `since` của SSE". Hai câu đó cộng lại
 * chốt giá trị: ETag là `config_version`, KHÔNG kèm gì khác. Ghép `keyType` vào
 * — như một chú thích ở §3.2 từng gợi ý — làm `since` không parse ra số được, và
 * khe hở mà §6.3 dựng đẳng thức đó để bịt sẽ mở lại: sự kiện xảy ra giữa lúc GET
 * xong và lúc SSE nối được.
 *
 * `(envId, keyType)` vẫn là khóa của CACHE, chỉ không phải giá trị trên dây. Hai
 * thứ khác nhau: một cái định danh chỗ để, một cái là bộ xác thực HTTP.
 */

/**
 * NGOẶC KÉP là bắt buộc, không phải trang trí.
 *
 * `ETag: 47` không phải một entity-tag hợp lệ. Đã đo trên `http.request` thô:
 * server đặt ETag không ngoặc, client gửi lại `If-None-Match: "47"` — vì mọi
 * client đúng chuẩn đều tự thêm ngoặc — và server trả **200 kèm nguyên body**,
 * mọi lần. Triệu chứng không phải lỗi mà là im lặng: 304 không bao giờ xảy ra,
 * nên chế độ polling fallback 30 giây của SDK (§6.3) tải full snapshot vĩnh
 * viễn, và không có gì trong log nói rằng có gì đó sai.
 *
 * Tag MẠNH (không có tiền tố `W/`): body là byte-for-byte xác định bởi
 * `config_version`, nên không cần ngữ nghĩa "tương đương yếu". Express so
 * `If-None-Match` theo kiểu yếu ở cả hai chiều nên `W/"47"` từ client vẫn khớp.
 */
export const etagOf = (configVersion: number): string =>
  `"${String(configVersion)}"`;

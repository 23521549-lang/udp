import type { SdkConfigResponse } from "@udp/flag-evaluator";
import type { ConfigEntry } from "../changefeed/index.js";

/**
 * Body DUY NHẤT của `GET /sdk/config` và của `event: snapshot` trên `/sdk/stream`.
 *
 * Hai endpoint dựng hai body riêng thì một ngày chúng lệch nhau một trường, và SDK
 * tính hash trên body của stream sẽ ra con số khác body của config — RESYNC vô tận
 * mà không đường nào báo lỗi. §6.3 nói `data` của snapshot "đúng bằng body của
 * `GET /sdk/config`"; hàm này giữ câu đó bằng cấu trúc thay vì bằng kỷ luật.
 */
export function sdkConfigBody(entry: ConfigEntry): SdkConfigResponse {
  return {
    configVersion: entry.configVersion,
    configHash: entry.configHash,
    environment: entry.environmentName,
    trackedFlags: entry.snapshot.trackedFlags,
    flags: entry.snapshot.flags,
    segments: entry.snapshot.segments,
  };
}

/** Byte của body trên, tuần tự hoá MỘT lần cho mỗi `ConfigEntry` */
const bodies = new WeakMap<ConfigEntry, Buffer>();

/**
 * [v4.9] Cùng body, nhưng đã thành byte — và chỉ một lần cho mỗi bộ ba.
 *
 * `ConfigEntry` là bất biến (bộ ba sinh ra CÙNG NHAU, đổi là đổi cả mục cache),
 * nên byte của nó cũng bất biến: nhớ trong `WeakMap` theo đúng khuôn
 * `snapshotChunks` của hub SSE, và mục cache bị thay thì byte tự được thu hồi.
 *
 * Vì sao đáng làm: phần segment của snapshot có trần 4 MiB (V21), mà `res.json`
 * tuần tự hoá lại TOÀN BỘ ở mỗi request `/sdk/config` — kể cả ở request kết thúc
 * bằng 304. Nhiều tiến trình SDK cùng revalidate sau một lần ghi là hàng trăm MB
 * rác sinh ra cho một nội dung không đổi.
 */
export function sdkConfigBuffer(entry: ConfigEntry): Buffer {
  let body = bodies.get(entry);
  if (body === undefined) {
    body = Buffer.from(JSON.stringify(sdkConfigBody(entry)), "utf8");
    bodies.set(entry, body);
  }
  return body;
}

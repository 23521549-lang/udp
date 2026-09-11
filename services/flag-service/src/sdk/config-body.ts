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

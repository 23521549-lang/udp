import { DELIVERY_ANNOTATIONS } from "./delivery.types.js";
import { patchToward } from "./merge.js";

/**
 * Deploy thường (Luồng 3) lên một `Rollout` mà session UDP gần nhất đã KẾT THÚC (Plan #51 QĐ-10): trả strategy về
 * bản gốc trước session. Không có bước này, `pause: {}` của một session udp-driven làm lần deploy kế dừng vĩnh viễn
 * (không còn Service 3 nào promote), và `analysis` của một session tool-driven đo phiên bản CŨ (PromQL của
 * AnalysisTemplate mang `service_version` của session đó).
 *
 * `null` khi không có gì để trả: `Rollout` chưa từng qua session UDP, hay không lưu bản gốc. Chú thích của session
 * bị xoá; bản gốc giữ lại cho session sau.
 */
export function restoreAfterSession(state: {
  metadata?: { annotations?: Record<string, string> };
  spec?: { strategy?: Record<string, unknown> };
}): Record<string, unknown> | null {
  const annotations = state.metadata?.annotations ?? {};
  const saved = annotations[DELIVERY_ANNOTATIONS.previousStrategy];
  if (
    annotations[DELIVERY_ANNOTATIONS.session] === undefined ||
    saved === undefined
  ) {
    return null;
  }
  return {
    metadata: {
      annotations: {
        [DELIVERY_ANNOTATIONS.session]: null,
        [DELIVERY_ANNOTATIONS.mode]: null,
        [DELIVERY_ANNOTATIONS.strategy]: null,
      },
    },
    spec: {
      strategy: patchToward(
        state.spec?.strategy ?? {},
        JSON.parse(saved) as Record<string, unknown>,
      ),
    },
  };
}

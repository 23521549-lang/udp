import { prepareSnapshot, type PreparedSnapshot } from "@udp/flag-evaluator";
import type { ConfigEntry } from "../changefeed/index.js";

/**
 * Snapshot ĐÃ DỰNG cho đánh giá, một lần mỗi `ConfigEntry` [v4.6].
 *
 * Nhớ theo ĐỐI TƯỢNG entry (WeakMap), không theo `configVersion`: cache thay cả
 * entry mỗi khi version đổi (entry là bất biến), nên entry mới ⇒ dựng mới, và
 * entry cũ rời bộ nhớ cùng bản dựng của nó — không có gì phải dọn.
 */
const prepared = new WeakMap<ConfigEntry, PreparedSnapshot>();

export function preparedOf(entry: ConfigEntry): PreparedSnapshot {
  let hit = prepared.get(entry);
  if (hit === undefined) {
    hit = prepareSnapshot(entry.snapshot);
    prepared.set(entry, hit);
  }
  return hit;
}

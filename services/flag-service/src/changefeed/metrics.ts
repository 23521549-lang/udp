/**
 * Hai bộ đếm mà ADR-05 gọi đích danh: `changefeed_hash_mismatch_total` khi hash
 * lệch sau khi áp delta, và `changefeed_fallback_total` khi rơi về snapshot (§1.4).
 *
 * [v4.8] Service 2 đã có `/metrics` (`core/metrics.ts`): hai số này được PHẢN
 * CHIẾU sang Prometheus qua `onIncrement`, còn bản đồng bộ ở đây giữ nguyên cho
 * test (đọc ngay, không `await` như `Counter.get()` của prom-client). Hướng phụ
 * thuộc là `core → changefeed`: change feed không biết có ai scrape. Các bộ đếm
 * KHÁC của S2 (truy vấn, byte — phép đo E4) sống ở `core/metrics.ts` và mỗi cái có
 * định nghĩa ở §14 — không bộ đếm nào "để đó".
 *
 * Một lưu ý về ngữ nghĩa: §1.4 viết `changefeed_fallback_total` ở dòng "rơi về
 * snapshot 3 lần liên tiếp ⇒ ngắt mạch", đọc sát chữ thì nó chỉ tăng LÚC ngắt
 * mạch. Ở đây nó tăng ở MỌI lần rơi tầng, đúng như cái tên nói. Số lần ngắt mạch
 * vẫn suy ra được từ chuỗi tăng, còn chiều ngược lại thì không: một bộ đếm chỉ
 * tăng mỗi 3 lần không cho biết đã có bao nhiêu lần rơi.
 */

const counters = {
  changefeed_hash_mismatch_total: 0,
  changefeed_fallback_total: 0,
};

export type ChangefeedCounter = keyof typeof counters;

const listeners = new Set<(name: ChangefeedCounter) => void>();

export function incrementCounter(name: ChangefeedCounter): void {
  counters[name] += 1;
  for (const listener of listeners) listener(name);
}

/** Nghe mỗi lần tăng — `core/metrics.ts` phản chiếu sang Prometheus */
export function onIncrement(
  listener: (name: ChangefeedCounter) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readCounters(): Readonly<Record<ChangefeedCounter, number>> {
  return { ...counters };
}

/** Chỉ dùng trong test — bộ đếm là trạng thái toàn cục của tiến trình */
export function resetCounters(): void {
  counters.changefeed_hash_mismatch_total = 0;
  counters.changefeed_fallback_total = 0;
}

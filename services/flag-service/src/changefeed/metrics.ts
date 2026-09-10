/**
 * Hai bộ đếm mà ADR-05 gọi đích danh, và KHÔNG cái nào khác.
 *
 * §1.4 nêu đúng hai: `changefeed_hash_mismatch_total` khi hash lệch sau khi áp
 * delta, và `changefeed_fallback_total` khi rơi về snapshot. Thêm bộ đếm thứ ba
 * ở đây là tự đặt ra một hợp đồng quan sát mà tài liệu không có, và phép đo E4
 * sẽ báo cáo một con số không ai định nghĩa.
 *
 * **Chưa nối vào Prometheus, và đó là hoãn có chủ đích chứ không phải bỏ sót.**
 * Service 2 hiện chưa có endpoint `/metrics` cũng chưa có `prom-client` — thêm
 * một phụ thuộc cho hai con số mà chưa có ai scrape là dựng nửa cây cầu. Hôm nay
 * người tiêu thụ chúng là test: chúng là cách duy nhất khẳng định "ngắt mạch đã
 * bật" và "hash đã lệch" mà không phải soi vào nội tạng của watcher. Ngày Service
 * 2 có `/metrics`, chỗ nối là đúng file này.
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

export function incrementCounter(name: ChangefeedCounter): void {
  counters[name] += 1;
}

export function readCounters(): Readonly<Record<ChangefeedCounter, number>> {
  return { ...counters };
}

/** Chỉ dùng trong test — bộ đếm là trạng thái toàn cục của tiến trình */
export function resetCounters(): void {
  counters.changefeed_hash_mismatch_total = 0;
  counters.changefeed_fallback_total = 0;
}

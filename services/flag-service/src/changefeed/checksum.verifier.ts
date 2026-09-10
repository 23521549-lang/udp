import { configHashOf, type Snapshot } from "@udp/flag-evaluator";
import { incrementCounter } from "./metrics.js";

/**
 * Đối chiếu nội dung: `sha256(snapshot chuẩn hoá)` với `Environment.config_hash`.
 *
 * Vì sao cần, khi đã có `config_version`: version là SỐ ĐẾM, không phải checksum.
 * Một replica áp delta **sai nội dung nhưng đúng số** vẫn qua được mọi phép kiểm
 * của tầng 1. Chỉ checksum nội dung bắt được — đó là toàn bộ lý do I15a tồn tại,
 * và là lý do §1.4 tách `config_hash` khỏi `config_version`.
 */

export type VerifyResult =
  /** Nội dung khớp con số Service 2 đã ghi */
  | "ok"
  /** Lệch — đây là BUG, không phải chuyện thường ngày */
  | "mismatch"
  /** Chưa có gì để so */
  | "no-baseline";

/**
 * `expected` rỗng nghĩa là CHƯA CÓ MỐC, không phải "hash bằng chuỗi rỗng".
 *
 * `Environment.config_hash` khai `@default("")`, nên mọi environment chưa từng
 * bị ghi mang giá trị đó — đo trên database thật: 6/6 environment hiện có. So
 * `sha256(...)` với `""` là lệch 100%, và hệ quả dây chuyền đã đủ để giết tầng 2
 * mà không có một bug thật nào: ba lần lệch liên tiếp ⇒ ngắt mạch 5 phút ⇒ hết 5
 * phút lệch tiếp ⇒ lặp mãi, `changefeed_hash_mismatch_total` tăng không ngừng và
 * chỉ vào một nguyên nhân không tồn tại.
 *
 * Bỏ qua phép so ở đây KHÔNG mất an toàn: environment chưa từng được ghi thì
 * cũng chưa có delta nào để áp sai. Mốc xuất hiện ngay ở lần ghi đầu tiên.
 *
 * Ghi chú cho ai định đổi kiểu cột: `VarChar(64)` là có chủ đích. Với `Char(64)`,
 * Postgres đệm giá trị bằng dấu cách, nên `""` đọc về JavaScript thành 64 dấu
 * cách và phép kiểm `expected === ""` ở đây lặng lẽ thành `false`.
 */
export function verifyHash(snapshot: Snapshot, expected: string): VerifyResult {
  if (expected === "") return "no-baseline";

  if (configHashOf(snapshot) === expected) return "ok";

  incrementCounter("changefeed_hash_mismatch_total");
  return "mismatch";
}

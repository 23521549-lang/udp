import murmur from "murmurhash3js";
import { TOTAL_BUCKETS } from "@udp/config/constants";

/**
 * Chia nhóm người dùng bằng consistent hashing (§6.4).
 *
 * Package này chạy trong ỨNG DỤNG CỦA KHÁCH, không chỉ trong Service 2. Đó là
 * điều kiện của bất biến I26: local evaluation và OFREP phải cho cùng một
 * `ResolutionDetails`, và cách duy nhất bảo đảm điều đó bằng cấu trúc là hai bên
 * gọi CÙNG một hàm. Vì vậy ở đây chỉ import subpath `@udp/config/constants` —
 * entry chính của `@udp/config` chạy validate toàn bộ biến môi trường lúc nạp
 * module, và một SDK không có lý do gì phải có `.env` của UDP.
 */

export interface BucketInput {
  /** Giá trị của thuộc tính stickiness — mặc định `targetingKey` */
  stickyValue: string | undefined;
  flagKey: string;
  /** Salt cố định sinh khi tạo rule; đổi salt là xáo lại toàn bộ nhóm người dùng */
  bucketSalt: string;
}

/**
 * Chuẩn hoá NFC rồi mã hoá UTF-8, đọc lại bằng `latin1` để mỗi code unit đúng
 * bằng một byte.
 *
 * Không có bước này thì hàm băm SAI, và sai im lặng. `murmurhash3js` đọc khoá
 * bằng `charCodeAt(i) & 0xff`, tức cắt mỗi ký tự còn byte thấp của UTF-16. Đã đo
 * trên chính thư viện:
 *
 *   hash("Nguyễn") === hash("NguyÅn")          — va chạm
 *   95/95 cặp ký tự `C` và `C + 0x100`          — va chạm
 *   NFC "Nguyễn" → 2229514937, NFD → 2660978039 — khác nhau
 *
 * Ba hậu quả, không cái nào lộ ra trong test tiếng Anh: hai tenant tên khác nhau
 * rơi đúng cùng bucket nên canary 10% bốc trúng hoặc trượt cả cụm; cùng một
 * người dùng trên iOS (gửi NFD) và Android (gửi NFC) nhận HAI variant khác nhau,
 * tức I2 vỡ; và SDK ngôn ngữ khác dùng murmur3 chuẩn trên byte UTF-8 ra bucket
 * khác cho mọi chuỗi có dấu, tức I26 vỡ.
 *
 * Đã đo sau khi vá: với ASCII kết quả KHÔNG đổi (2000/2000 giống hệt) nên tương
 * thích ngược và khớp murmur3 chuẩn; tiếng Việt hết va chạm; NFD bằng NFC; phân
 * bố vẫn đều (9,91% rơi vào 10% bucket đầu trên 20 000 tên tiếng Việt).
 */
const utf8Bytes = (value: string): string =>
  Buffer.from(value.normalize("NFC"), "utf8").toString("latin1");

/**
 * Bucket trong `[0, TOTAL_BUCKETS)`.
 *
 * `x86.hash32` trả số không dấu (`h1 >>> 0` ở dòng cuối của thư viện — đã đo
 * trên 500 000 mẫu: không giá trị nào âm), nên `%` không bao giờ cho kết quả âm.
 * Đừng thêm `Math.abs`: nó không sửa gì và sẽ che mất một lỗi thật nếu thư viện
 * đổi hành vi.
 */
export function bucketOf({
  stickyValue,
  flagKey,
  bucketSalt,
}: BucketInput): number {
  return (
    murmur.x86.hash32(utf8Bytes(`${bucketSalt}:${flagKey}:${stickyValue}`)) %
    TOTAL_BUCKETS
  );
}

/**
 * `@udp/design-lint` — làm cho tài liệu thiết kế không trôi khỏi hệ thống được.
 *
 * Không có API chạy lúc runtime; toàn bộ giá trị nằm ở bộ test. Package tồn tại
 * để có một ranh giới rõ: đọc `docs/UDP_design.md` và database, khẳng định hai
 * bên nói cùng một điều. Không service nào import nó.
 */
export * from "./design-doc.js";
export * from "./db-schema.js";

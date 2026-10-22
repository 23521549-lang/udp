/**
 * [Plan #56 QĐ-2] Nội dung NGUYÊN VĂN của mọi tệp kết quả đo trong repo (`docs/measurements/raw/*.json`), nạp lúc
 * build. Module này chỉ được nạp bằng `import()` động (`measurements.ts`) — Vite tách nó thành một chunk riêng, nên
 * chỉ người mở trang Bằng chứng mới tải nó.
 *
 * Giữ chuỗi chứ không giữ object đã parse: nút "Tải tệp thô" trả đúng từng byte của tệp đã commit.
 */
export const MEASUREMENT_FILES: Record<string, string> = import.meta.glob(
  "../../../../../../docs/measurements/raw/*.json",
  { eager: true, query: "?raw", import: "default" },
);

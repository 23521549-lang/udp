/**
 * [Plan #56] Tải một tệp dựng ngay trong trình duyệt (tệp thô JSON, bảng CSV của biểu đồ) — không qua máy chủ.
 */
export function downloadText(
  fileName: string,
  mime: string,
  text: string,
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  // Trình duyệt đã bắt đầu tải khi `click` trả về; thu hồi ở lượt sau để Safari kịp đọc blob
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const cell = (v: string | number | null): string => {
  if (v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/**
 * CSV theo RFC 4180: dấu phẩy, dấu chấm thập phân (số thô, không định dạng theo ngôn ngữ — để vẽ lại được trong
 * mọi công cụ), ô rỗng cho "không có dữ liệu".
 */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

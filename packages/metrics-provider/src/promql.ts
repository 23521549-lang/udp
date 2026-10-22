/**
 * Ghép giá trị vào chuỗi PromQL một cách an toàn.
 *
 * Giá trị nhãn đến từ dữ liệu người dùng (`workload_name`, tên flag, tên
 * variant). PromQL bọc giá trị nhãn trong dấu ngoặc kép và hiểu `\"`, `\\`,
 * `\n`: không escape là một tên flag chứa `"` biến truy vấn thành truy vấn khác —
 * cùng lớp lỗi với SQL injection, chỉ khác ngôn ngữ.
 */
export function quoteLabelValue(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

/**
 * Giá trị nhãn cho toán tử `=~` — regex. Escape mọi ký tự đặc biệt của regex
 * RE2 trước, rồi mới bọc chuỗi, vì `probe()` FLAG_LEVEL cần `ff=~"<key>=.*"`.
 */
export function quoteRegexPrefix(literalPrefix: string): string {
  const escaped = literalPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return quoteLabelValue(`${escaped}.*`);
}

/** Cửa sổ `[60s]` — chỉ nhận số nguyên dương giây */
export function windowOf(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      `Cửa sổ metric phải là số giây nguyên dương, nhận ${String(seconds)}`,
    );
  }
  return `[${String(seconds)}s]`;
}

/**
 * Đọc MỘT giá trị bộ đếm từ exposition `/metrics` (định dạng văn bản của
 * Prometheus) — dùng cho `/metrics` của Service 2 trong E4. Vắng dòng là LỖI, không
 * phải 0: một bộ đếm đổi tên hay chưa khởi tạo mà đọc thành 0 là E4 báo "0 truy vấn
 * mỗi lần" mà không ai biết.
 */
export function counterValue(
  exposition: string,
  name: string,
  labels = "",
): number {
  const prefix = `${name}${labels} `;
  const line = exposition.split("\n").find((l) => l.startsWith(prefix));
  if (line === undefined) throw new Error(`/metrics thiếu ${name}${labels}`);
  const value = Number(line.slice(prefix.length).split(" ")[0]);
  if (!Number.isFinite(value)) throw new Error(`giá trị sai ở dòng: ${line}`);
  return value;
}

/** Tải `/metrics` của một dịch vụ */
export async function scrape(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/metrics`);
  if (!res.ok) throw new Error(`${baseUrl}/metrics → ${String(res.status)}`);
  return res.text();
}

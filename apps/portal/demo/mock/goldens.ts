/**
 * Mẫu response THẬT của Service 1 (golden capture, `services/core-backend/tests/fixtures/wire/`) — cùng nguồn mà
 * test của Portal dựng mock. Bản xem thử lấy HÌNH DẠNG từ đây rồi thay dữ liệu, để một response giả không lệch
 * hợp đồng mà Portal kiểm.
 */
interface Golden {
  route: string;
  status: number;
  body: unknown;
}

const files = import.meta.glob<Golden>(
  "../../../../services/core-backend/tests/fixtures/wire/*.json",
  { eager: true, import: "default" },
);

const byRoute = new Map(Object.values(files).map((g) => [g.route, g]));

/** Bản sao sâu của body mẫu theo route — sửa thoải mái mà không làm bẩn mẫu */
export function golden<T>(route: string): T {
  const found = byRoute.get(route);
  if (found === undefined) throw new Error(`không có mẫu golden cho ${route}`);
  return structuredClone(found.body) as T;
}

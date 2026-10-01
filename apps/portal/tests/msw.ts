import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

/**
 * Mẫu response THẬT của Service 1 (golden capture, `services/core-backend/tests/
 * fixtures/wire/`). Mock của Portal dựng từ đây chứ không viết tay: một mock viết tay lệch
 * hình response là test xanh mà app vỡ — đúng rủi ro mà golden capture tồn tại để chặn.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = join(
  here,
  "..",
  "..",
  "..",
  "services",
  "core-backend",
  "tests",
  "fixtures",
  "wire",
);

export interface Golden {
  route: string;
  status: number;
  body: unknown;
}

export function goldens(): Golden[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".json"))
    .map(
      (f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), "utf8")) as Golden,
    );
}

/** Bản sao sâu của body mẫu theo route — test sửa thoải mái mà không làm bẩn mẫu */
export function golden<T = unknown>(route: string): T {
  const g = goldens().find((x) => x.route === route);
  if (g === undefined) throw new Error(`không có mẫu golden cho ${route}`);
  return structuredClone(g.body) as T;
}

export const API = "http://localhost:3000/api/v1";

/**
 * Handler MẶC ĐỊNH (còn lại sau mỗi `resetHandlers`): [Plan #60] cách đăng nhập đang bật là cấu hình công khai của cả
 * triển khai mà trang đăng nhập và đăng ký hỏi mỗi lần mở — mẫu golden là triển khai CHƯA bật Quên mật khẩu hay
 * GitHub. Test cần bật thì `server.use` đè lên.
 */
export const server = setupServer(
  http.get(`${API}/auth/options`, () =>
    HttpResponse.json(golden("GET /auth/options")),
  ),
  // [Plan #61] Trang Mã nguồn luôn mở mục Đóng gói — mẫu golden; test của mục đó đè bằng ô riêng
  http.get(`${API}/projects/:id/build`, () =>
    HttpResponse.json(golden("GET /projects/{id}/build")),
  ),
);

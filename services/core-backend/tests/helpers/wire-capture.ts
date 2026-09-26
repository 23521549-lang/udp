import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

/**
 * [v4.11] Golden capture — ghi response THẬT của Service 1 làm mẫu cho Portal.
 *
 * Vì sao cần: schema `*Wire` được viết từ cùng một niềm tin mà nó đi kiểm. Nếu mock của
 * Portal cũng viết tay theo niềm tin đó thì cả ba (schema, mock, test) cùng sai một
 * kiểu và cùng xanh. Mẫu ghi từ bộ test tích hợp thật là thứ duy nhất không đi ra từ
 * niềm tin ấy.
 *
 * **Chỉ chạy khi `UDP_CAPTURE_WIRE=1`.** Không chạm mã production: nó bọc
 * `express.response.json` trong tiến trình test, nên mọi route in-process của bộ test
 * tích hợp đều được ghi mà không route nào phải biết.
 *
 * Mỗi mẫu đường dẫn giữ MỘT response 2xx — cái giàu nhất (JSON dài nhất) dưới trần
 * `MAX_BYTES`, để danh sách rỗng của test đầu tiên không thắng danh sách có dữ liệu.
 * Vitest chạy mỗi tệp test trong một worker riêng, nên "giàu nhất" so với tệp trên đĩa
 * chứ không với biến trong bộ nhớ.
 *
 * Hai thứ bị thay trước khi ghi: `secretKey` (plaintext SDK key, đúng thứ quét bí mật
 * chặn) và `csrfToken`. Cả hai được thay bằng giá trị giả CÙNG DẠNG, để schema vẫn kiểm
 * được hình.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const WIRE_FIXTURE_DIR = join(here, "..", "fixtures", "wire");
/**
 * Trần kích cỡ một mẫu. 96 KB chứ không 24 KB (Plan #31): catalog domain với đủ 66 tool của
 * §5.5 là ~70 KB, và một response vượt trần thì KHÔNG được ghi — golden đóng băng ở bản cũ mà
 * không ai hay, đúng thứ golden capture tồn tại để chống.
 */
const MAX_BYTES = 96_000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** `GET /api/v1/projects/<uuid>/flags` → `GET /projects/{id}/flags` */
export function routeKeyOf(method: string, originalUrl: string): string {
  const path = (originalUrl.split("?")[0] ?? "")
    .replace(/^\/api\/v1/, "")
    .replace(UUID, "{id}");
  return `${method} ${path}`;
}

/** Tên tệp an toàn trên Windows: không `/`, không `{}` */
export const fixtureFileOf = (key: string): string =>
  `${key.replace(/[{}]/g, "").replace(/[ /]+/g, "_")}.json`;

const FAKE: Record<string, string> = {
  secretKey: "udp_sk_dev_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
  csrfToken: "fake-csrf-token-for-golden-capture",
  /** Secret webhook CI/CD (Plan #36) — mẫu giữ HÌNH hex 64 ký tự, không giữ giá trị */
  secret: "0123456789abcdef".repeat(4),
};

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        typeof v === "string" && FAKE[k] !== undefined ? FAKE[k] : redact(v),
      ]),
    );
  }
  return value;
}

if (process.env.UDP_CAPTURE_WIRE === "1") {
  mkdirSync(WIRE_FIXTURE_DIR, { recursive: true });
  const original = express.response.json;

  express.response.json = function capture(this: express.Response, body) {
    const req = this.req;
    if (
      this.statusCode >= 200 &&
      this.statusCode < 300 &&
      req.originalUrl.startsWith("/api/v1/")
    ) {
      const key = routeKeyOf(req.method, req.originalUrl);
      const file = join(WIRE_FIXTURE_DIR, fixtureFileOf(key));
      const text = JSON.stringify(
        { route: key, status: this.statusCode, body: redact(body) },
        null,
        2,
      );
      let current = 0;
      try {
        current = readFileSync(file, "utf8").length;
      } catch {
        current = 0;
      }
      if (text.length <= MAX_BYTES && text.length > current) {
        writeFileSync(file, `${text}\n`);
      }
    }
    return original.call(this, body);
  };
}

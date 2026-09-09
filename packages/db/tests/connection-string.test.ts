import { describe, expect, it } from "vitest";
import { DB_TLS_OPTIONS, sanitizeConnectionString } from "../src/adapter.js";

/**
 * TLS không được phép tắt bằng một tham số URL.
 *
 * `pg` làm `Object.assign({}, config, parse(connectionString))`, nên chuỗi kết
 * nối THẮNG object `ssl` ta truyền vào. Đã đo trên `pg-connection-string@2.14.0`:
 * `?ssl=true` cho `ssl = true`, `?sslrootcert=<f>` cho `ssl = { ca: <f> }` — cả
 * hai đều mất `rejectUnauthorized`, tức CA ghim bị vứt và MITM đi qua được.
 *
 * Bản đầu của `sanitizeConnectionString` chỉ gỡ `sslmode` vì tôi tưởng đó là
 * đường duy nhất. Test này tồn tại để cái tưởng đó không quay lại.
 */

const BASE = "postgresql://user:pass@host:5432/db";

describe("sanitizeConnectionString", () => {
  it("gỡ sslmode im lặng — DATABASE_URL_DIRECT cố ý mang nó cho Prisma CLI", () => {
    const out = sanitizeConnectionString(`${BASE}?sslmode=require`);
    expect(new URL(out).searchParams.has("sslmode")).toBe(false);
  });

  it("giữ nguyên các tham số không liên quan tới TLS", () => {
    const out = sanitizeConnectionString(
      `${BASE}?application_name=udp&sslmode=require&pgbouncer=true`,
    );
    const params = new URL(out).searchParams;
    expect(params.get("application_name")).toBe("udp");
    expect(params.get("pgbouncer")).toBe("true");
  });

  it("gỡ được sslmode ở mọi vị trí", () => {
    for (const url of [
      `${BASE}?sslmode=require`,
      `${BASE}?sslmode=require&a=1`,
      `${BASE}?a=1&sslmode=require`,
      `${BASE}?a=1&sslmode=require&b=2`,
    ]) {
      expect(
        new URL(sanitizeConnectionString(url)).searchParams.has("sslmode"),
      ).toBe(false);
    }
  });

  // NÉM chứ không gỡ im lặng: gỡ im lặng để người viết cấu hình tin rằng thiết
  // lập TLS của họ có hiệu lực, trong khi nó vừa bị bỏ qua.
  for (const param of [
    "ssl",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "sslnegotiation",
  ]) {
    it(`NÉM khi chuỗi kết nối mang ${param}`, () => {
      expect(() => sanitizeConnectionString(`${BASE}?${param}=x`)).toThrow(
        /TLS/,
      );
    });
  }

  it("nêu TÊN tham số vi phạm trong thông báo", () => {
    // Người đọc lỗi phải biết gỡ cái gì khỏi .env, không phải đi dò.
    expect(() =>
      sanitizeConnectionString(`${BASE}?ssl=true&sslrootcert=/x`),
    ).toThrow(/ssl, sslrootcert/);
  });

  it("DB_TLS_OPTIONS luôn bật xác thực chứng chỉ và có CA ghim", () => {
    expect(DB_TLS_OPTIONS.rejectUnauthorized).toBe(true);
    expect(DB_TLS_OPTIONS.ca.length).toBeGreaterThan(0);
    expect(String(DB_TLS_OPTIONS.ca)).toContain("BEGIN CERTIFICATE");
  });
});

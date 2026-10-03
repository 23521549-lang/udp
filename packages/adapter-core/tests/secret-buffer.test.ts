import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_DISPOSED,
  SECRET_TO_STRING_FORBIDDEN,
  SecretBuffer,
} from "../src/credential.js";

/**
 * [v4.10] `SecretBuffer` — bốn đường rò và hai tính chất của `dispose()` (§4.1, I12, I24).
 *
 * Bộ này dùng một **giá trị canh** (sentinel) sinh mới mỗi lần chạy thay vì một chuỗi
 * cố định: một chuỗi cố định có thể trùng với chữ trong chính thông điệp lỗi, và khi đó
 * một phép quét sẽ đỏ vì lý do sai.
 *
 * Bốn đường dưới đây đã được đo trước khi viết mã (R24-8), nên các phép kiểm này chốt
 * lại hành vi ĐÃ ĐO chứ không phát biểu một giả định.
 */

const sentinel = (): string =>
  `SENT-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;

describe("SecretBuffer — bịt đường biến secret thành chuỗi", () => {
  it("toString() NÉM thay vì trả chuỗi đã che", () => {
    const s = new SecretBuffer(sentinel());
    expect(() => s.toString()).toThrow(SECRET_TO_STRING_FORBIDDEN);
  });

  /**
   * Ba đường này đều đi qua `toString()`, nhưng viết riêng từng ô vì chúng là ba cách
   * người ta LỠ TAY khác nhau, và một hiện thực chỉ chặn `String()` vẫn để lọt hai kia.
   */
  it("String(), template literal và phép cộng đều ném", () => {
    const s = new SecretBuffer(sentinel());
    expect(() => String(s)).toThrow(SECRET_TO_STRING_FORBIDDEN);
    expect(() => `${s}`).toThrow(SECRET_TO_STRING_FORBIDDEN);
    expect(() => "x" + (s as unknown as string)).toThrow(
      SECRET_TO_STRING_FORBIDDEN,
    );
  });

  /**
   * Lồng BỐN cấp có chủ đích.
   *
   * `redact.paths` của pino là wildcard MỘT cấp, nên một secret ở
   * `err.cause.config.headers.Authorization` không được che bởi cơ chế đó. Ở đây phép
   * che phải đến từ chính `toJSON()` của đối tượng, và `JSON.stringify` có gọi nó ở độ
   * sâu bất kỳ hay không là điều đã đo.
   */
  it("JSON.stringify che secret lồng bốn cấp", () => {
    const value = sentinel();
    const s = new SecretBuffer(value);
    const out = JSON.stringify({ a: { b: { c: { cred: s } } } });
    expect(out).not.toContain(value);
    expect(out).toContain("[REDACTED]");
  });

  it("util.inspect với depth null che secret lồng bốn cấp", () => {
    const value = sentinel();
    const s = new SecretBuffer(value);
    const out = inspect({ a: { b: { c: { cred: s } } } }, { depth: null });
    expect(out).not.toContain(value);
    expect(out).toContain("[REDACTED]");
  });

  it("dấu vết trong một Error lồng nhiều cấp cũng không rò", () => {
    const value = sentinel();
    const s = new SecretBuffer(value);
    const err = new Error("boom");
    (err as unknown as { config: unknown }).config = { credentials: s };
    expect(
      JSON.stringify({ err: { cause: { config: { cred: s } } } }),
    ).not.toContain(value);
    expect(inspect(err, { depth: null })).not.toContain(value);
  });
});

describe("SecretBuffer — use() và dispose()", () => {
  it("use() đọc được plaintext trước khi dispose", () => {
    const value = sentinel();
    const s = new SecretBuffer(value);
    expect(s.use((b) => b.toString("utf8"))).toBe(value);
    expect(s.disposed).toBe(false);
  });

  it("use() trả về kết quả của hàm, KHÔNG trả buffer ra ngoài", () => {
    const s = new SecretBuffer(sentinel());
    const length: number = s.use((b) => b.byteLength);
    expect(length).toBeGreaterThan(0);
  });

  it("dispose() xoá mọi byte về 0", () => {
    const s = new SecretBuffer(sentinel());
    expect(s.everyByteIsZero()).toBe(false);
    s.dispose();
    expect(s.everyByteIsZero()).toBe(true);
    expect(s.disposed).toBe(true);
  });

  /**
   * Dùng sau `dispose()` phải NÉM, không được âm thầm thành công.
   *
   * Nếu nó trả về một buffer toàn 0, SDK cloud có thể coi đó là "không có credential" và
   * **rơi về default credential chain** — tức đi vào tài khoản của UDP thay vì của khách.
   * Đây là chế độ hỏng tệ nhất của cả mục §4.3, vì nó thành công.
   */
  it("use() sau dispose() ném CREDENTIAL_DISPOSED", () => {
    const s = new SecretBuffer(sentinel());
    s.dispose();
    expect(() => s.use((b) => b.toString("utf8"))).toThrow(CREDENTIAL_DISPOSED);
  });

  it("dispose() gọi hai lần không ném", () => {
    const s = new SecretBuffer(sentinel());
    s.dispose();
    expect(() => {
      s.dispose();
    }).not.toThrow();
  });

  it("byteLength đọc được mà không chạm nội dung, cả sau dispose", () => {
    const s = new SecretBuffer("0123456789");
    expect(s.byteLength).toBe(10);
    s.dispose();
    expect(s.byteLength).toBe(10);
  });

  it("nhận Buffer trực tiếp, không chỉ chuỗi", () => {
    const value = sentinel();
    const s = new SecretBuffer(Buffer.from(value, "utf8"));
    expect(s.use((b) => b.toString("utf8"))).toBe(value);
  });
});

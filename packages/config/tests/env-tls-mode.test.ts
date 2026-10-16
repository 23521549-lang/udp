import { describe, expect, it } from "vitest";
import { z } from "zod";
import { envSchema } from "../src/env-schema.js";

/**
 * [Plan #64] Biến môi trường chọn chế độ TLS của adapter database.
 *
 * Đi qua env-schema (nguồn sự thật duy nhất cho env) thay vì đọc `process.env`
 * thô: sai giá trị thì tiến trình dừng ngay lúc khởi động, không đoán ý.
 * envSchema là z.object bọc superRefine nên lấy shape qua innerType().
 */
const inner = envSchema.innerType();
if (!(inner instanceof z.ZodObject)) {
  throw new Error(
    "envSchema không còn là z.object bọc superRefine — cập nhật test này",
  );
}
const tlsModeField = inner.shape.UDP_DB_TLS_MODE;

describe("UDP_DB_TLS_MODE (Plan #64)", () => {
  it("vắng mặt ⇒ verify-full (mặc định an toàn)", () => {
    const parsed = tlsModeField.safeParse(undefined);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe("verify-full");
  });

  it("chấp nhận đúng hai giá trị", () => {
    for (const value of ["verify-full", "disable"] as const) {
      const parsed = tlsModeField.safeParse(value);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toBe(value);
    }
  });

  it("từ chối chuỗi rỗng, sai case, giá trị lạ — fail-fast, không đoán ý", () => {
    for (const bad of ["", " ", "DISABLE", "Verify-Full", "prefer", "off"]) {
      expect(tlsModeField.safeParse(bad).success, bad).toBe(false);
    }
  });
});

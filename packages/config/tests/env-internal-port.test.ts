import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import { envSchema } from "../src/env-schema.js";

/**
 * [Plan #66] Cổng nội bộ của Service 1 và Service 2.
 *
 * Ở production nó BẮT BUỘC: thiếu thì tiến trình chỉ mở cổng công khai và mọi `/internal/*` trả 404 - bên gọi hỏng
 * ngay, nhưng xa chỗ phải sửa. Trùng cổng công khai thì listener thứ hai ném `EADDRINUSE`. Cả hai bắt ở bước parse env.
 * Dev và test để trống: một cổng như trước.
 *
 * Nền là `.env` thật (dotenv không ghi đè biến đã có); phép kiểm chỉ đọc lỗi mang đúng `path` của hai biến này, nên
 * luật production khác (cookie, KEK…) không làm nó đỏ hay xanh thay.
 */
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env") });

const KEYS = ["CORE_BACKEND_INTERNAL_PORT", "FLAG_SERVICE_INTERNAL_PORT"];

function issuesOf(overrides: Record<string, string | undefined>): string[] {
  const input: Record<string, string | undefined> = { ...process.env };
  for (const k of KEYS) delete input[k];
  Object.assign(input, overrides);
  const parsed = envSchema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues
    .filter((i) => KEYS.includes(String(i.path[0])))
    .map((i) => String(i.path[0]));
}

const PROD = {
  NODE_ENV: "production",
  CORE_BACKEND_PORT: "3001",
  FLAG_SERVICE_PORT: "3002",
};

describe("cổng nội bộ (Plan #66)", () => {
  it("production thiếu cổng nội bộ ⇒ từ chối cả hai", () => {
    expect(issuesOf(PROD).sort()).toEqual([...KEYS].sort());
  });

  it("production trùng cổng công khai ⇒ từ chối đúng biến trùng", () => {
    expect(
      issuesOf({
        ...PROD,
        CORE_BACKEND_INTERNAL_PORT: "3001",
        FLAG_SERVICE_INTERNAL_PORT: "3102",
      }),
    ).toEqual(["CORE_BACKEND_INTERNAL_PORT"]);
  });

  it("production đủ và khác cổng công khai ⇒ không lỗi nào ở hai biến", () => {
    expect(
      issuesOf({
        ...PROD,
        CORE_BACKEND_INTERNAL_PORT: "3101",
        FLAG_SERVICE_INTERNAL_PORT: "3102",
      }),
    ).toEqual([]);
  });

  it("trùng cổng công khai bị từ chối ở MỌI môi trường - không chỉ production", () => {
    for (const NODE_ENV of ["development", "test"]) {
      expect(
        issuesOf({
          NODE_ENV,
          FLAG_SERVICE_PORT: "3002",
          FLAG_SERVICE_INTERNAL_PORT: "3002",
        }),
      ).toEqual(["FLAG_SERVICE_INTERNAL_PORT"]);
    }
  });

  it("dev và test để trống ⇒ hợp lệ: một cổng như trước", () => {
    for (const NODE_ENV of ["development", "test"]) {
      expect(issuesOf({ NODE_ENV })).toEqual([]);
    }
  });

  it("chuỗi rỗng là chưa đặt - test-support xoá cổng nội bộ của tiến trình con bằng cách này", () => {
    expect(
      issuesOf({
        NODE_ENV: "test",
        CORE_BACKEND_INTERNAL_PORT: "",
        FLAG_SERVICE_INTERNAL_PORT: "",
      }),
    ).toEqual([]);
    expect(
      issuesOf({
        ...PROD,
        CORE_BACKEND_INTERNAL_PORT: "",
        FLAG_SERVICE_INTERNAL_PORT: "",
      }).sort(),
    ).toEqual([...KEYS].sort());
  });
});

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import { envSchema } from "../src/env-schema.js";

/**
 * [Plan #67] Lớp danh tính của `/internal/*`: hình dạng của hai biến, và luật production - cùng commit với manifest
 * khai chúng, vì cổng env của cụm (`deploy/tests`) parse ConfigMap bằng chính schema này.
 *
 * Nền là `.env` thật như `env-internal-port.test.ts`: luật liên biến (superRefine) chỉ chạy khi mọi trường khác hợp lệ.
 */
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env") });

const KEYS = ["INTERNAL_AUTH_MODE", "INTERNAL_TOKEN_DIR"];

function parse(overrides: Record<string, string | undefined>) {
  const input: Record<string, string | undefined> = { ...process.env };
  for (const k of KEYS) delete input[k];
  Object.assign(input, { NODE_ENV: "test" }, overrides);
  const parsed = envSchema.safeParse(input);
  return {
    issues: parsed.success
      ? []
      : parsed.error.issues
          .filter((i) => KEYS.includes(String(i.path[0])))
          .map((i) => String(i.path[0])),
  };
}

describe("INTERNAL_AUTH_MODE, INTERNAL_TOKEN_DIR (Plan #67)", () => {
  it("không đặt hay chuỗi rỗng ⇒ secret, như trước Plan #67", () => {
    expect(parse({}).issues).toEqual([]);
    expect(parse({ INTERNAL_AUTH_MODE: "" }).issues).toEqual([]);
    // Đọc thẳng trường của schema: phần còn lại của env máy này không quyết định câu trả lời
    const mode = envSchema.innerType().shape.INTERNAL_AUTH_MODE;
    expect(mode.parse("")).toBe("secret");
    expect(mode.parse(undefined)).toBe("secret");
    expect(mode.parse("token-review")).toBe("token-review");
  });

  it("giá trị lạ ⇒ từ chối", () => {
    expect(parse({ INTERNAL_AUTH_MODE: "jwt" }).issues).toEqual([
      "INTERNAL_AUTH_MODE",
    ]);
  });

  it("thư mục token phải là đường tuyệt đối; rỗng là chưa đặt", () => {
    expect(parse({ INTERNAL_TOKEN_DIR: "tokens" }).issues).toEqual([
      "INTERNAL_TOKEN_DIR",
    ]);
    expect(
      parse({ INTERNAL_TOKEN_DIR: "/var/run/secrets/udp/internal" }).issues,
    ).toEqual([]);
    expect(parse({ INTERNAL_TOKEN_DIR: "" }).issues).toEqual([]);
  });
});

describe("luật production (Plan #67)", () => {
  const PROD = { NODE_ENV: "production" };

  it("production thiếu cả hai ⇒ từ chối cả hai", () => {
    expect(parse(PROD).issues.sort()).toEqual([...KEYS].sort());
  });

  it("production ở chế độ secret ⇒ từ chối", () => {
    expect(
      parse({
        ...PROD,
        INTERNAL_AUTH_MODE: "secret",
        INTERNAL_TOKEN_DIR: "/var/run/secrets/udp/internal",
      }).issues,
    ).toEqual(["INTERNAL_AUTH_MODE"]);
  });

  it("production đủ ⇒ không lỗi nào ở hai biến", () => {
    expect(
      parse({
        ...PROD,
        INTERNAL_AUTH_MODE: "token-review",
        INTERNAL_TOKEN_DIR: "/var/run/secrets/udp/internal",
      }).issues,
    ).toEqual([]);
  });
});

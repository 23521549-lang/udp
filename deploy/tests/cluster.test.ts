import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSecrets, IMAGES } from "../src/cluster.js";

/** Bộ bí mật sinh ra và danh mục image (Plan #49) */

const here = dirname(fileURLToPath(import.meta.url));

describe("generateSecrets", () => {
  it("mỗi lần một bộ MỚI; mật khẩu role đủ dài cho job migrate; KEK giải ra đúng 32 byte", () => {
    const a = generateSecrets();
    const b = generateSecrets();
    for (const key of Object.keys(a)) {
      expect(a[key], key).not.toBe(b[key]);
    }
    for (const role of [
      "UDP_S1_DB_PASSWORD",
      "UDP_S2_DB_PASSWORD",
      "UDP_S3_DB_PASSWORD",
    ]) {
      expect(a[role]?.length, role).toBeGreaterThanOrEqual(24);
    }
    expect(Buffer.from(a["UDP_KEK_V1"] ?? "", "base64")).toHaveLength(32);
  });

  it("chuỗi kết nối của mỗi role mang ĐÚNG mật khẩu mà job đặt cho role đó", () => {
    const s = generateSecrets();
    for (const [n, role] of [
      ["1", "udp_s1"],
      ["2", "udp_s2"],
      ["3", "udp_s3"],
    ] as const) {
      const url = new URL(s[`DATABASE_URL_S${n}`] ?? "");
      expect(url.username).toBe(role);
      expect(url.password).toBe(s[`UDP_S${n}_DB_PASSWORD`]);
    }
    expect(new URL(s["DATABASE_URL_DIRECT"] ?? "").password).toBe(
      s["POSTGRES_PASSWORD"],
    );
  });
});

describe("IMAGES", () => {
  it("mỗi image trỏ vào một Dockerfile có thật; service trỏ vào package có thật", () => {
    const root = resolve(here, "../..");
    for (const image of IMAGES) {
      expect(
        () => readFileSync(resolve(root, image.dockerfile)),
        image.name,
      ).not.toThrow();
      const dir = image.args["DIR"];
      if (dir !== undefined) {
        const pkg = JSON.parse(
          readFileSync(resolve(root, dir, "package.json"), "utf8"),
        ) as {
          name: string;
          dependencies?: Record<string, string>;
        };
        expect(pkg.name, image.name).toBe(image.args["PKG"]);
        // Image chạy `node --import tsx src/index.ts` — tsx phải là phụ thuộc CHẠY của service
        expect(pkg.dependencies?.["tsx"], image.name).toBeDefined();
      }
    }
  });
});

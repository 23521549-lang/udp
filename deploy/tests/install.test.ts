import { describe, expect, it } from "vitest";
import { generateSecrets } from "../src/cluster.js";
import { CREATE_ONLY_KEYS, secretAdditions } from "../src/install.js";

/** Plan #52 AC-2 — Secret đang chạy chỉ được BỔ SUNG, không bao giờ ghi đè hay sinh lại nửa nhóm */

const generated = generateSecrets();
const all = new Set(Object.keys(generated));

describe("secretAdditions", () => {
  it("Secret đủ khoá ⇒ không bổ sung gì — kind và máy ảo chạy lại không đụng Secret", () => {
    expect(secretAdditions(all, generated)).toEqual({});
  });

  it("khoá mới của một bản phát hành sau ⇒ thêm đúng khoá đó, lấy giá trị vừa sinh", () => {
    const existing = new Set(
      [...all].filter((k) => k !== "JWT_REFRESH_SECRET"),
    );
    expect(
      secretAdditions(existing, { ...generated, UDP_OIDC_SIGNING_KEY: "k" }),
    ).toEqual({
      JWT_REFRESH_SECRET: generated["JWT_REFRESH_SECRET"],
      UDP_OIDC_SIGNING_KEY: "k",
    });
  });

  it("khoá gắn với dữ liệu mà Secret đang chạy mất ⇒ dừng kèm tên khoá, không sinh bừa", () => {
    for (const key of ["UDP_KEK_V1", "DATABASE_URL_S2", "POSTGRES_PASSWORD"]) {
      const existing = new Set([...all].filter((k) => k !== key));
      expect(() => secretAdditions(existing, generated), key).toThrow(key);
    }
  });

  it("danh sách khoá chỉ-tạo-một-lần đều do bộ sinh tạo ra — tên lệch là lưới thủng", () => {
    for (const key of CREATE_ONLY_KEYS) {
      expect(all.has(key), key).toBe(true);
    }
    // Mọi chuỗi kết nối và mật khẩu role gắn với dữ liệu trên PVC
    for (const key of all) {
      if (/^DATABASE_URL|_DB_PASSWORD$|^POSTGRES_PASSWORD$/.test(key)) {
        expect(CREATE_ONLY_KEYS.has(key), key).toBe(true);
      }
    }
  });
});

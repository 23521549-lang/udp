import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [v4.12, Plan #60 QĐ-7, QĐ-8] Hai cặp biến tuỳ chọn của đăng nhập — thư (SMTP_URL + MAIL_FROM) và GitHub OAuth
 * (GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET): thiếu cả cặp thì tính năng tắt, có một nửa thì dừng lúc khởi động và nêu
 * biến thiếu. Cùng cách với `env-cloud.test.ts`: đặt `process.env` rồi nhập lại module.
 */

const KEYS = [
  "SMTP_URL",
  "MAIL_FROM",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const;
let saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

async function loadEnv(): Promise<
  { ok: true } | { ok: false; message: string }
> {
  vi.resetModules();
  try {
    await import("../src/env.js");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

describe("thư gửi đi", () => {
  it("thiếu cả hai ⇒ khởi động được (Quên mật khẩu tắt)", async () => {
    expect(await loadEnv()).toEqual({ ok: true });
  });

  it("có cả hai ⇒ khởi động được", async () => {
    process.env.SMTP_URL = "smtps://u:p@smtp.example.com:465";
    process.env.MAIL_FROM = "UDP <no-reply@udp.example>";
    expect(await loadEnv()).toEqual({ ok: true });
  });

  it("chỉ một trong hai ⇒ dừng, nêu biến thiếu", async () => {
    process.env.SMTP_URL = "smtps://u:p@smtp.example.com:465";
    const result = await loadEnv();
    expect(result.ok ? "" : result.message).toContain("MAIL_FROM");
  });

  it("không phải smtp:// hay smtps:// ⇒ dừng", async () => {
    process.env.SMTP_URL = "https://smtp.example.com";
    process.env.MAIL_FROM = "UDP <no-reply@udp.example>";
    const result = await loadEnv();
    expect(result.ok ? "" : result.message).toContain("SMTP_URL");
  });
});

describe("đăng nhập GitHub", () => {
  it("có cả hai ⇒ khởi động được; chỉ một ⇒ dừng, nêu biến thiếu", async () => {
    process.env.GITHUB_CLIENT_ID = "Iv1.abc";
    process.env.GITHUB_CLIENT_SECRET = "secret";
    expect(await loadEnv()).toEqual({ ok: true });
    delete process.env.GITHUB_CLIENT_SECRET;
    const result = await loadEnv();
    expect(result.ok ? "" : result.message).toContain("GITHUB_CLIENT_SECRET");
  });
});

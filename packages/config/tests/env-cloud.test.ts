import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [v4.11] Guard cấu hình cloud của `env.ts` (Plan #26 QĐ-5): OIDC issuer, AWS federation,
 * MANAGED — cùng cách với `env-kek.test.ts`:
 * đặt `process.env` rồi nhập lại module, vì fail-fast lúc khởi động là chính tính chất cần
 * kiểm.
 */

const KEYS = [
  "UDP_OIDC_ISSUER",
  "UDP_OIDC_SIGNING_KEY",
  "UDP_AWS_PRINCIPAL_ARN",
  "UDP_EXTERNAL_ID_SECRET",
  "MANAGED_CLOUDS",
  "MANAGED_GCP_PROJECT_ID",
  "MANAGED_AZURE_SUBSCRIPTION_ID",
  "MANAGED_AZURE_RESOURCE_GROUP",
  "NODE_ENV",
  "COOKIE_SECURE",
] as const;
let saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

const rsaKey = (bits: number): string =>
  Buffer.from(
    generateKeyPairSync("rsa", { modulusLength: bits })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
  ).toString("base64");
const RSA_2048 = rsaKey(2048);

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
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS.slice(0, 8)) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

describe("UDP_OIDC_ISSUER và UDP_OIDC_SIGNING_KEY", () => {
  it("thiếu cả hai ⇒ khởi động được (federation GCP/Azure tắt)", async () => {
    expect(await loadEnv()).toEqual({ ok: true });
  });

  it("có cả hai, khoá RSA 2048 ⇒ khởi động được", async () => {
    process.env.UDP_OIDC_ISSUER = "https://udp.example";
    process.env.UDP_OIDC_SIGNING_KEY = RSA_2048;
    expect(await loadEnv()).toEqual({ ok: true });
  });

  it("chỉ một trong hai ⇒ dừng, nêu biến thiếu", async () => {
    process.env.UDP_OIDC_ISSUER = "https://udp.example";
    const result = await loadEnv();
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("UDP_OIDC_SIGNING_KEY");
  });

  it("khoá quá ngắn, khoá EC, hay không phải PEM ⇒ dừng", async () => {
    process.env.UDP_OIDC_ISSUER = "https://udp.example";
    for (const bad of [
      rsaKey(1024),
      Buffer.from(
        generateKeyPairSync("ec", { namedCurve: "P-256" })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      ).toString("base64"),
      Buffer.from("khong phai pem").toString("base64"),
    ]) {
      process.env.UDP_OIDC_SIGNING_KEY = bad;
      expect((await loadEnv()).ok).toBe(false);
    }
  });

  it("issuer có `/` cuối hoặc query ⇒ dừng", async () => {
    process.env.UDP_OIDC_SIGNING_KEY = RSA_2048;
    for (const bad of ["https://udp.example/", "https://udp.example?a=1"]) {
      process.env.UDP_OIDC_ISSUER = bad;
      expect((await loadEnv()).ok).toBe(false);
    }
  });

  it("production với issuer http ⇒ dừng", async () => {
    process.env.NODE_ENV = "production";
    process.env.COOKIE_SECURE = "true";
    process.env.UDP_OIDC_ISSUER = "http://udp.example";
    process.env.UDP_OIDC_SIGNING_KEY = RSA_2048;
    const result = await loadEnv();
    expect(result.ok ? "" : result.message).toContain("UDP_OIDC_ISSUER");
  });
});

describe("UDP_AWS_PRINCIPAL_ARN và UDP_EXTERNAL_ID_SECRET", () => {
  it("có cả hai ⇒ khởi động được; chỉ một ⇒ dừng", async () => {
    process.env.UDP_AWS_PRINCIPAL_ARN =
      "arn:aws:iam::123456789012:role/udp-controlplane";
    process.env.UDP_EXTERNAL_ID_SECRET = "s".repeat(32);
    expect(await loadEnv()).toEqual({ ok: true });
    delete process.env.UDP_EXTERNAL_ID_SECRET;
    const result = await loadEnv();
    expect(result.ok ? "" : result.message).toContain("UDP_EXTERNAL_ID_SECRET");
  });

  it("principal không phải ARN IAM ⇒ dừng", async () => {
    process.env.UDP_AWS_PRINCIPAL_ARN = "arn:aws:s3:::bucket";
    process.env.UDP_EXTERNAL_ID_SECRET = "s".repeat(32);
    expect((await loadEnv()).ok).toBe(false);
  });
});

describe("MANAGED_CLOUDS", () => {
  it("rỗng, hoặc biến tuỳ chọn là chuỗi rỗng ⇒ khởi động được", async () => {
    process.env.MANAGED_CLOUDS = "";
    process.env.MANAGED_GCP_PROJECT_ID = "";
    process.env.MANAGED_AZURE_SUBSCRIPTION_ID = "";
    expect(await loadEnv()).toEqual({ ok: true });
  });

  it("có gcp mà thiếu project đích ⇒ dừng; đủ ⇒ chạy", async () => {
    process.env.MANAGED_CLOUDS = "aws, gcp";
    const missing = await loadEnv();
    expect(missing.ok ? "" : missing.message).toContain(
      "MANAGED_GCP_PROJECT_ID",
    );
    process.env.MANAGED_GCP_PROJECT_ID = "udp-managed";
    expect(await loadEnv()).toEqual({ ok: true });
  });

  it("có azure mà thiếu resource group ⇒ dừng", async () => {
    process.env.MANAGED_CLOUDS = "azure";
    process.env.MANAGED_AZURE_SUBSCRIPTION_ID =
      "11111111-2222-3333-4444-555555555555";
    const result = await loadEnv();
    expect(result.ok ? "" : result.message).toContain(
      "MANAGED_AZURE_RESOURCE_GROUP",
    );
  });

  it("cloud lạ trong danh sách ⇒ dừng", async () => {
    process.env.MANAGED_CLOUDS = "aws,oracle";
    expect((await loadEnv()).ok).toBe(false);
  });
});

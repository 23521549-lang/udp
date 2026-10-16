import { describe, expect, it } from "vitest";
import { DB_TLS_OPTIONS, resolveTlsOptions } from "../src/adapter.js";

/**
 * [Plan #64] Chế độ TLS tường minh của adapter.
 *
 * Postgres kèm cụm (kind/vm) không bật SSL nên `verify-full` cứng làm seed và
 * cả ba service sập ("The server does not support SSL connections"). Chế độ
 * `disable` chỉ được phép với host nội bộ — rào fail-closed chống kịch bản
 * `disable` lọt sang Supabase/cloud (credential đi plaintext câm lặng, T2).
 */
describe("resolveTlsOptions (Plan #64)", () => {
  it("verify-full ⇒ đúng DB_TLS_OPTIONS đã ghim, mọi host", () => {
    expect(
      resolveTlsOptions(
        "verify-full",
        "postgresql://u:p@db.xxx.supabase.co:5432/x",
      ),
    ).toBe(DB_TLS_OPTIONS);
    expect(
      resolveTlsOptions("verify-full", "postgresql://u:p@postgres:5432/x"),
    ).toBe(DB_TLS_OPTIONS);
  });

  it("disable + host nội bộ ⇒ undefined (plaintext)", () => {
    for (const host of [
      "postgres",
      "localhost",
      "127.0.0.1",
      "[::1]",
      "postgres.svc",
      "postgres.default.svc.cluster.local",
    ]) {
      expect(
        resolveTlsOptions("disable", `postgresql://u:p@${host}:5432/x`),
        host,
      ).toBeUndefined();
    }
  });

  it("disable + host ngoài ⇒ ném fail-fast, không plaintext câm lặng", () => {
    expect(() =>
      resolveTlsOptions(
        "disable",
        "postgresql://u:p@db.xxx.supabase.co:5432/x",
      ),
    ).toThrow(/không cho phép|nội bộ/i);
    expect(() =>
      resolveTlsOptions("disable", "postgresql://u:p@8.8.8.8:5432/x"),
    ).toThrow();
  });
});

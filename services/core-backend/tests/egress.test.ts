import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import {
  createEgressFetch,
  EgressBlockedError,
  isBlockedAddress,
  type LookupFn,
} from "../src/core/egress/egress.js";

/** Egress guard chống SSRF (§12 T11) — Plan #28 P3 */

describe("isBlockedAddress", () => {
  it.each([
    "10.0.0.1",
    "172.16.5.5",
    "172.31.255.255",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254", // metadata cloud — đích SSRF kinh điển
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "khong-phai-ip",
  ])("chặn %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111"])(
    "cho %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});

const resolvesTo =
  (...ips: string[]): LookupFn =>
  (_host, _options, callback) => {
    callback(
      null,
      ips.map((address): LookupAddress => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    );
  };

describe("createEgressFetch", () => {
  it("chỉ https", async () => {
    await expect(
      createEgressFetch()("http://api.example.com/x"),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("IP nội bộ viết thẳng trong URL bị chặn trước khi kết nối", async () => {
    await expect(
      createEgressFetch()("https://169.254.169.254/latest/meta-data/"),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("tên miền phân giải ra MỘT địa chỉ nội bộ trong nhiều địa chỉ ⇒ chặn ngay trong lookup của kết nối", async () => {
    const guarded = createEgressFetch({
      lookup: resolvesTo("8.8.8.8", "10.0.0.5"),
    });
    const err = await guarded("https://rebind.example.test/x").catch(
      (e: unknown) => e,
    );
    // undici bọc lỗi kết nối: nguyên nhân gốc là lỗi của guard
    const cause = (err as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(EgressBlockedError);
  });

  it("tên miền phân giải ra địa chỉ công khai ⇒ guard cho đi (lỗi còn lại là của mạng, không của guard)", async () => {
    const guarded = createEgressFetch({ lookup: resolvesTo("203.0.113.10") });
    const err = await guarded("https://public.example.test/x", {
      signal: AbortSignal.timeout(300),
    }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(EgressBlockedError);
    expect((err as { cause?: unknown }).cause).not.toBeInstanceOf(
      EgressBlockedError,
    );
  });
});

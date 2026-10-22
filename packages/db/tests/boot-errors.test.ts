import { describe, expect, it } from "vitest";
import {
  assertConnectedAs,
  DbIdentityMismatchError,
  describeBootFailure,
} from "../src/identity.js";

/**
 * [Plan #64] Thông điệp boot phải gọi đúng tên lỗi.
 *
 * Catch-all ở 3 service từng dán nhãn MỌI lỗi thành "danh tính kết nối database
 * sai" — kể cả lỗi TLS P1011 — khiến lần chẩn đoán kind/vm đi sai hướng.
 * Chuỗi message giữ nguyên từng chữ: `boot-identity.test.ts` của 3 service
 * ghim chúng bằng `toContain`.
 */
describe("describeBootFailure (Plan #64)", () => {
  it("lỗi danh tính ⇒ giữ nguyên message đã ghim", () => {
    const err = new DbIdentityMismatchError(
      'Kết nối database đang dùng role "owner" nhưng service này phải chạy bằng "udp_s1".',
    );
    expect(describeBootFailure(err)).toContain(
      "danh tính kết nối database sai",
    );
  });

  it("lỗi thường ⇒ message kết nối, không dán nhãn danh tính", () => {
    const message = describeBootFailure(new Error("boom"));
    expect(message).toContain("không kết nối được database");
    expect(message).not.toContain("danh tính");
  });

  it("lỗi kết nối (vd TLS P1011, bất kỳ lớp nào) ⇒ message kết nối", () => {
    // Thiết kế nhận diện TÍCH CỰC phía danh tính: mọi thứ không phải
    // DbIdentityMismatchError đều là lỗi kết nối — không liệt kê lớp Prisma.
    const tls = new Error(
      "Error opening a TLS connection: The server does not support SSL connections",
    );
    const message = describeBootFailure(tls);
    expect(message).toContain("không kết nối được database");
    expect(message).not.toContain("danh tính");
  });

  it("assertConnectedAs ném DbIdentityMismatchError (không phải Error thường) khi role sai", async () => {
    const fake = { $queryRaw: async () => [{ current_user: "udp_s2" }] };
    await expect(
      assertConnectedAs(
        fake as unknown as Parameters<typeof assertConnectedAs>[0],
        "udp_s1",
      ),
    ).rejects.toBeInstanceOf(DbIdentityMismatchError);
  });
});

import { describe, expect, it } from "vitest";
import { caPinnedTransport } from "../src/transport.js";

/** Vận chuyển ghim CA của Service 3 (Plan #51 QĐ-3) — không bao giờ nói http với API server */

describe("caPinnedTransport", () => {
  it("từ chối http trước khi mở kết nối nào", async () => {
    const transport = caPinnedTransport(
      Buffer.from("-----BEGIN CERTIFICATE-----").toString("base64"),
    );
    await expect(
      transport.request("http://cluster.vi-du.test/version", { method: "GET" }),
    ).rejects.toThrow(/https/);
  });
});

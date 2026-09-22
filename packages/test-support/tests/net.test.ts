import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { freePort } from "../src/net.js";

describe("freePort", () => {
  it("trả một cổng loopback mà một server khác nghe được ngay", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve());
      });
    });
  });
});

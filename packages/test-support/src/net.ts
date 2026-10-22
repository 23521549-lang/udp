import { createServer } from "node:net";

/** Một cổng TCP đang rảnh trên loopback — để hai test dựng tiến trình không giẫm nhau */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

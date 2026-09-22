import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/store.js";
import { Synchronizer } from "../src/sync.js";
import { HttpTransport, retryAfterMs } from "../src/transport.js";
import { waitFor } from "./helpers/fake-transport.js";

/**
 * `HttpTransport` trên mạng THẬT (server `http` cục bộ) — thứ transport giả không
 * phủ: huỷ một `reader.read()` đang chờ khi watchdog cắt, giải phóng socket thật,
 * và hạn của `GET /sdk/config` khi server nhận kết nối rồi im.
 */

const servers: Server[] = [];
const syncs: Synchronizer[] = [];
afterEach(async () => {
  for (const s of syncs.splice(0)) s.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

async function serve(
  handler: (url: string, res: ServerResponse) => void,
): Promise<{ base: string; sockets: { opened: number; closed: number } }> {
  const sockets = { opened: 0, closed: 0 };
  const server = createServer((req, res) => handler(req.url ?? "", res));
  server.on("connection", (socket) => {
    sockets.opened += 1;
    socket.on("close", () => {
      sockets.closed += 1;
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${String(port)}`, sockets };
}

function synchronizer(
  base: string,
  overrides: { heartbeatTimeoutMs?: number; requestTimeoutMs?: number },
) {
  const sync = new Synchronizer(
    new HttpTransport(base, "udp_sk_test"),
    new ConfigStore(),
    {
      pollingIntervalMs: 10_000,
      sseFailuresBeforeFallback: 3,
      staleAfterMs: 60_000,
      heartbeatTimeoutMs: overrides.heartbeatTimeoutMs ?? 10_000,
      backoffMinMs: 10,
      requestTimeoutMs: overrides.requestTimeoutMs ?? 10_000,
      staleCheckMs: 1_000,
      random: () => 0.5,
      now: Date.now,
    },
    {
      onFirstData: () => undefined,
      onChanged: () => undefined,
      onStale: () => undefined,
      onFresh: () => undefined,
      onUnauthorized: () => undefined,
      onAuthorized: () => undefined,
      onDiagnostic: () => undefined,
    },
  );
  syncs.push(sync);
  return sync;
}

describe("HttpTransport trên mạng thật", () => {
  it("stream gửi header rồi im (hố đen) ⇒ watchdog cắt, socket cũ ĐÓNG, nối lại", async () => {
    let streams = 0;
    const { base, sockets } = await serve((url, res) => {
      if (url.startsWith("/sdk/config")) {
        res.writeHead(503).end();
        return;
      }
      streams += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders(); // rồi không gửi thêm byte nào
    });
    synchronizer(base, { heartbeatTimeoutMs: 100 }).start();
    await waitFor(() => streams >= 3, 5_000);
    // Mỗi lần watchdog cắt là một socket thật được trả lại, không rò kết nối
    await waitFor(() => sockets.closed >= 2, 5_000);
  });

  it("`/sdk/config` nhận kết nối rồi im ⇒ quá hạn riêng, stream vẫn được thử", async () => {
    let streamOpened = false;
    const { base } = await serve((url, res) => {
      if (url.startsWith("/sdk/config")) return; // không bao giờ trả lời
      streamOpened = true;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": nhịp tim\n\n");
    });
    synchronizer(base, { requestTimeoutMs: 100 }).start();
    await waitFor(() => streamOpened, 3_000);
  });
});

describe("retryAfterMs", () => {
  it("số giây, HTTP-date, rác", () => {
    const now = Date.parse("2026-09-22T00:00:00Z");
    expect(retryAfterMs("5", now)).toBe(5_000);
    expect(retryAfterMs("Tue, 22 Sep 2026 00:00:07 GMT", now)).toBe(7_000);
    expect(retryAfterMs("Tue, 21 Sep 2026 00:00:00 GMT", now)).toBe(0);
    expect(retryAfterMs("soon", now)).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();
  });
});

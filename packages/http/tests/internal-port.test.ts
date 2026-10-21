import { Agent, createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notFoundHandler } from "../src/error-handler.js";
import {
  closeServer,
  internalPortOnly,
  listenInternal,
} from "../src/internal-port.js";

/**
 * [Plan #66] `/internal/*` chỉ trên cổng nội bộ.
 *
 * Một app, hai listener - đúng hình dạng của Service 1 và Service 2 ở production. Phép kiểm chạy trên HAI cổng thật:
 * chốt đọc cổng của socket nhận request, nên một app trong bộ nhớ (supertest) không nói được gì về nó.
 */

let publicServer: Server;
let internalServer: Server;
let publicUrl: string;
let internalUrl: string;

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(
        `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      );
    });
  });

beforeAll(async () => {
  internalServer = createServer();
  internalUrl = await listen(internalServer);
  const internalPort = Number(new URL(internalUrl).port);

  const app = express();
  app.use("/internal", internalPortOnly(internalPort));
  app.get("/internal/ping", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use(notFoundHandler);

  internalServer.on("request", app);
  publicServer = createServer(app);
  publicUrl = await listen(publicServer);
});

afterAll(async () => {
  for (const server of [publicServer, internalServer]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("internalPortOnly (Plan #66)", () => {
  it("cổng nội bộ phục vụ /internal", async () => {
    const res = await fetch(`${internalUrl}/internal/ping`);
    expect(res.status).toBe(200);
  });

  it("cổng công khai trả 404 giống hệt một route không tồn tại - không lộ route nội bộ có thật", async () => {
    const internal = await fetch(`${publicUrl}/internal/ping`);
    const missing = await fetch(`${publicUrl}/internal/khong-co`);
    expect(internal.status).toBe(404);
    expect(missing.status).toBe(404);
    const [a, b] = (await Promise.all([internal.json(), missing.json()])) as {
      type: string;
      title: string;
    }[];
    expect(a?.type).toBe(b?.type);
    expect(a?.title).toBe(b?.title);
  });

  it("route công khai chạy ở cả hai cổng - probe qua cổng nội bộ vẫn đúng", async () => {
    expect((await fetch(`${publicUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${internalUrl}/healthz`)).status).toBe(200);
  });
});

describe("listenInternal (Plan #66)", () => {
  it("không có cổng ⇒ không mở gì, close() xong ngay - dev và test chạy một cổng như trước", async () => {
    const app = express();
    const listener = listenInternal(app, undefined, () => {
      throw new Error("không được mở listener khi không có cổng");
    });
    await expect(listener.close()).resolves.toBeUndefined();
  });

  it("có cổng ⇒ mở trên đúng cổng đó, close() đóng hẳn", async () => {
    const probe = createServer();
    const port = Number(new URL(await listen(probe)).port);
    await closeServer(probe);

    const app = express();
    app.get("/healthz", (_req, res) => {
      res.json({ status: "ok" });
    });
    let listener: { close(): Promise<void> } | undefined;
    const opened = new Promise<number>((resolve) => {
      listener = listenInternal(app, port, resolve);
    });
    expect(await opened).toBe(port);
    const url = `http://127.0.0.1:${String(port)}/healthz`;
    expect((await fetch(url)).status).toBe(200);
    await listener?.close();
    await expect(fetch(url)).rejects.toThrow();
  });
});

describe("closeServer (Plan #66)", () => {
  /**
   * Bên gọi giữ MỘT kết nối keep-alive luôn bận - request chậm 50 ms nối liền nhau, đúng hình dạng vòng reconcile
   * của Service 3. `server.close()` trần chỉ đóng kết nối rảnh đúng lúc gọi, nên kết nối này sống mãi và tắt êm rơi
   * vào thoát cưỡng bức. `closeServer` phải đóng nó ngay sau request đang dở.
   */
  it("đóng được cả khi bên gọi giữ một kết nối keep-alive bận", async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.end("ok");
      }, 50);
    });
    const url = await listen(server);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const once = (): Promise<string | undefined> =>
      new Promise((resolve, reject) => {
        get(`${url}/`, { agent }, (res) => {
          res.resume();
          res.on("end", () => {
            resolve(res.headers.connection);
          });
        }).on("error", reject);
      });

    const loop = { running: true };
    const caller = (async () => {
      while (loop.running) {
        try {
          await once();
        } catch {
          return;
        }
      }
    })();
    await new Promise((r) => setTimeout(r, 200));

    const started = Date.now();
    const closed = await Promise.race([
      closeServer(server).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3_000)),
    ]);
    loop.running = false;
    await caller;
    agent.destroy();
    if (!closed) server.closeAllConnections();

    expect(closed, "close xong trước 3 giây").toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

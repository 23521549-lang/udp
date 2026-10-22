import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CallerVerifier } from "@udp/http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/**
 * [Plan #67] Lớp danh tính trong app THẬT của Service 2: mount ngay sau chốt cổng, trước parser và trước lớp bí mật.
 *
 * Hai listener thật trên một app, như `index.ts` ở production - supertest không đo được cổng. Verifier giả đứng thay
 * `TokenReview`; không phép kiểm nào ở đây chạm database (lời gọi bị chặn trước khi tới route).
 */

const CALLER = "system:serviceaccount:udp:pd-controller";
let asked: string[] = [];
const verifier: CallerVerifier = {
  verify(token) {
    asked.push(token);
    return Promise.resolve(token === "good" ? CALLER : null);
  },
};

let publicServer: Server;
let internalServer: Server;
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
  const app = createApp({
    internalPort,
    identity: { verifier, callers: [CALLER] },
  });
  internalServer.on("request", app);
  publicServer = createServer(app);
  await listen(publicServer);
});

afterAll(async () => {
  for (const server of [publicServer, internalServer]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

beforeEach(() => {
  asked = [];
});

describe("Service 2: danh tính bên gọi /internal (Plan #67)", () => {
  it("/healthz trên cổng nội bộ vẫn 200 - probe và phép thử dương của Plan #66 không cần token", async () => {
    const res = await fetch(`${internalUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(asked).toEqual([]);
  });

  it("route nội bộ có thật, không token ⇒ 401 và không hỏi verifier", async () => {
    const res = await fetch(`${internalUrl}/internal/stale-flags`);
    expect(res.status).toBe(401);
    expect(asked).toEqual([]);
  });

  it("token bị verifier từ chối ⇒ 401", async () => {
    const res = await fetch(`${internalUrl}/internal/stale-flags`, {
      headers: { authorization: "Bearer forged" },
    });
    expect(res.status).toBe(401);
    expect(asked).toEqual(["forged"]);
  });

  it("từ chối trước parser: thân JSON hỏng không token vẫn là 401, không phải 400", async () => {
    const res = await fetch(`${internalUrl}/internal/stale-flags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(401);
  });
});

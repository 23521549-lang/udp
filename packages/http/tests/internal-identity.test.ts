import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../src/error-handler.js";
import {
  requireInternalIdentity,
  type CallerVerifier,
  type InternalIdentityLog,
} from "../src/internal-caller.js";

/**
 * [Plan #67] Danh tính bên gọi `/internal/*`: token chiếu của ServiceAccount, hỏi qua `CallerVerifier`.
 *
 * Verifier giả đứng thay `TokenReview` - thứ được kiểm ở đây là middleware: đọc header nào, so với danh sách nào, nói gì
 * khi từ chối, và không bao giờ để token vào log.
 */

const CALLER = "system:serviceaccount:udp:pd-controller";
const GOOD = "good-token";
const STRANGER = "stranger-token";
const BROKEN = "broken-token";

let seen: string[] = [];
const verifier: CallerVerifier = {
  verify(token) {
    seen.push(token);
    if (token === GOOD) return Promise.resolve(CALLER);
    if (token === STRANGER)
      return Promise.resolve("system:serviceaccount:udp:default");
    if (token === BROKEN) return Promise.reject(new Error("api server down"));
    return Promise.resolve(null);
  },
};

let logged: { obj: Record<string, unknown>; msg: string }[] = [];
const log: InternalIdentityLog = {
  warn(obj, msg) {
    logged.push({ obj, msg });
  },
};

let server: Server;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use(
    "/internal",
    requireInternalIdentity({ verifier, callers: [CALLER], log }),
  );
  // Parser SAU danh tính: request chưa xác thực không được parse body
  app.use(express.json());
  app.post("/internal/ping", (req, res) => {
    res.json({ ok: true, body: req.body as unknown });
  });
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use(errorHandler);
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  logged = [];
});

const ping = (headers: Record<string, string>, body = "{}") =>
  fetch(`${url}/internal/ping`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

describe("requireInternalIdentity (Plan #67)", () => {
  it("bên gọi đúng ⇒ tới route", async () => {
    const res = await ping({ authorization: `Bearer ${GOOD}` });
    expect(res.status).toBe(200);
    expect(seen).toEqual([GOOD]);
    expect(logged).toEqual([]);
  });

  it("thiếu header ⇒ 401, không hỏi verifier", async () => {
    const res = await ping({});
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
    expect(logged[0]?.obj).toMatchObject({ reason: "missing" });
  });

  it("sai scheme hay token rỗng ⇒ 401, không hỏi verifier", async () => {
    for (const value of [`Basic ${GOOD}`, "Bearer ", "Bearer", GOOD]) {
      const res = await ping({ authorization: value });
      expect(res.status, value).toBe(401);
    }
    expect(seen).toEqual([]);
  });

  it("verifier không nhận ⇒ 401", async () => {
    const res = await ping({ authorization: "Bearer forged" });
    expect(res.status).toBe(401);
    expect(logged[0]?.obj).toMatchObject({ reason: "invalid" });
  });

  it("danh tính hợp lệ nhưng không phải bên gọi ⇒ 401, log tên để lần ra", async () => {
    const res = await ping({ authorization: `Bearer ${STRANGER}` });
    expect(res.status).toBe(401);
    expect(logged[0]?.obj).toMatchObject({
      reason: "unknown-caller",
      username: "system:serviceaccount:udp:default",
    });
  });

  it("cùng một thông điệp cho mọi lần từ chối - không nói người dò đã đúng nửa đường", async () => {
    const bodies = await Promise.all(
      [
        {},
        { authorization: "Bearer forged" },
        { authorization: `Bearer ${STRANGER}` },
      ].map(
        async (h) =>
          ((await (await ping(h)).json()) as { detail?: string }).detail,
      ),
    );
    expect(new Set(bodies).size).toBe(1);
  });

  it("verifier không trả lời được ⇒ 503, đóng chứ không mở", async () => {
    const res = await ping({ authorization: `Bearer ${BROKEN}` });
    expect(res.status).toBe(503);
  });

  it("từ chối TRƯỚC khi parse body: JSON hỏng vẫn là 401 chứ không 400", async () => {
    const res = await ping({ authorization: "Bearer forged" }, "{not json");
    expect(res.status).toBe(401);
  });

  it("route ngoài /internal không bị chạm", async () => {
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
  });

  it("không dòng log nào chứa token", async () => {
    for (const token of ["forged", STRANGER, BROKEN]) {
      await ping({ authorization: `Bearer ${token}` });
    }
    expect(logged.length).toBeGreaterThan(0);
    for (const token of ["forged", STRANGER, BROKEN]) {
      expect(JSON.stringify(logged)).not.toContain(token);
    }
  });
});

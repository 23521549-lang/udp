import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsonBodyExcept, normalizedPathOf } from "../src/json-body.js";

/**
 * Chạy trên Express THẬT: thứ cần chốt là cách Express khớp route (không phân
 * biệt hoa thường, bỏ `/` cuối) và việc parser có chạy hay không — mock `req`
 * thì chỉ kiểm lại giả định của chính test.
 */

const SEGMENTS = "/api/v1/projects/p1/segments";
const TINY_LIMIT = "16b";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(
    jsonBodyExcept((req) => normalizedPathOf(req) === SEGMENTS, TINY_LIMIT),
  );
  app.all("*", (req, res) => {
    res.json({ path: normalizedPathOf(req), body: req.body ?? null });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("jsonBodyExcept", () => {
  it("vị từ sai ⇒ parser chạy: body nhỏ được parse, body quá trần nhận 413", async () => {
    const small = await post("/api/v1/flags", { a: 1 });
    expect(await small.json()).toMatchObject({ body: { a: 1 } });

    const big = await post("/api/v1/flags", { a: "x".repeat(64) });
    expect(big.status).toBe(413);
  });

  it("vị từ đúng ⇒ parser KHÔNG chạy, kể cả với body quá trần", async () => {
    const res = await post(SEGMENTS, { a: "x".repeat(64) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ body: null });
  });

  it("/API/V1/…/SEGMENTS/ được chuẩn hoá ⇒ vẫn được chừa ra", async () => {
    const res = await post("/API/V1/Projects/P1/SEGMENTS/", {
      a: "x".repeat(64),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: SEGMENTS, body: null });
  });
});

describe("normalizedPathOf", () => {
  it("gốc giữ nguyên là /", async () => {
    const res = await fetch(`${base}/`);
    expect(await res.json()).toMatchObject({ path: "/" });
  });
});

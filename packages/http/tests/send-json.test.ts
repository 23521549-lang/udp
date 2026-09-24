import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CSRF_INVALID_SLUG } from "@udp/shared-types/problem";
import { errorHandler } from "../src/error-handler.js";
import { ForbiddenError, UnprocessableError } from "../src/errors.js";
import { logger } from "../src/logger.js";
import { sendJson } from "../src/send-json.js";

/**
 * [v4.11] Hợp đồng response cưỡng chế từ phía SERVER, và slug `type` đặt tường minh.
 *
 * Ba điều được kiểm ở đây, và cả ba sinh ra từ một vòng soát tìm được "cách hỏng" trước
 * khi mã kịp chạy thật:
 *
 *  1. Response lệch schema phải là **500 của server**, không phải 400 của người dùng.
 *     `errorHandler` bắt `ZodError` TRƯỚC mọi nhánh khác, nên một `ZodError` trần thoát
 *     ra sẽ thành `400 "Dữ liệu gửi lên không hợp lệ"` — người dùng ngồi sửa form cho một
 *     lỗi họ không gây ra, và server không log gì.
 *  2. Một khoá LẠ phải làm response đỏ. Zod mặc định **strip**, nên nếu schema không
 *     `.strict()` thì trường thừa lọt lên dây và không nơi nào biết.
 *  3. Hai lỗi cùng `kind` phân biệt được bằng `type` (403 thiếu quyền với 403 CSRF).
 */

const userWire = z.object({ id: z.string().uuid(), name: z.string() }).strict();

type Sent = { status: number; body: Record<string, unknown> };

async function callRoute(handler: express.RequestHandler): Promise<Sent> {
  const app = express();
  app.get("/x", handler);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  );
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${String(port)}/x`);
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendJson — hợp đồng response", () => {
  it("khớp schema ⇒ gửi đúng dữ liệu đã truyền", async () => {
    const data = {
      id: "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b",
      name: "Hạnh",
    };
    const { status, body } = await callRoute((_req, res) => {
      sendJson(res, userWire, data);
    });
    expect(status).toBe(200);
    expect(body).toEqual(data);
  });

  /**
   * Ô quan trọng nhất của tệp: nó khẳng định mã lỗi **500**, không phải 400.
   *
   * Một hiện thực dùng `schema.parse` sẽ trả 400 và vẫn "có vẻ đúng" — nên nếu ô này chỉ
   * khẳng định "không phải 200" thì nó sẽ xanh với đúng cái lỗi nó tồn tại để chặn.
   */
  it("lệch schema ⇒ 500 của SERVER, không phải 400 của người dùng", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const { status, body } = await callRoute((_req, res) => {
      sendJson(res, userWire, { id: "không-phải-uuid", name: "Hạnh" });
    });
    expect(status).toBe(500);
    expect(String(body.type)).toMatch(/\/internal$/);
    /** Và nó phải để lại một dòng log: bug của server mà im lặng là bug không ai sửa */
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("khoá LẠ ⇒ cũng đỏ, nhờ `.strict()`", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const { status } = await callRoute((_req, res) => {
      sendJson(res, userWire, {
        id: "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b",
        name: "Hạnh",
        /** Trường nội bộ lỡ lọt vào `select` của repository */
        bucketSalt: "bí mật",
      } as never);
    });
    expect(status).toBe(500);
  });

  it("status tuỳ chọn được tôn trọng", async () => {
    const data = {
      id: "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b",
      name: "Hạnh",
    };
    const { status } = await callRoute((_req, res) => {
      sendJson(res, userWire, data, 201);
    });
    expect(status).toBe(201);
  });
});

describe("withTypeSlug — hai lỗi cùng kind phân biệt được", () => {
  it("403 CSRF có `type` riêng, khác 403 thiếu quyền", async () => {
    const csrf = await callRoute(() => {
      throw new ForbiddenError("CSRF token không hợp lệ").withTypeSlug(
        CSRF_INVALID_SLUG,
      );
    });
    const denied = await callRoute(() => {
      throw new ForbiddenError("Không đủ quyền");
    });

    expect(csrf.status).toBe(403);
    expect(denied.status).toBe(403);
    expect(String(csrf.body.type)).toMatch(/\/csrf-invalid$/);
    expect(String(denied.body.type)).toMatch(/\/forbidden$/);
    expect(csrf.body.type).not.toBe(denied.body.type);
  });

  /**
   * Ô ĐỐI CHỨNG cho chính hàm đó: nó phải NÉM khi lời gọi vô nghĩa.
   *
   * Với một lỗi có `problemCode`, `type` được suy từ mã (client tra catalog bằng mã), nên
   * đặt slug ở đó không có tác dụng gì. Một hàm im lặng không làm gì ở nửa số ca là cái
   * bẫy đắt hơn vấn đề nó đi sửa — nên nó phải nói ra ngay tại chỗ gọi.
   */
  it("gọi trên lỗi ĐÃ CÓ mã ⇒ ném ngay, không im lặng bỏ qua", () => {
    expect(() =>
      new UnprocessableError(
        "khoá đã dùng",
        undefined,
        "IDEMPOTENCY_KEY_REUSED",
      ).withTypeSlug("thử-đặt-slug"),
    ).toThrow(/problemCode/);
  });
});

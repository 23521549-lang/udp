import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/error-handler.js";
import {
  ConflictError,
  relayedProblemOf,
  ServiceUnavailableError,
  UnprocessableError,
} from "../src/errors.js";
import { logger } from "../src/logger.js";

/**
 * [v4.4] Hai điều `errorHandler` hứa cho lỗi mới, kiểm qua HTTP thật: trường
 * `resourceId` tới được Portal (còn `details` thì không), và 503 của một phụ
 * thuộc chết được log mức `error` — lỗi hạ tầng người vận hành phải thấy.
 */

async function respond(
  err: Error,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.get("/boom", () => {
    throw err;
  });
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  );
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${String(port)}/boom`);
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

describe("errorHandler — resourceId và 503", () => {
  it("resourceId đi ra Problem Details; details thì không", async () => {
    const { status, body } = await respond(
      new ConflictError(
        "đang có rollout",
        { secret: "x" },
        "ROLLOUT_IN_PROGRESS",
      ).withResource("0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b"),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: "ROLLOUT_IN_PROGRESS",
      resourceId: "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b",
    });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("[v4.11] suggestedAction đi ra Problem Details để Portal vẽ thành nút", async () => {
    const { status, body } = await respond(
      new UnprocessableError(
        "Flagger cần metrics.query",
        undefined,
        "MISSING_CAPABILITY",
      ).withSuggestedAction({
        type: "ENABLE_DOMAIN",
        domainType: "MONITORING",
        toolId: "prometheus-grafana",
      }),
    );
    expect(status).toBe(422);
    expect(body).toMatchObject({
      code: "MISSING_CAPABILITY",
      suggestedAction: {
        type: "ENABLE_DOMAIN",
        domainType: "MONITORING",
        toolId: "prometheus-grafana",
      },
    });
  });

  it("ServiceUnavailableError ⇒ 503 PROVIDER_UNAVAILABLE, log mức error", async () => {
    const error = vi.spyOn(logger, "error");
    const warn = vi.spyOn(logger, "warn");
    const { status, body } = await respond(
      new ServiceUnavailableError("Service 2 không phản hồi"),
    );
    expect(status).toBe(503);
    expect(body).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(body).not.toHaveProperty("resourceId");
    expect(error).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("errorHandler — lỗi nghiệp vụ chuyển tiếp từ service phía sau [v4.5]", () => {
  it("dựng lại đúng status, mã, current, resourceId; log mức warn", async () => {
    const warn = vi.spyOn(logger, "warn");
    const relayed = relayedProblemOf(409, {
      title: "Conflict",
      code: "OPTIMISTIC_LOCK",
      current: { updatedAt: "2026-09-22T00:00:00.000Z" },
      resourceId: "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b",
    });
    if (relayed === undefined) throw new Error("409 phải được chuyển tiếp");
    const { status, body } = await respond(relayed);
    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: "OPTIMISTIC_LOCK",
      current: { updatedAt: "2026-09-22T00:00:00.000Z" },
      resourceId: "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b",
      instance: "/boom",
    });
    expect(warn).toHaveBeenCalled();
  });

  it("không có mã catalog ⇒ vẫn là Problem Details hợp lệ với title của phía sau", async () => {
    const relayed = relayedProblemOf(404, { title: "Not Found" });
    if (relayed === undefined) throw new Error("404 phải được chuyển tiếp");
    const { status, body } = await respond(relayed);
    expect(status).toBe(404);
    expect(body).toMatchObject({ title: "Not Found", status: 404 });
    expect(body).not.toHaveProperty("code");
  });
});

import { INTERNAL_SECRET_HEADER } from "@udp/config";
import { describe, expect, it } from "vitest";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";

/**
 * Client S1 → S2 `track` [v4.4], không database: `fetch` giả trả từng loại
 * response, khẳng định phân loại mà `rollout.service` dựa vào để bù trừ.
 */

const SESSION = "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b";

function clientReturning(respond: () => Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const client = createFlagServiceClient({
    baseUrl: "http://s2.test/",
    secret: "s3cret",
    fetch: (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
      });
      return respond();
    },
  });
  return { calls, track: () => client.track(SESSION) };
}

const json = (status: number, body: unknown) =>
  Promise.resolve(Response.json(body, { status }));

describe("createFlagServiceClient.track", () => {
  it("gọi đúng route kèm secret; 200 đúng hợp đồng ⇒ SUCCESS", async () => {
    const c = clientReturning(() =>
      json(200, {
        flagKey: "f",
        environmentId: "e",
        tracked: true,
        changed: true,
      }),
    );
    expect(await c.track()).toEqual({ status: "SUCCESS", changed: true });
    expect(c.calls[0]?.url).toBe(
      `http://s2.test/internal/rollouts/${SESSION}/track`,
    );
    expect(c.calls[0]?.headers[INTERNAL_SECRET_HEADER]).toBe("s3cret");
  });

  it("409 TRACKED_FLAG_LIMIT ⇒ LIMIT kèm detail; 409/404 khác ⇒ REJECTED", async () => {
    expect(
      await clientReturning(() =>
        json(409, { code: "TRACKED_FLAG_LIMIT", detail: "đủ 3 flag" }),
      ).track(),
    ).toEqual({ status: "LIMIT", message: "đủ 3 flag" });
    expect(
      await clientReturning(() =>
        json(409, { detail: "rollout đã kết thúc" }),
      ).track(),
    ).toEqual({
      status: "REJECTED",
      httpStatus: 409,
      message: "rollout đã kết thúc",
    });
    expect((await clientReturning(() => json(404, {})).track()).status).toBe(
      "REJECTED",
    );
  });

  it("5xx, mạng hỏng, body sai hợp đồng ⇒ UNAVAILABLE (thử lại có ích)", async () => {
    expect((await clientReturning(() => json(503, {})).track()).status).toBe(
      "UNAVAILABLE",
    );
    expect(
      await clientReturning(() =>
        Promise.reject(new Error("ECONNREFUSED")),
      ).track(),
    ).toEqual({ status: "UNAVAILABLE", message: "ECONNREFUSED" });
    expect(
      (
        await clientReturning(() =>
          Promise.resolve(new Response("not json")),
        ).track()
      ).status,
    ).toBe("UNAVAILABLE");
  });
});

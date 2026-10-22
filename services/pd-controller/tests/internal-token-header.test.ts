import { describe, expect, it } from "vitest";
import { createClusterTokenClient } from "../src/cluster-access/token-client.js";
import { createFlagLevelExecutor } from "../src/executors/flag-level.executor.js";
import { createCoreMetricsClient } from "../src/metrics/remote.js";

/**
 * [Plan #67] Ba client nội bộ của Service 3 gửi token chiếu (`authorization: Bearer`) cạnh bí mật khi được tiêm
 * `token`; không tiêm thì như trước. Đọc token hỏng đi đúng đường "không gọi được" của từng client.
 */

const PROJECT = "6f1c2c1e-7a55-4c3f-9d59-0e8e7f3f4a11";
const token = () => Promise.resolve("projected-tok");
const broken = () => Promise.reject(new Error("ENOENT"));

function recorder(response: () => Response) {
  const headers: Record<string, string>[] = [];
  return {
    headers,
    fetch: (_url: string | URL | Request, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>);
      return Promise.resolve(response());
    },
  };
}

describe("token chiếu trong lời gọi nội bộ của Service 3 (Plan #67)", () => {
  it("token-client: có token ⇒ Bearer; đọc token hỏng ⇒ lỗi 'không gọi được' (httpStatus null)", async () => {
    const r = recorder(() =>
      Response.json({
        apiEndpoint: "https://c.test",
        caData: "Q0E=",
        token: "t",
        expiresAt: "2026-09-29T10:00:00.000Z",
      }),
    );
    await createClusterTokenClient({
      baseUrl: "http://s1.test",
      secret: "s",
      token,
      timeoutMs: 1_000,
      fetch: r.fetch,
    })(PROJECT);
    expect(r.headers[0]?.["authorization"]).toBe("Bearer projected-tok");
    expect(r.headers[0]?.["X-Internal-Secret"]).toBe("s");

    await expect(
      createClusterTokenClient({
        baseUrl: "http://s1.test",
        secret: "s",
        token: broken,
        timeoutMs: 1_000,
        fetch: r.fetch,
      })(PROJECT),
    ).rejects.toMatchObject({ httpStatus: null });
  });

  it("metrics client: có token ⇒ Bearer; không tiêm ⇒ không có header", async () => {
    const r = recorder(() => Response.json({}));
    await createCoreMetricsClient({
      baseUrl: "http://s1.test",
      secret: "s",
      token,
      fetch: r.fetch,
    }).source(PROJECT);
    await createCoreMetricsClient({
      baseUrl: "http://s1.test",
      secret: "s",
      fetch: r.fetch,
    }).source(PROJECT);
    expect(r.headers[0]?.["authorization"]).toBe("Bearer projected-tok");
    expect(r.headers[1]?.["authorization"]).toBeUndefined();
  });

  it("executor: track gửi Bearer; đọc token hỏng ⇒ UNAVAILABLE như lỗi mạng", async () => {
    const r = recorder(() =>
      Response.json({
        flagKey: "f",
        environmentId: "e",
        tracked: true,
        changed: true,
      }),
    );
    const ok = createFlagLevelExecutor({
      baseUrl: "http://s2.test",
      secret: "s",
      token,
      fetch: r.fetch,
    });
    await ok.track(PROJECT);
    expect(r.headers[0]?.["authorization"]).toBe("Bearer projected-tok");

    const failing = createFlagLevelExecutor({
      baseUrl: "http://s2.test",
      secret: "s",
      token: broken,
      fetch: r.fetch,
    });
    expect(await failing.track(PROJECT)).toMatchObject({
      status: "UNAVAILABLE",
    });
  });
});

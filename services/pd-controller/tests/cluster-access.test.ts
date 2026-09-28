import { env, INTERNAL_SECRET_HEADER } from "@udp/config";
import type { KubeTransport } from "@udp/cluster-access";
import { describe, expect, it } from "vitest";
import { createClusterAccessProvider } from "../src/cluster-access/provider.js";
import {
  ClusterTokenUnavailableError,
  createClusterTokenClient,
  type IssuedToken,
} from "../src/cluster-access/token-client.js";

/**
 * Đường vào cluster của Service 3 (ADR-06, Plan #51 QĐ-3): token `udp-traffic` xin từ Service 1, `ClusterAccess`
 * dùng chung `@udp/cluster-access`. Không cluster nào ở đây — vận chuyển tiêm vào.
 */

const PROJECT = "6f1c2c1e-7a55-4c3f-9d59-0e8e7f3f4a11";
const ENDPOINT = "https://cluster.vi-du.test";

describe("createClusterTokenClient", () => {
  it("POST đúng route, mang bí mật nội bộ, chỉ xin traffic; đọc hạn thành Date", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const issue = createClusterTokenClient({
      baseUrl: "http://s1.test",
      secret: env.INTERNAL_SERVICE_SECRET,
      timeoutMs: 1_000,
      fetch: (url, init) => {
        seen.push({ url: String(url), init: init ?? {} });
        return Promise.resolve(
          Response.json({
            apiEndpoint: ENDPOINT,
            caData: "Q0E=",
            token: "t-1",
            expiresAt: "2026-09-29T10:00:00.000Z",
          }),
        );
      },
    });
    const issued = await issue(PROJECT);
    expect(issued).toEqual({
      apiEndpoint: ENDPOINT,
      caData: "Q0E=",
      token: "t-1",
      expiresAt: new Date("2026-09-29T10:00:00.000Z"),
    });
    expect(seen[0]?.url).toBe(
      `http://s1.test/internal/clusters/${PROJECT}/token`,
    );
    expect(
      (seen[0]?.init.headers as Record<string, string>)[INTERNAL_SECRET_HEADER],
    ).toBe(env.INTERNAL_SERVICE_SECRET);
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      serviceAccount: "traffic",
    });
  });

  it("404 ⇒ 'project chưa có cluster'; mạng hỏng ⇒ lỗi không mang HTTP", async () => {
    const notFound = createClusterTokenClient({
      baseUrl: "http://s1.test",
      secret: "s",
      timeoutMs: 1_000,
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
    });
    await expect(notFound(PROJECT)).rejects.toMatchObject({
      httpStatus: 404,
      message: "project chưa có cluster",
    });
    const down = createClusterTokenClient({
      baseUrl: "http://s1.test",
      secret: "s",
      timeoutMs: 1_000,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(down(PROJECT)).rejects.toBeInstanceOf(
      ClusterTokenUnavailableError,
    );
  });
});

describe("createClusterAccessProvider", () => {
  function world(lifetimeMs: number) {
    const issued: IssuedToken[] = [];
    const bearers: string[] = [];
    const transport: KubeTransport = {
      request: (_url, init) => {
        bearers.push(new Headers(init.headers).get("authorization") ?? "");
        return Promise.resolve(Response.json({ kind: "Rollout" }));
      },
    };
    const provider = createClusterAccessProvider({
      issue: () => {
        const token: IssuedToken = {
          apiEndpoint: ENDPOINT,
          caData: "Q0E=",
          token: `t-${String(issued.length + 1)}`,
          expiresAt: new Date(Date.now() + lifetimeMs),
        };
        issued.push(token);
        return Promise.resolve(token);
      },
      transportFor: () => transport,
    });
    return { provider, issued, bearers };
  }

  const rollout = {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Rollout",
    namespace: "ns",
    name: "web",
  };

  it("lần cấp đầu cho cả địa chỉ lẫn token đầu — không xin hai lần; token còn hạn thì dùng lại", async () => {
    const { provider, issued, bearers } = world(3_600_000);
    const client = await (await provider.get(PROJECT)).getClient("traffic");
    await client.read("get", rollout);
    await client.read("get", rollout);
    expect(issued).toHaveLength(1);
    expect(bearers).toEqual(["Bearer t-1", "Bearer t-1"]);
    expect(await provider.get(PROJECT)).toBe(await provider.get(PROJECT));
  });

  it("token sắp hết hạn ⇒ xin lại từ Service 1", async () => {
    const { provider, issued, bearers } = world(60_000);
    const client = await (await provider.get(PROJECT)).getClient("traffic");
    await client.read("get", rollout);
    await client.read("get", rollout);
    expect(issued).toHaveLength(2);
    expect(bearers).toEqual(["Bearer t-1", "Bearer t-2"]);
  });

  it("xin identity khác traffic ⇒ lỗi tại chỗ, không lời gọi mạng nào", async () => {
    const { provider, issued, bearers } = world(3_600_000);
    const access = await provider.get(PROJECT);
    for (const identity of ["workload", "tooling"] as const) {
      const client = await access.getClient(identity);
      await expect(client.read("get", rollout)).rejects.toThrow(
        /chỉ có token của udp-system\/udp-traffic/,
      );
    }
    expect(issued).toHaveLength(1);
    expect(bearers).toEqual([]);
  });

  it("forget ⇒ lần sau dựng lại (cluster dựng lại, CA đổi); dựng hỏng thì không nhớ lỗi", async () => {
    const { provider, issued } = world(3_600_000);
    await provider.get(PROJECT);
    provider.forget(PROJECT);
    await provider.get(PROJECT);
    expect(issued).toHaveLength(2);

    let fail = true;
    const flaky = createClusterAccessProvider({
      issue: () =>
        fail
          ? Promise.reject(new ClusterTokenUnavailableError(503))
          : Promise.resolve(issued[0] as IssuedToken),
      transportFor: () => ({ request: () => Promise.reject(new Error("x")) }),
    });
    await expect(flaky.get(PROJECT)).rejects.toBeInstanceOf(
      ClusterTokenUnavailableError,
    );
    fail = false;
    await expect(flaky.get(PROJECT)).resolves.toBeDefined();
  });
});

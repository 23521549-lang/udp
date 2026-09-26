import type { ClusterAccess } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import { createClusterAccessCache } from "../src/modules/cluster/cluster-access-cache.js";
import {
  serviceProxyFetch,
  serviceTargetOf,
} from "../src/modules/cluster/service-proxy-fetch.js";

/**
 * Plan #39 QĐ-3 — truy cập cluster S1 nhớ để đo Prometheus trong cluster: sống theo hạn token
 * quản trị (trừ biên), một lần dựng cho các lời hỏi đồng thời, lỗi không được nhớ.
 */

const accessNo = (n: number) => ({ n }) as unknown as ClusterAccess;

function world(options: { ttlMs?: number; failFirst?: boolean } = {}) {
  let clock = 1_000_000;
  let built = 0;
  const release: (() => void)[] = [];
  const cache = createClusterAccessCache({
    marginMs: 60_000,
    now: () => clock,
    resolve: async () => {
      built += 1;
      const n = built;
      await new Promise<void>((r) => release.push(r));
      if (options.failFirst === true && n === 1) {
        throw new Error("cloud từ chối");
      }
      return {
        access: accessNo(n),
        expiresAt: new Date(clock + (options.ttlMs ?? 900_000)),
      };
    },
  });
  return {
    cache,
    built: () => built,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Cho mọi lần dựng đang chờ đi tiếp */
    flush: async () => {
      await Promise.resolve();
      release.splice(0).forEach((r) => r());
    },
  };
}

async function got(
  w: ReturnType<typeof world>,
  projectId = "p",
): Promise<ClusterAccess> {
  const pending = w.cache.get(projectId);
  await w.flush();
  return pending;
}

describe("createClusterAccessCache", () => {
  it("dùng lại tới khi token còn ít hơn biên, rồi dựng lại", async () => {
    const w = world({ ttlMs: 900_000 });
    const first = await got(w);
    w.advance(900_000 - 60_000 - 1);
    expect(await got(w)).toBe(first);
    expect(w.built()).toBe(1);

    w.advance(1);
    expect(await got(w)).not.toBe(first);
    expect(w.built()).toBe(2);
  });

  it("hai lời hỏi đồng thời cho cùng project chờ CÙNG một lần dựng; project khác dựng riêng", async () => {
    const w = world();
    const a = w.cache.get("p");
    const b = w.cache.get("p");
    const other = w.cache.get("q");
    await w.flush();
    expect(await a).toBe(await b);
    expect(await other).not.toBe(await a);
    expect(w.built()).toBe(2);
  });

  it("dựng hỏng thì không nhớ lỗi — lần hỏi sau thử lại", async () => {
    const w = world({ failFirst: true });
    await expect(got(w)).rejects.toThrow("cloud từ chối");
    await expect(got(w)).resolves.toBeDefined();
    expect(w.built()).toBe(2);
  });

  it("forget bỏ bản nhớ — lần hỏi sau dựng lại dù token còn hạn", async () => {
    const w = world();
    const first = await got(w);
    w.cache.forget("p");
    expect(await got(w)).not.toBe(first);
  });
});

describe("serviceTargetOf / serviceProxyFetch", () => {
  it("DNS service trong cluster ⇒ đích proxy; cổng mặc định theo scheme", () => {
    expect(
      serviceTargetOf(
        "http://vmsingle-udp-vm.udp-system.svc.cluster.local:8429",
      ),
    ).toEqual({
      namespace: "udp-system",
      service: "vmsingle-udp-vm",
      port: 8429,
      scheme: "http",
    });
    expect(serviceTargetOf("https://prom.monitoring")).toMatchObject({
      port: 443,
      scheme: "https",
    });
  });

  it("host không có dạng <service>.<namespace> ⇒ ném, không đoán namespace", () => {
    expect(() => serviceTargetOf("http://prometheus:9090")).toThrow(
      /<service>\.<namespace>/,
    );
  });

  it("fetch giữ nguyên đường và query, chuyển init cho proxyService", async () => {
    const seen: { path: string; init: RequestInit | undefined }[] = [];
    const access = {
      proxyService: (_t: unknown, path: string, init?: RequestInit) => {
        seen.push({ path, init });
        return Promise.resolve(new Response("ok"));
      },
    } as unknown as ClusterAccess;
    const f = serviceProxyFetch(
      () => Promise.resolve(access),
      serviceTargetOf("http://prom.monitoring:9090"),
    );
    const init = { headers: { accept: "application/json" } };
    await f(
      "http://prom.monitoring:9090/api/v1/query?query=up%20%3D%3D%201",
      init,
    );
    expect(seen).toEqual([
      { path: "/api/v1/query?query=up%20%3D%3D%201", init },
    ]);
  });
});

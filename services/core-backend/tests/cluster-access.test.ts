import {
  IDENTITY_SERVICE_ACCOUNTS,
  K8S_WRITE_VERBS,
  type ObjectRef,
} from "@udp/adapter-core";
import { createFakeClusterAccess } from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import {
  createDirectClusterAccess,
  DEFAULT_REFRESH_SKEW_MS,
  objectPath,
  type BoundToken,
  type KubeTransport,
} from "../src/modules/cluster/cluster-access.js";

/**
 * [v4.10] `ClusterAccess` chế độ `direct` (§4.6) — AC-7 và AC-18.
 *
 * Không có cluster nào trên máy này, nên `KubeTransport` được tiêm vào. Nói thẳng điều đó
 * kiểm được và điều đó KHÔNG kiểm được:
 *
 *  - Kiểm được ở đây: identity nào xin token của SA nào, token có được dùng lại thay vì
 *    xin mỗi lời gọi, token có bao giờ rời khỏi closure không, hình path của mọi verb,
 *    `404` là `null` với `read` và là thành công với `delete`.
 *  - KHÔNG kiểm được ở đây: API server thật có chấp nhận những path đó, và RBAC của §12.2
 *    có thật sự từ chối `udp-traffic` patch `deployments`. Hàng sổ nợ `cluster-access-real`
 *    ghi hai phép đó, chạy trên một cluster kind thật.
 *
 * Phân biệt hai danh sách là phần quan trọng: một bộ test tiêm vận chuyển mà không nói
 * giới hạn của mình sẽ được đọc như một bằng chứng về RBAC, mà nó không phải.
 */

const ENDPOINT = "https://cluster.vi-du.test";

function transportOf(
  handler: (url: string, init: RequestInit) => Response,
): { transport: KubeTransport; seen: { url: string; init: RequestInit }[] } {
  const seen: { url: string; init: RequestInit }[] = [];
  return {
    seen,
    transport: {
      request(url, init) {
        seen.push({ url, init });
        return Promise.resolve(handler(url, init));
      },
    },
  };
}

function tokensOf(
  ttlMs = 3_600_000,
): { source: { requestBoundToken: (sa: string) => Promise<BoundToken> }; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    source: {
      requestBoundToken(sa: string): Promise<BoundToken> {
        asked.push(sa);
        return Promise.resolve({
          token: `token-cua-${sa}`,
          expiresAt: new Date(Date.now() + ttlMs),
        });
      },
    },
  };
}

describe("objectPath — hình path theo quy ước Kubernetes", () => {
  it("nhóm core dùng /api/v1, nhóm khác dùng /apis/{group}/{version}", () => {
    expect(
      objectPath({ apiVersion: "v1", kind: "Service", namespace: "ns", name: "s" }),
    ).toBe("/api/v1/namespaces/ns/services/s");
    expect(
      objectPath({
        apiVersion: "argoproj.io/v1alpha1",
        kind: "Rollout",
        namespace: "ns",
        name: "r",
      }),
    ).toBe("/apis/argoproj.io/v1alpha1/namespaces/ns/rollouts/r");
  });

  it("không namespace ⇒ path phạm vi cluster; có labelSelector ⇒ vào query", () => {
    expect(objectPath({ apiVersion: "v1", kind: "Namespace" })).toBe(
      "/api/v1/namespaces",
    );
    expect(
      objectPath({
        apiVersion: "v1",
        kind: "Pod",
        namespace: "ns",
        labelSelector: "app=web",
      }),
    ).toBe("/api/v1/namespaces/ns/pods?labelSelector=app%3Dweb");
  });
});

describe("getClient(as) — identity quyết định ServiceAccount (§12.2)", () => {
  it("mỗi identity xin token của ĐÚNG SA của nó", async () => {
    const { transport } = transportOf(() => new Response("{}", { status: 200 }));
    const { source, asked } = tokensOf();
    const access = createDirectClusterAccess({
      clusterId: "c1",
      apiEndpoint: ENDPOINT,
      transport,
      tokens: source,
    });

    const ref: ObjectRef = {
      apiVersion: "v1",
      kind: "ConfigMap",
      namespace: "ns",
      name: "cm",
    };
    for (const identity of ["workload", "traffic", "tooling"] as const) {
      const client = await access.getClient(identity);
      await client.read("get", ref);
    }
    expect(asked).toEqual([
      IDENTITY_SERVICE_ACCOUNTS.workload,
      IDENTITY_SERVICE_ACCOUNTS.traffic,
      IDENTITY_SERVICE_ACCOUNTS.tooling,
    ]);
  });

  /**
   * Token DÙNG LẠI, không xin mỗi lời gọi.
   *
   * `TokenRequest` là một lời gọi tới API server. Xin lại mỗi lần đọc nghĩa là nhân đôi
   * số lời gọi cho mọi thứ, và với một hàm quét drift đọc hàng trăm đối tượng thì đó là
   * hàng trăm lời gọi thừa — cộng một lý do rất tốt để ai đó "tối ưu" bằng cách cache
   * token xuống đĩa, tức vi phạm I24.
   */
  it("token được dùng lại trong khi còn hạn, và xin lại trước hạn", async () => {
    const { transport } = transportOf(() => new Response("{}", { status: 200 }));
    const { source, asked } = tokensOf(DEFAULT_REFRESH_SKEW_MS + 60_000);
    let clock = Date.now();
    const access = createDirectClusterAccess({
      clusterId: "c1",
      apiEndpoint: ENDPOINT,
      transport,
      tokens: source,
      now: () => clock,
    });
    const ref: ObjectRef = { apiVersion: "v1", kind: "Pod", namespace: "ns" };
    const client = await access.getClient("workload");

    await client.read("list", ref);
    await client.read("list", ref);
    await client.read("list", ref);
    expect(asked).toHaveLength(1);

    /** Vượt qua mốc "còn 5 phút" ⇒ phải xin lại, KHÔNG chờ tới lúc hết hạn */
    clock += 120_000;
    await client.read("list", ref);
    expect(asked).toHaveLength(2);
  });

  /**
   * Token không được để ở chỗ một lần `JSON.stringify` tìm thấy.
   *
   * I24 cấm token sống quá một giờ bị ghi xuống database hay đĩa, và đường phổ biến nhất
   * để điều đó xảy ra không phải một lệnh ghi cố ý mà là một dòng log serialize cả đối
   * tượng. Nên token bị đóng trong closure, và phép này khẳng định điều đó thay vì tin.
   */
  it("token KHÔNG xuất hiện khi serialize đối tượng ClusterAccess", async () => {
    const { transport } = transportOf(() => new Response("{}", { status: 200 }));
    const { source } = tokensOf();
    const access = createDirectClusterAccess({
      clusterId: "c1",
      apiEndpoint: ENDPOINT,
      transport,
      tokens: source,
    });
    const client = await access.getClient("workload");
    await client.read("get", {
      apiVersion: "v1",
      kind: "Pod",
      namespace: "ns",
      name: "p",
    });

    const dumped = JSON.stringify(access) + JSON.stringify(client);
    expect(dumped).not.toContain("token-cua-");
  });
});

describe("read/write — mã trạng thái nào là lỗi, mã nào là câu trả lời", () => {
  it("404 khi đọc ⇒ null, không ném", async () => {
    const { transport } = transportOf(() => new Response("", { status: 404 }));
    const { source } = tokensOf();
    const access = createDirectClusterAccess({
      clusterId: "c1",
      apiEndpoint: ENDPOINT,
      transport,
      tokens: source,
    });
    const client = await access.getClient("workload");
    await expect(
      client.read("get", {
        apiVersion: "v1",
        kind: "Pod",
        namespace: "ns",
        name: "khong-co",
      }),
    ).resolves.toBeNull();
  });

  it("404 khi delete ⇒ THÀNH CÔNG; 404 khi patch ⇒ ném", async () => {
    const { transport } = transportOf(() => new Response("", { status: 404 }));
    const { source } = tokensOf();
    const access = createDirectClusterAccess({
      clusterId: "c1",
      apiEndpoint: ENDPOINT,
      transport,
      tokens: source,
    });
    const client = await access.getClient("workload");
    const ref: ObjectRef = {
      apiVersion: "v1",
      kind: "Pod",
      namespace: "ns",
      name: "p",
    };
    await expect(client.write("delete", ref)).resolves.toBeUndefined();

    /**
     * Khẳng định `.code`, KHÔNG phải thông điệp.
     *
     * `rejects.toThrow("X")` so `X` với **message**, nên nó xanh với bất kỳ lỗi nào tình
     * cờ chứa chuỗi đó và đỏ với đúng lỗi mình muốn khi thông điệp đổi một chữ. Mã lỗi là
     * phần hợp đồng; thông điệp là phần dành cho người đọc log.
     */
    const thrown = await client
      .write("patch", ref, {})
      .then(() => null)
      .catch((err: unknown) => err);
    expect((thrown as { code?: string }).code).toBe("CLUSTER_CALL_FAILED");
  });

  it("mọi verb ghi có một HTTP method, không verb nào rơi ra ngoài", async () => {
    const methods: string[] = [];
    const { transport } = transportOf((_url, init) => {
      methods.push(String(init.method));
      return new Response("{}", { status: 200 });
    });
    const { source } = tokensOf();
    const access = createDirectClusterAccess({
      clusterId: "c1",
      apiEndpoint: ENDPOINT,
      transport,
      tokens: source,
    });
    const client = await access.getClient("tooling");
    const ref: ObjectRef = {
      apiVersion: "v1",
      kind: "ConfigMap",
      namespace: "ns",
      name: "cm",
    };
    for (const verb of K8S_WRITE_VERBS) {
      await client.write(verb, ref, {});
    }
    expect(methods).toHaveLength(K8S_WRITE_VERBS.length);
    expect(methods.filter((m) => m === "undefined")).toEqual([]);
  });

  it("watch là GET có ?watch=1, không phải một method riêng", async () => {
    const urls: string[] = [];
    const { transport } = transportOf((url) => {
      urls.push(url);
      return new Response("{}", { status: 200 });
    });
    const { source } = tokensOf();
    const access = createDirectClusterAccess({
      clusterId: "c1",
      apiEndpoint: ENDPOINT,
      transport,
      tokens: source,
    });
    const client = await access.getClient("workload");
    await client.read("watch", {
      apiVersion: "v1",
      kind: "Pod",
      namespace: "ns",
      labelSelector: "app=web",
    });
    expect(urls[0]).toContain("labelSelector=app%3Dweb&watch=1");
  });
});

describe("proxyService — đường duy nhất gọi service trong cluster", () => {
  it("path đúng hình service proxy của API server, và mang token traffic", async () => {
    const { transport, seen } = transportOf(
      () => new Response("ok", { status: 200 }),
    );
    const { source, asked } = tokensOf();
    const access = createDirectClusterAccess({
      clusterId: "c1",
      apiEndpoint: ENDPOINT,
      transport,
      tokens: source,
    });
    await access.proxyService(
      { namespace: "monitoring", service: "prometheus", port: 9090, scheme: "http" },
      "/api/v1/query?query=up",
    );
    expect(seen[0]?.url).toBe(
      `${ENDPOINT}/api/v1/namespaces/monitoring/services/http:prometheus:9090` +
        `/proxy/api/v1/query?query=up`,
    );
    /** §12.2 mở `services/proxy` cho `udp-traffic`, nên đây phải là SA đó */
    expect(asked).toEqual([IDENTITY_SERVICE_ACCOUNTS.traffic]);
  });
});

describe("probe — hỏi hai câu trong một lượt", () => {
  it("endpoint tới được và token cấp được ⇒ SUCCESS kèm serverVersion", async () => {
    const { transport } = transportOf(
      () => new Response(JSON.stringify({ gitVersion: "v1.31.2" }), { status: 200 }),
    );
    const { source } = tokensOf();
    const access = createDirectClusterAccess({
      clusterId: "c1",
      apiEndpoint: ENDPOINT,
      transport,
      tokens: source,
    });
    const res = await access.probe();
    expect(res.status).toBe("SUCCESS");
    expect(res.data?.reachable).toBe(true);
    expect(res.data?.serverVersion).toBe("v1.31.2");
  });

  /**
   * Lỗi khi xin token KHÔNG được mang lỗi gốc ra ngoài.
   *
   * Một số SDK cloud nhét credential vào `error.config` (§12 T3, I12), và `probe()` là
   * hàm mà Portal hiển thị kết quả cho người dùng. Chỉ tên lỗi đi ra.
   */
  it("xin token thất bại ⇒ FAILED, và thông điệp KHÔNG mang lỗi gốc", async () => {
    const { transport } = transportOf(() => new Response("{}", { status: 200 }));
    const access = createDirectClusterAccess({
      clusterId: "c1",
      apiEndpoint: ENDPOINT,
      transport,
      tokens: {
        requestBoundToken: () => {
          const err = new Error("STS từ chối");
          (err as unknown as { config: unknown }).config = {
            headers: { Authorization: "Bearer BI-MAT-THAT" },
          };
          return Promise.reject(err);
        },
      },
    });
    const res = await access.probe();
    expect(res.status).toBe("FAILED");
    expect(res.data?.reachable).toBe(false);
    expect(JSON.stringify(res)).not.toContain("BI-MAT-THAT");
    expect(JSON.stringify(res)).not.toContain("STS từ chối");
  });
});

/**
 * AC-18 — `getClient()` gọi KHÔNG THAM SỐ phải không biên dịch.
 *
 * `@ts-expect-error` là một khẳng định THẬT, không phải một lời chú: nếu dòng dưới nó
 * biên dịch được thì `tsc` báo "Unused '@ts-expect-error' directive" và cả gói đỏ. Nên
 * phép này được cưỡng chế bởi `tsc --noEmit` trong CI, không phải bởi vitest.
 *
 * Mỗi ngoại lệ mang một MÃ, theo G-03: mã đó là cách một lần thêm `@ts-expect-error` mới
 * không lẫn vào giữa những lần đã soát.
 */
describe("AC-18 — tham số identity là bắt buộc ở tầng kiểu", () => {
  it("gọi getClient() không tham số không biên dịch (TSX-01)", async () => {
    const fake = createFakeClusterAccess();
    // @ts-expect-error TSX-01: `as` bắt buộc — thiếu nó thì ba SA của §12.2 vô nghĩa
    const missing = fake.getClient();
    /** `await` để lỗi runtime (nếu có) không thành unhandled rejection */
    await expect(missing).resolves.toBeDefined();
  });

  it("identity lạ không biên dịch (TSX-02)", async () => {
    const fake = createFakeClusterAccess();
    // @ts-expect-error TSX-02: chỉ ba identity của §12.2, không có "admin"
    await fake.getClient("admin");
    expect(fake.calls).toEqual([]);
  });

  /**
   * Hàm quét drift nhận `ReadOnlyKubernetesClient` ⇒ I32(c) là tính chất của KIỂU (QĐ-27).
   *
   * Đây là phát biểu kiểm được của "hệ thống không bao giờ tự sửa drift": một hàm chỉ nhận
   * client đọc thì nó *không thể* gọi verb ghi, và điều đó đúng trước khi chạy.
   */
  it("client chỉ-đọc không có write (TSX-03)", async () => {
    const fake = createFakeClusterAccess();
    const client = await fake.getClient("traffic");
    const readOnly: { read: typeof client.read } = client;
    // @ts-expect-error TSX-03: `ReadOnlyKubernetesClient` không có `write`
    readOnly.write("patch", { apiVersion: "v1", kind: "Pod" });
    expect(fake.writes).toHaveLength(1);
  });
});

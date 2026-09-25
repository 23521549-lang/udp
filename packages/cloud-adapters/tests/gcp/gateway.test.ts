import { SecretBuffer, type ResolvedCredential } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import { createGcpGateway } from "../../src/gcp/gateway.js";
import { labelKeyHash } from "../../src/gcp/labels.js";
import { fakeGoogle, type FakeReply } from "./fake-google.js";

/** Cổng GCP trên Google giả: phân loại lỗi, dấu sở hữu, chờ xoá, tra theo label */

const PROJECT = "demo-project";
const REGION = "asia-southeast1";
const COMPUTE = `https://compute.googleapis.com/compute/v1/projects/${PROJECT}`;
const CLUSTERS = `https://container.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/clusters`;
const CRM = `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}`;
const TOKEN = "ya29.bi-mat";

function credential(): ResolvedCredential {
  const payload = new SecretBuffer(
    JSON.stringify({ accessToken: TOKEN, gcpProjectId: PROJECT }),
  );
  return {
    provider: "gcp",
    mode: "BYOC",
    authKind: "GCP_WIF",
    payload,
    expiresAt: new Date(Date.now() + 3_600_000),
    dispose: () => payload.dispose(),
  };
}

function gatewayOn(routes: Record<string, FakeReply | FakeReply[]>) {
  const google = fakeGoogle(routes);
  const gateway = createGcpGateway({
    region: REGION,
    credential: credential(),
    fetch: google.fetch,
    deleteWait: { intervalMs: 1, timeoutMs: 60_000 },
    now: Date.now,
    sleep: () => Promise.resolve(),
  });
  return { gateway, calls: google.calls };
}

const vpcRequest = {
  kind: "vpc" as const,
  name: "vpc",
  physicalName: "udp-abc123def456-vpc",
  idempotencyKey: "k-vpc",
  spec: { type: "vpc" },
  tags: { "udp.key": "k-vpc", "udp.project": "p1" },
  parents: {},
};

describe("create", () => {
  it("chờ operation tới DONE; dấu sở hữu nằm trong description, token chỉ ở header", async () => {
    const { gateway, calls } = gatewayOn({
      [`POST ${COMPUTE}/global/networks`]: {
        body: {
          name: "op-1",
          status: "RUNNING",
          selfLink: `${COMPUTE}/global/operations/op-1`,
        },
      },
      [`GET ${COMPUTE}/global/operations/op-1`]: [
        {
          body: {
            name: "op-1",
            status: "RUNNING",
            selfLink: `${COMPUTE}/global/operations/op-1`,
          },
        },
        { body: { name: "op-1", status: "DONE" } },
      ],
    });
    const created = await gateway.create(vpcRequest);
    expect(created).toMatchObject({
      kind: "vpc",
      id: "udp-abc123def456-vpc",
      tags: {},
    });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
    expect(calls[0]?.body).toMatchObject({
      name: "udp-abc123def456-vpc",
      description: "udp.key=k-vpc",
      autoCreateSubnetworks: false,
    });
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("lỗi QUOTA nằm TRONG operation ⇒ throttled (không tưởng đã tạo xong)", async () => {
    const { gateway } = gatewayOn({
      [`POST ${COMPUTE}/global/networks`]: {
        body: {
          name: "op-2",
          status: "DONE",
          error: { errors: [{ code: "QUOTA_EXCEEDED", message: "networks" }] },
        },
      },
    });
    await expect(gateway.create(vpcRequest)).rejects.toMatchObject({
      errorClass: "throttled",
    });
  });

  it("403 ⇒ permission; thông báo lỗi không lộ token", async () => {
    const { gateway } = gatewayOn({
      [`POST ${COMPUTE}/global/networks`]: {
        status: 403,
        body: {
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            errors: [{ reason: "forbidden" }],
          },
        },
      },
    });
    const error = await gateway.create(vpcRequest).catch((e: unknown) => e);
    expect(error).toMatchObject({ errorClass: "permission" });
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it("trang HTML 502 của proxy ⇒ transient, không SyntaxError", async () => {
    const { gateway } = gatewayOn({
      [`POST ${COMPUTE}/global/networks`]: {
        status: 502,
        raw: "<html>Bad Gateway</html>",
      },
    });
    await expect(gateway.create(vpcRequest)).rejects.toMatchObject({
      errorClass: "transient",
    });
  });

  it("label sai luật GCP bị chặn TRƯỚC khi gọi Google", async () => {
    const { gateway, calls } = gatewayOn({});
    await expect(
      gateway.create({
        ...vpcRequest,
        kind: "cluster",
        tags: { "udp.key": "k", "udp.project": "P HOA VA DAU CACH" },
      }),
    ).rejects.toMatchObject({ errorClass: "permanent" });
    expect(calls).toHaveLength(0);
  });
});

describe("findByName", () => {
  it("tài nguyên mang dấu UDP ⇒ nhận", async () => {
    const { gateway } = gatewayOn({
      [`GET ${COMPUTE}/global/networks/udp-abc123def456-vpc`]: {
        body: { name: "udp-abc123def456-vpc", description: "udp.key=k-vpc" },
      },
    });
    await expect(
      gateway.findByName("vpc", "udp-abc123def456-vpc"),
    ).resolves.toMatchObject({
      id: "udp-abc123def456-vpc",
    });
  });

  it("trùng tên nhưng KHÔNG mang dấu UDP ⇒ permanent, tuyệt đối không nhận", async () => {
    const { gateway } = gatewayOn({
      [`GET ${COMPUTE}/global/networks/udp-abc123def456-vpc`]: {
        body: {
          name: "udp-abc123def456-vpc",
          description: "mang của đội khác",
        },
      },
    });
    await expect(
      gateway.findByName("vpc", "udp-abc123def456-vpc"),
    ).rejects.toMatchObject({
      errorClass: "permanent",
    });
  });

  it("không có ⇒ null", async () => {
    const { gateway } = gatewayOn({
      [`GET ${COMPUTE}/global/networks/udp-abc123def456-vpc`]: {
        status: 404,
        body: { error: { code: 404, status: "NOT_FOUND" } },
      },
    });
    await expect(
      gateway.findByName("vpc", "udp-abc123def456-vpc"),
    ).resolves.toBeNull();
  });

  it("node pool tra qua cluster cha có tên suy từ cùng lược đồ", async () => {
    const { gateway, calls } = gatewayOn({
      [`GET ${CLUSTERS}/udp-abc123def456-cluster/nodePools/udp-abc123def456-nodepool`]:
        {
          body: { status: "PROVISIONING" },
        },
    });
    await expect(
      gateway.findByName("nodegroup", "udp-abc123def456-nodepool"),
    ).resolves.toMatchObject({
      id: "udp-abc123def456-cluster/udp-abc123def456-nodepool",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("findByTag / listByProject", () => {
  const clusterWith = (name: string, labels: Record<string, string>) => ({
    name,
    status: "RUNNING",
    description: "udp.key=x",
    resourceLabels: labels,
  });

  it("udp.key tra bằng hash của khoá; cluster khác bị lọc", async () => {
    const key = "p1:cluster:1";
    const { gateway } = gatewayOn({
      [`GET ${CLUSTERS}`]: {
        body: {
          clusters: [
            clusterWith("dung", {
              "udp-key": labelKeyHash(key),
              "udp-project": "p1",
            }),
            clusterWith("khac", {
              "udp-key": labelKeyHash("khac"),
              "udp-project": "p1",
            }),
          ],
        },
      },
    });
    const found = await gateway.findByTag("udp.key", key);
    expect(found.map((r) => r.id)).toEqual(["dung"]);
  });

  it("listByProject lọc theo label project", async () => {
    const { gateway } = gatewayOn({
      [`GET ${CLUSTERS}`]: {
        body: {
          clusters: [
            clusterWith("a", { "udp-project": "p1" }),
            clusterWith("b", { "udp-project": "p2" }),
          ],
        },
      },
    });
    expect((await gateway.listByProject("p1")).map((r) => r.id)).toEqual(["a"]);
  });

  it("lỗi khi liệt kê ⇒ ném (lõi coi là FAILED), không trả rỗng giả", async () => {
    const { gateway } = gatewayOn({
      [`GET ${CLUSTERS}`]: {
        status: 503,
        body: { error: { code: 503, status: "UNAVAILABLE" } },
      },
    });
    await expect(gateway.listByProject("p1")).rejects.toMatchObject({
      errorClass: "transient",
    });
  });
});

describe("remove / isReady", () => {
  const cluster = {
    kind: "cluster" as const,
    id: "udp-abc123def456-cluster",
    provider: "gcp" as const,
    region: REGION,
    createdAt: "2026-09-25T00:00:00.000Z",
    tags: {},
  };

  it("xoá cluster CHỜ tới khi nó biến mất; STOPPING vẫn tính là còn", async () => {
    const { gateway, calls } = gatewayOn({
      [`DELETE ${CLUSTERS}/udp-abc123def456-cluster`]: {
        body: { name: "op-del" },
      },
      [`GET ${CLUSTERS}/udp-abc123def456-cluster`]: [
        { body: { name: cluster.id, status: "STOPPING" } },
        { body: { name: cluster.id, status: "STOPPING" } },
        { status: 404, body: { error: { code: 404 } } },
      ],
    });
    await expect(gateway.remove(cluster)).resolves.toBe("deleted");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(3);
  });

  it("xoá thứ đã không còn ⇒ not-found (teardown coi là xong)", async () => {
    const { gateway } = gatewayOn({
      [`DELETE ${CLUSTERS}/udp-abc123def456-cluster`]: {
        status: 404,
        body: { error: { code: 404 } },
      },
    });
    await expect(gateway.remove(cluster)).resolves.toBe("not-found");
  });

  it("cluster ERROR ⇒ permanent, không chờ vô ích", async () => {
    const { gateway } = gatewayOn({
      [`GET ${CLUSTERS}/udp-abc123def456-cluster`]: {
        body: { status: "ERROR" },
      },
    });
    await expect(gateway.isReady(cluster)).rejects.toMatchObject({
      errorClass: "permanent",
    });
  });
});

describe("quyền và danh tính", () => {
  it("testIamPermissions ⇒ exact; thiếu quyền liệt kê đúng", async () => {
    const { gateway, calls } = gatewayOn({
      [`POST ${CRM}:testIamPermissions`]: {
        body: { permissions: ["container.clusters.create"] },
      },
    });
    const result = await gateway.checkPermissions([
      "container.clusters.create",
      "compute.networks.create",
    ]);
    expect(result).toEqual({
      missing: ["compute.networks.create"],
      confidence: "exact",
      quotaWarnings: [],
    });
    expect(calls[0]?.body).toEqual({
      permissions: ["container.clusters.create", "compute.networks.create"],
    });
  });

  it("whoAmI trả projectId", async () => {
    const { gateway } = gatewayOn({
      [`GET ${CRM}`]: { body: { projectId: PROJECT } },
    });
    await expect(gateway.whoAmI()).resolves.toBe(PROJECT);
  });

  it("clusterInfo: endpoint https + CA; trạng thái lạ ⇒ ERROR", async () => {
    const { gateway } = gatewayOn({
      [`GET ${CLUSTERS}/c1`]: {
        body: {
          name: "c1",
          endpoint: "34.1.2.3",
          status: "WEIRD",
          masterAuth: { clusterCaCertificate: "Q0E=" },
        },
      },
    });
    await expect(gateway.clusterInfo("c1")).resolves.toEqual({
      clusterId: "c1",
      clusterName: "c1",
      apiEndpoint: "https://34.1.2.3",
      caData: "Q0E=",
      status: "ERROR",
    });
  });
});

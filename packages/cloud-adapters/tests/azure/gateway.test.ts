import {
  SecretBuffer,
  type CreatedResource,
  type ResolvedCredential,
} from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import { createAzureGateway } from "../../src/azure/gateway.js";
import { classifyArm } from "../../src/azure/http.js";
import { isGranted } from "../../src/azure/permissions.js";
import { azurePhysicalName } from "../../src/azure/plan.js";
import { fakeHttp, type FakeReply } from "../helpers/fake-http.js";

/** Cổng Azure trên ARM giả: không PUT đè, dấu sở hữu, gỡ NAT trước khi xoá, phân trang */

const SUB = "11111111-2222-3333-4444-555555555555";
const RG = "udp-khach";
const REGION = "southeastasia";
const ARM = "https://management.azure.com";
const RGP = `/subscriptions/${SUB}/resourceGroups/${RG}`;
const NET = `${RGP}/providers/Microsoft.Network`;
const AKS = `${RGP}/providers/Microsoft.ContainerService/managedClusters`;
const ARM_TOKEN = "arm-bi-mat";
const PROJECT = "0f0f0f0f-1111-4222-8333-444455556666";
const KEY = `${PROJECT}:NETWORK:vpc:vpc`;

function credential(): ResolvedCredential {
  const payload = new SecretBuffer(
    JSON.stringify({
      armToken: ARM_TOKEN,
      aksToken: "aks-token",
      subscriptionId: SUB,
      resourceGroup: RG,
    }),
  );
  return {
    provider: "azure",
    mode: "BYOC",
    authKind: "AZURE_FEDERATED",
    payload,
    expiresAt: new Date(Date.now() + 3_600_000),
    dispose: () => payload.dispose(),
  };
}

function gatewayOn(routes: Record<string, FakeReply | FakeReply[]>) {
  const http = fakeHttp(
    Object.fromEntries(
      Object.entries(routes).map(([k, v]) => {
        const [method, path] = k.split(" ");
        return [`${method ?? ""} ${ARM}${path ?? ""}`, v];
      }),
    ),
  );
  const gateway = createAzureGateway({
    region: REGION,
    credential: credential(),
    fetch: http.fetch,
    deleteWait: { intervalMs: 1, timeoutMs: 60_000 },
    now: Date.now,
    sleep: () => Promise.resolve(),
  });
  return { gateway, calls: http.calls };
}

const notFound = (code = "ResourceNotFound"): FakeReply => ({
  status: 404,
  body: { error: { code } },
});

const vnetName = azurePhysicalName(PROJECT, "vpc");
const vnetId = `${NET}/virtualNetworks/${vnetName}`;
const vnetRequest = {
  kind: "vpc" as const,
  name: "vpc",
  physicalName: vnetName,
  idempotencyKey: KEY,
  spec: { type: "vpc", addressPrefix: "10.0.0.0/16" },
  tags: { "udp.key": KEY, "udp.project": PROJECT },
  parents: {},
};

describe("create", () => {
  it("chưa có ⇒ PUT kèm tag và vị trí; token chỉ ở header", async () => {
    const { gateway, calls } = gatewayOn({
      [`GET ${vnetId}`]: notFound(),
      [`PUT ${vnetId}`]: { status: 201, body: { id: vnetId } },
    });
    const created = await gateway.create(vnetRequest);
    expect(created).toMatchObject({
      kind: "vpc",
      id: vnetId,
      tags: vnetRequest.tags,
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(calls[1]?.url).toContain("api-version=");
    expect(calls[1]?.body).toMatchObject({
      location: REGION,
      tags: vnetRequest.tags,
      properties: { addressSpace: { addressPrefixes: ["10.0.0.0/16"] } },
    });
    expect(calls[1]?.headers.Authorization).toBe(`Bearer ${ARM_TOKEN}`);
  });

  it("đã có và mang dấu UDP ⇒ KHÔNG PUT lại (PUT lại VNet là xoá subnet)", async () => {
    const { gateway, calls } = gatewayOn({
      [`GET ${vnetId}`]: { body: { id: vnetId, tags: { "udp.key": KEY } } },
    });
    await expect(gateway.create(vnetRequest)).resolves.toMatchObject({
      id: vnetId,
    });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("trùng tên với tài nguyên của khách ⇒ permanent, KHÔNG PUT đè", async () => {
    const { gateway, calls } = gatewayOn({
      [`GET ${vnetId}`]: { body: { id: vnetId, tags: { team: "khac" } } },
    });
    await expect(gateway.create(vnetRequest)).rejects.toMatchObject({
      errorClass: "permanent",
    });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("403 ⇒ permission; thông báo không lộ token", async () => {
    const { gateway } = gatewayOn({
      [`GET ${vnetId}`]: notFound(),
      [`PUT ${vnetId}`]: {
        status: 403,
        body: { error: { code: "AuthorizationFailed" } },
      },
    });
    const error = await gateway.create(vnetRequest).catch((e: unknown) => e);
    expect(error).toMatchObject({ errorClass: "permission" });
    expect((error as Error).message).not.toContain(ARM_TOKEN);
  });

  it("role assignment: principalId đọc từ identity cha, dấu sở hữu trong description", async () => {
    const guid = azurePhysicalName(PROJECT, "identity-network");
    const subnetId = `${vnetId}/subnets/${azurePhysicalName(PROJECT, "subnet")}`;
    const identityId = `${RGP}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi`;
    const raId = `${subnetId}/providers/Microsoft.Authorization/roleAssignments/${guid}`;
    const parent = (
      id: string,
      kind: CreatedResource["kind"],
    ): CreatedResource => ({
      kind,
      id,
      provider: "azure",
      region: REGION,
      createdAt: "2026-09-25T00:00:00.000Z",
      tags: {},
    });
    const { gateway, calls } = gatewayOn({
      [`GET ${raId}`]: notFound("RoleAssignmentNotFound"),
      [`GET ${identityId}`]: { body: { properties: { principalId: "p-123" } } },
      [`PUT ${raId}`]: { status: 201, body: {} },
    });
    const key = `${PROJECT}:CLUSTER:iam-policy:identity-network`;
    await gateway.create({
      kind: "iam-policy",
      name: "identity-network",
      physicalName: guid,
      idempotencyKey: key,
      spec: {
        type: "iam-policy",
        roleDefinitionGuid: "4d97b98b-1d4f-4787-a291-c67834d212e7",
      },
      tags: { "udp.key": key },
      parents: {
        identity: parent(identityId, "managed-identity"),
        subnet: parent(subnetId, "subnet"),
      },
    });
    expect(calls[2]?.body).toMatchObject({
      properties: {
        principalId: "p-123",
        principalType: "ServicePrincipal",
        description: `udp.key=${key}`,
      },
    });
  });
});

describe("findByName", () => {
  it("role assignment tra ra từ GUID (suy lại subnet là scope của nó)", async () => {
    const guid = azurePhysicalName(PROJECT, "identity-network");
    const raId = `${vnetId}/subnets/${azurePhysicalName(PROJECT, "subnet")}/providers/Microsoft.Authorization/roleAssignments/${guid}`;
    const { gateway } = gatewayOn({
      [`GET ${raId}`]: { body: { properties: { description: "udp.key=k" } } },
    });
    await expect(gateway.findByName("iam-policy", guid)).resolves.toMatchObject(
      { id: raId },
    );
  });

  it("role assignment không mang dấu UDP ⇒ permanent", async () => {
    const guid = azurePhysicalName(PROJECT, "identity-network");
    const raId = `${vnetId}/subnets/${azurePhysicalName(PROJECT, "subnet")}/providers/Microsoft.Authorization/roleAssignments/${guid}`;
    const { gateway } = gatewayOn({
      [`GET ${raId}`]: { body: { properties: { description: "của khách" } } },
    });
    await expect(gateway.findByName("iam-policy", guid)).rejects.toMatchObject({
      errorClass: "permanent",
    });
  });

  it("agent pool tra qua cluster cha có tên suy từ tên pool", async () => {
    const pool = azurePhysicalName(PROJECT, "nodepool");
    const cluster = azurePhysicalName(PROJECT, "cluster");
    const { gateway } = gatewayOn({
      [`GET ${AKS}/${cluster}/agentPools/${pool}`]: {
        body: { properties: { provisioningState: "Creating" } },
      },
    });
    await expect(gateway.findByName("nodegroup", pool)).resolves.toMatchObject({
      id: `${AKS}/${cluster}/agentPools/${pool}`,
    });
  });
});

describe("findByTag / listByProject", () => {
  it("lọc OData theo tag, đi HẾT nextLink, bỏ kiểu ngoài kế hoạch", async () => {
    const next = `${ARM}${RGP}/resources?$skiptoken=abc&api-version=2021-04-01`;
    const { gateway, calls } = gatewayOn({
      [`GET ${RGP}/resources`]: [
        {
          body: {
            value: [
              {
                id: vnetId,
                type: "Microsoft.Network/virtualNetworks",
                tags: { "udp.project": "p1" },
              },
              {
                id: "/x/disk",
                type: "Microsoft.Compute/disks",
                tags: { "udp.project": "p1" },
              },
            ],
            nextLink: next,
          },
        },
        {
          body: {
            value: [
              {
                id: `${AKS}/c`,
                type: "microsoft.containerservice/managedClusters",
                tags: {},
              },
            ],
          },
        },
      ],
    });
    const found = await gateway.listByProject("p'1");
    expect(found.map((r) => [r.kind, r.id])).toEqual([
      ["vpc", vnetId],
      ["cluster", `${AKS}/c`],
    ]);
    expect(decodeURIComponent(calls[0]?.url ?? "")).toContain(
      "$filter=tagName eq 'udp.project' and tagValue eq 'p''1'",
    );
  });

  it("nextLink trỏ ra ngoài ARM ⇒ permanent, token không bị gửi đi", async () => {
    const { gateway, calls } = gatewayOn({
      [`GET ${RGP}/resources`]: {
        body: { value: [], nextLink: "https://ke-la.example/steal" },
      },
    });
    await expect(gateway.listByProject("p1")).rejects.toMatchObject({
      errorClass: "permanent",
    });
    expect(calls).toHaveLength(1);
  });

  it("lỗi giữa chừng ⇒ ném (lõi coi là FAILED), không trả rỗng giả", async () => {
    const { gateway } = gatewayOn({
      [`GET ${RGP}/resources`]: {
        status: 503,
        body: { error: { code: "ServiceUnavailable" } },
      },
    });
    await expect(gateway.listByProject("p1")).rejects.toMatchObject({
      errorClass: "transient",
    });
  });
});

describe("remove / isReady", () => {
  const natId = `${NET}/natGateways/nat`;
  const subnetId = `${vnetId}/subnets/sn`;
  const nat: CreatedResource = {
    kind: "nat-gateway",
    id: natId,
    provider: "azure",
    region: REGION,
    createdAt: "2026-09-25T00:00:00.000Z",
    tags: {},
  };

  it("NAT: gỡ khỏi subnet (giữ nguyên phần còn lại) rồi mới DELETE, chờ tới 404", async () => {
    const { gateway, calls } = gatewayOn({
      [`GET ${natId}`]: [
        { body: { properties: { subnets: [{ id: subnetId }] } } },
        { body: { properties: { provisioningState: "Deleting" } } },
        notFound(),
      ],
      [`GET ${subnetId}`]: [
        {
          body: {
            properties: {
              addressPrefix: "10.0.0.0/20",
              natGateway: { id: natId },
              networkSecurityGroup: { id: "nsg" },
            },
          },
        },
        { body: { properties: { provisioningState: "Updating" } } },
        { body: { properties: { provisioningState: "Succeeded" } } },
      ],
      [`PUT ${subnetId}`]: { body: {} },
      [`DELETE ${natId}`]: { status: 202 },
    });
    await expect(gateway.remove(nat)).resolves.toBe("deleted");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({
      properties: {
        addressPrefix: "10.0.0.0/20",
        networkSecurityGroup: { id: "nsg" },
      },
    });
    const order = calls.map(
      (c) => `${c.method} ${c.url.split("?")[0]?.slice(ARM.length) ?? ""}`,
    );
    expect(order.indexOf(`PUT ${subnetId}`)).toBeLessThan(
      order.indexOf(`DELETE ${natId}`),
    );
  });

  it("subnet biến mất giữa GET và PUT ⇒ vẫn DELETE NAT (không nhầm là NAT đã hết)", async () => {
    const { gateway, calls } = gatewayOn({
      [`GET ${natId}`]: [
        { body: { properties: { subnets: [{ id: subnetId }] } } },
        notFound(),
      ],
      [`GET ${subnetId}`]: {
        body: { properties: { natGateway: { id: natId } } },
      },
      [`PUT ${subnetId}`]: notFound("NotFound"),
      [`DELETE ${natId}`]: { status: 202 },
    });
    await expect(gateway.remove(nat)).resolves.toBe("deleted");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("xoá thứ đã không còn ⇒ not-found", async () => {
    const { gateway } = gatewayOn({
      [`GET ${natId}`]: notFound(),
      [`DELETE ${natId}`]: notFound(),
    });
    await expect(gateway.remove(nat)).resolves.toBe("not-found");
  });

  it("provisioningState Failed ⇒ permanent; không có provisioningState ⇒ sẵn sàng", async () => {
    const failing = gatewayOn({
      [`GET ${natId}`]: {
        body: { properties: { provisioningState: "Failed" } },
      },
    });
    await expect(failing.gateway.isReady(nat)).rejects.toMatchObject({
      errorClass: "permanent",
    });
    const plain = gatewayOn({ [`GET ${natId}`]: { body: { properties: {} } } });
    await expect(plain.gateway.isReady(nat)).resolves.toBe(true);
  });
});

describe("cluster, danh tính, quyền", () => {
  it("clusterInfo: fqdn https, CA lấy từ kubeconfig người dùng; Running ⇒ READY", async () => {
    const id = `${AKS}/c1`;
    const kubeconfig = Buffer.from(
      "clusters:\n- cluster:\n    certificate-authority-data: Q0E=\n    server: https://c1\n",
    ).toString("base64");
    const { gateway } = gatewayOn({
      [`GET ${id}`]: {
        body: {
          name: "c1",
          properties: {
            fqdn: "c1.hcp.southeastasia.azmk8s.io",
            provisioningState: "Succeeded",
            powerState: { code: "Running" },
          },
        },
      },
      [`POST ${id}/listClusterUserCredential`]: {
        body: { kubeconfigs: [{ name: "clusterUser", value: kubeconfig }] },
      },
    });
    await expect(gateway.clusterInfo(id)).resolves.toEqual({
      clusterId: id,
      clusterName: "c1",
      apiEndpoint: "https://c1.hcp.southeastasia.azmk8s.io",
      caData: "Q0E=",
      status: "READY",
    });
  });

  it("whoAmI đọc resource group; không có ⇒ configuration", async () => {
    const ok = gatewayOn({ [`GET ${RGP}`]: { body: { name: RG } } });
    await expect(ok.gateway.whoAmI()).resolves.toBe(`${SUB}/${RG}`);
    const missing = gatewayOn({
      [`GET ${RGP}`]: notFound("ResourceGroupNotFound"),
    });
    await expect(missing.gateway.whoAmI()).rejects.toMatchObject({
      errorClass: "configuration",
    });
  });

  it("checkPermissions: heuristic, thiếu đúng tập, cảnh báo hết hạn mức Public IP", async () => {
    const { gateway } = gatewayOn({
      [`GET ${RGP}/providers/Microsoft.Authorization/permissions`]: {
        body: {
          value: [
            {
              actions: ["Microsoft.Network/*"],
              notActions: ["Microsoft.Network/natGateways/delete"],
            },
            { dataActions: ["Microsoft.ContainerService/managedClusters/*"] },
          ],
        },
      },
      [`GET /subscriptions/${SUB}/providers/Microsoft.Network/locations/${REGION}/usages`]:
        {
          body: {
            value: [
              {
                name: { value: "PublicIPAddresses" },
                currentValue: 10,
                limit: 10,
              },
            ],
          },
        },
    });
    const result = await gateway.checkPermissions([
      "Microsoft.Network/virtualNetworks/write",
      "Microsoft.Network/natGateways/delete",
      "Microsoft.ContainerService/managedClusters/namespaces/write",
      "Microsoft.Authorization/roleAssignments/write",
    ]);
    expect(result.confidence).toBe("heuristic");
    expect(result.missing).toEqual([
      "Microsoft.Network/natGateways/delete",
      "Microsoft.Authorization/roleAssignments/write",
    ]);
    expect(result.quotaWarnings).toHaveLength(1);
  });
});

describe("phân loại lỗi ARM và khớp wildcard", () => {
  it.each([
    [409, "InUseSubnetCannotBeDeleted", "dependency"],
    [409, "AnotherOperationInProgress", "dependency"],
    [400, "PrincipalNotFound", "dependency"],
    [429, "TooManyRequests", "throttled"],
    [400, "QuotaExceeded", "throttled"],
    [404, "ResourceGroupNotFound", "configuration"],
    [404, "ResourceNotFound", "not-found"],
    [403, "AuthorizationFailed", "permission"],
    [500, "InternalServerError", "transient"],
    [400, "InvalidParameter", "permanent"],
  ] as const)("%d %s ⇒ %s", (status, code, expected) => {
    expect(classifyArm(status, code)).toBe(expected);
  });

  it("wildcard không phân biệt hoa thường; ký tự đặc biệt khớp đúng nghĩa đen", () => {
    expect(isGranted([{ actions: ["*"] }], "Microsoft.Network/x/write")).toBe(
      true,
    );
    expect(
      isGranted(
        [{ actions: ["microsoft.network/*/write"] }],
        "Microsoft.Network/x/write",
      ),
    ).toBe(true);
    expect(
      isGranted(
        [{ actions: ["Microsoft.Network/x.y/read"] }],
        "Microsoft.Network/xzy/read",
      ),
    ).toBe(false);
    expect(isGranted([], "Microsoft.Network/x/write")).toBe(false);
  });
});

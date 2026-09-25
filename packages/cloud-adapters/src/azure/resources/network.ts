import { GatewayError } from "../../core/gateway.js";
import { armGetOrNull, armRequest } from "../http.js";
import { parentNames } from "../plan.js";
import {
  armId,
  located,
  parentOf,
  specOf,
  type ArmResource,
  type AzureKindHandler,
  type AzureScope,
} from "./types.js";

/**
 * Mạng của kế hoạch AKS. PUT của ARM là "tạo hoặc cập nhật": cổng chỉ PUT khi tài nguyên
 * CHƯA có (xem `gateway.ts`) — PUT lại một VNet mà không kèm `subnets` là xoá subnet.
 */

export const NETWORK_API = "2024-05-01";
const NETWORK = "Microsoft.Network";

const topLevel = (
  type: string,
): Pick<AzureKindHandler, "idFor" | "idOfName"> => ({
  idFor: (ctx) => armId(ctx.scope, `${NETWORK}/${type}`, ctx.physicalName),
  idOfName: (s, name) => armId(s, `${NETWORK}/${type}`, name),
});

export const vnetHandler: AzureKindHandler = {
  apiVersion: NETWORK_API,
  ownership: "tag",
  ...topLevel("virtualNetworks"),
  body: (ctx) =>
    Promise.resolve({
      ...located(ctx),
      properties: {
        addressSpace: { addressPrefixes: [specOf(ctx, "vpc").addressPrefix] },
      },
    }),
};

/** NSG rỗng: luật mặc định của Azure (cho trong VNet, cho load balancer) là đủ cho AKS */
export const nsgHandler: AzureKindHandler = {
  apiVersion: NETWORK_API,
  ownership: "tag",
  ...topLevel("networkSecurityGroups"),
  body: (ctx) =>
    Promise.resolve({ ...located(ctx), properties: { securityRules: [] } }),
};

export const publicIpHandler: AzureKindHandler = {
  apiVersion: NETWORK_API,
  ownership: "tag",
  ...topLevel("publicIPAddresses"),
  body: (ctx) =>
    Promise.resolve({
      ...located(ctx),
      sku: { name: "Standard" },
      properties: {
        publicIPAllocationMethod: "Static",
        publicIPAddressVersion: "IPv4",
      },
    }),
};

interface NatGateway extends ArmResource {
  properties?: ArmResource["properties"] & { subnets?: { id?: string }[] };
}

/** Hạn chờ một subnet cập nhật xong sau khi gỡ NAT */
const SUBNET_UPDATE_TIMEOUT_MS = 5 * 60_000;
const SUBNET_POLL_MS = 5_000;

/**
 * ARM chặn xoá NAT gateway còn gắn subnet (`InUseNatGatewayCannotBeDeleted`), mà subnet
 * nằm ở bậc teardown SAU NAT. Gỡ liên kết trước: GET subnet, bỏ `natGateway`, PUT lại,
 * chờ subnet về `Succeeded`.
 */
async function detachSubnets(s: AzureScope, natId: string): Promise<void> {
  const nat = await armGetOrNull<NatGateway>(s.http, natId, NETWORK_API);
  for (const ref of nat?.properties?.subnets ?? []) {
    if (ref.id === undefined) continue;
    const subnet = await armGetOrNull<ArmResource>(s.http, ref.id, NETWORK_API);
    if (subnet?.properties === undefined) continue;
    const { natGateway: _detached, ...rest } = subnet.properties;
    try {
      await armRequest(s.http, "PUT", ref.id, NETWORK_API, {
        properties: rest,
      });
    } catch (e) {
      // Subnet biến mất giữa GET và PUT: không còn gì để gỡ
      if (e instanceof GatewayError && e.errorClass === "not-found") continue;
      throw e;
    }
    await waitSucceeded(s, ref.id);
  }
}

async function waitSucceeded(s: AzureScope, id: string): Promise<void> {
  const deadline = s.now() + SUBNET_UPDATE_TIMEOUT_MS;
  for (;;) {
    const r = await armGetOrNull<ArmResource>(s.http, id, NETWORK_API);
    const state = r?.properties?.provisioningState;
    if (r === null || state === "Succeeded") return;
    if (state === "Failed") {
      throw new GatewayError("permanent", `cập nhật ${id} thất bại`);
    }
    if (s.now() >= deadline) {
      throw new GatewayError("transient", `${id} chưa cập nhật xong`);
    }
    await s.sleep(SUBNET_POLL_MS);
  }
}

export const natGatewayHandler: AzureKindHandler = {
  apiVersion: NETWORK_API,
  ownership: "tag",
  ...topLevel("natGateways"),
  body: (ctx) =>
    Promise.resolve({
      ...located(ctx),
      sku: { name: "Standard" },
      properties: {
        idleTimeoutInMinutes: 4,
        publicIpAddresses: [{ id: parentOf(ctx, "pip").id }],
      },
    }),
  beforeRemove: detachSubnets,
};

/** Subnet là tài nguyên CON của VNet: không có tag ARM, sở hữu suy từ VNet cha */
export const subnetHandler: AzureKindHandler = {
  apiVersion: NETWORK_API,
  ownership: "parent",
  idFor: (ctx) => `${parentOf(ctx, "vpc").id}/subnets/${ctx.physicalName}`,
  idOfName: (s, name) =>
    `${armId(s, `${NETWORK}/virtualNetworks`, parentNames.vnetOfSubnet(name))}/subnets/${name}`,
  body: (ctx) =>
    Promise.resolve({
      properties: {
        addressPrefix: specOf(ctx, "subnet").addressPrefix,
        networkSecurityGroup: { id: parentOf(ctx, "nsg").id },
        natGateway: { id: parentOf(ctx, "nat").id },
      },
    }),
};

import { createHash } from "node:crypto";
import { cidrsOverlap, hostAddress, subnetCidr } from "../core/cidr.js";
import type { ProviderPlan, StepContext, StepSpec } from "../core/plan.js";

/**
 * Kế hoạch AKS (§4.2) trong resource group của khách: VNet, NSG, Public IP + NAT gateway
 * cho egress, một subnet cho node; managed identity của control plane được cấp Network
 * Contributor trên subnet (AKS với VNet tự quản CẦN quyền đó, và ARM không tự cấp); cluster
 * AKS (Entra ID + Azure RBAC, tắt tài khoản cục bộ, API server chỉ mở cho control plane
 * của UDP — ADR-06, Azure CNI overlay, egress qua NAT gateway); agent pool theo cỡ.
 *
 * Mọi tài nguyên cấp cao nhận tag lúc tạo; subnet và agent pool là tài nguyên CON (không có
 * tag ARM riêng), role assignment không có tag — ba kind đó tra theo tên tất định.
 */

export type AzureSpec =
  | { type: "vpc"; addressPrefix: string }
  | { type: "nsg" }
  | { type: "elastic-ip" }
  | { type: "nat-gateway" }
  | { type: "subnet"; addressPrefix: string }
  | { type: "managed-identity" }
  | { type: "iam-policy"; roleDefinitionGuid: string }
  | {
      type: "cluster";
      authorizedCidrs: readonly string[];
      systemVmSize: string;
      podCidr: string;
      serviceCidr: string;
      dnsServiceIp: string;
    }
  | {
      type: "nodegroup";
      vmSize: string;
      nodeCount: number;
      maxNodeCount: number;
    };

/** Cỡ node tối thiểu 8 GB (§4.2) */
export const AZURE_VM_SIZES = {
  small: "Standard_D2s_v5",
  medium: "Standard_D4s_v5",
  large: "Standard_D8s_v5",
} as const;

/** Vai trò dựng sẵn "Network Contributor" — id cố định trên mọi tenant */
export const NETWORK_CONTRIBUTOR_ROLE = "4d97b98b-1d4f-4787-a291-c67834d212e7";

/**
 * Dải pod (overlay) và service KHÔNG được chồng lên VNet: chọn ứng viên đầu tiên rời khỏi
 * khối của project — tất định theo khối, nên cùng project luôn ra cùng tham số.
 */
const POD_CIDR_CANDIDATES = ["192.168.0.0/16", "172.24.0.0/14"];
const SERVICE_CIDR_CANDIDATES = ["172.20.0.0/16", "172.21.0.0/16"];

function firstDisjoint(candidates: readonly string[], block: string): string {
  const found = candidates.find((c) => !cidrsOverlap(c, block));
  if (found === undefined) {
    throw new Error(`khối ${block} chồng lên mọi dải dành cho AKS`);
  }
  return found;
}

const shortOf = (projectId: string): string =>
  projectId.replace(/-/g, "").slice(0, 11);
const named = (short: string, stepName: string): string =>
  `udp-${short}-${stepName}`;

/**
 * GUID tất định cho role assignment (tên của nó BẮT BUỘC là GUID): 11 hex đầu là mã ngắn
 * của project — để từ tên suy lại được subnet mà nó gắn vào — phần còn lại từ SHA-256.
 */
export function roleAssignmentName(
  projectId: string,
  stepName: string,
): string {
  const hash = createHash("sha256")
    .update(`${projectId}:${stepName}`)
    .digest("hex");
  const hex = `${shortOf(projectId)}${hash.slice(0, 21)}`;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * `udp-<11 hex đầu project>-<step>`. Hai ngoại lệ theo luật của Azure: agent pool chỉ được
 * chữ thường và số, bắt đầu bằng chữ, ≤ 12 ký tự ⇒ `u<11 hex>`; role assignment là GUID.
 * Cả hai vẫn mang mã ngắn, nên tên cha suy lại được từ tên con.
 */
export function azurePhysicalName(projectId: string, stepName: string): string {
  if (stepName === "nodepool") return `u${shortOf(projectId)}`;
  if (stepName === "identity-network") {
    return roleAssignmentName(projectId, stepName);
  }
  return named(shortOf(projectId), stepName);
}

/** Tên vật lý của cha, suy từ tên con — đường tra theo tên của tài nguyên con */
export const parentNames = {
  clusterOfPool: (poolName: string): string =>
    named(poolName.slice(1), "cluster"),
  vnetOfSubnet: (subnetName: string): string =>
    subnetName.replace(/-subnet$/, "-vpc"),
  subnetOfRoleAssignment: (guid: string): { vnet: string; subnet: string } => {
    const short = guid.replace(/-/g, "").slice(0, 11);
    return { vnet: named(short, "vpc"), subnet: named(short, "subnet") };
  },
};

const network = (ctx: StepContext) => {
  if (ctx.phase !== "NETWORK") {
    throw new Error("step mạng dựng ngoài pha NETWORK");
  }
  return ctx.params;
};
const cluster = (ctx: StepContext) => {
  if (ctx.phase !== "CLUSTER") {
    throw new Error("step cluster dựng ngoài pha CLUSTER");
  }
  return ctx;
};

export const AZURE_NETWORK_STEPS: readonly StepSpec[] = [
  {
    name: "vpc",
    kind: "vpc",
    phase: "NETWORK",
    dependsOn: [],
    build: (ctx): AzureSpec => ({
      type: "vpc",
      addressPrefix: network(ctx).cidrBlock,
    }),
  },
  {
    name: "nsg",
    kind: "nsg",
    phase: "NETWORK",
    dependsOn: [],
    build: (): AzureSpec => ({ type: "nsg" }),
  },
  {
    name: "pip",
    kind: "elastic-ip",
    phase: "NETWORK",
    dependsOn: [],
    build: (): AzureSpec => ({ type: "elastic-ip" }),
  },
  {
    name: "nat",
    kind: "nat-gateway",
    phase: "NETWORK",
    dependsOn: ["pip"],
    build: (): AzureSpec => ({ type: "nat-gateway" }),
  },
  {
    name: "subnet",
    kind: "subnet",
    phase: "NETWORK",
    dependsOn: ["vpc", "nsg", "nat"],
    build: (ctx): AzureSpec => ({
      type: "subnet",
      addressPrefix: subnetCidr(network(ctx).cidrBlock, 20, 0),
    }),
  },
];

export const AZURE_CLUSTER_STEPS: readonly StepSpec[] = [
  {
    name: "identity",
    kind: "managed-identity",
    phase: "CLUSTER",
    dependsOn: [],
    build: (): AzureSpec => ({ type: "managed-identity" }),
  },
  {
    name: "identity-network",
    kind: "iam-policy",
    phase: "CLUSTER",
    dependsOn: ["identity", "subnet"],
    build: (): AzureSpec => ({
      type: "iam-policy",
      roleDefinitionGuid: NETWORK_CONTRIBUTOR_ROLE,
    }),
  },
  {
    name: "cluster",
    kind: "cluster",
    phase: "CLUSTER",
    dependsOn: ["subnet", "identity", "identity-network"],
    build: (ctx): AzureSpec => {
      const c = cluster(ctx);
      const serviceCidr = firstDisjoint(
        SERVICE_CIDR_CANDIDATES,
        c.network.cidrBlock,
      );
      return {
        type: "cluster",
        authorizedCidrs: c.params.controlPlaneCidrs,
        systemVmSize: AZURE_VM_SIZES.small,
        podCidr: firstDisjoint(POD_CIDR_CANDIDATES, c.network.cidrBlock),
        serviceCidr,
        dnsServiceIp: hostAddress(serviceCidr, 10),
      };
    },
  },
  {
    name: "nodepool",
    kind: "nodegroup",
    phase: "CLUSTER",
    dependsOn: ["cluster", "subnet"],
    build: (ctx): AzureSpec => {
      const p = cluster(ctx).params;
      return {
        type: "nodegroup",
        vmSize: AZURE_VM_SIZES[p.nodeSize],
        nodeCount: p.nodeCount,
        maxNodeCount: Math.max(p.nodeCount, p.quota.maxNodes),
      };
    },
  },
];

/**
 * Action ARM và data action của API server AKS mà kế hoạch cần. Kiểm bằng danh sách quyền
 * hiệu lực trên resource group, khớp wildcard phía client (§4.3: `heuristic` — deny
 * assignment và điều kiện ABAC không hiện trong danh sách đó).
 */
export const AZURE_REQUIRED_PERMISSIONS: readonly string[] = [
  "Microsoft.Resources/subscriptions/resourceGroups/read",
  "Microsoft.Network/virtualNetworks/write",
  "Microsoft.Network/virtualNetworks/delete",
  "Microsoft.Network/virtualNetworks/subnets/write",
  "Microsoft.Network/virtualNetworks/subnets/delete",
  "Microsoft.Network/virtualNetworks/subnets/join/action",
  "Microsoft.Network/networkSecurityGroups/write",
  "Microsoft.Network/networkSecurityGroups/delete",
  "Microsoft.Network/networkSecurityGroups/join/action",
  "Microsoft.Network/publicIPAddresses/write",
  "Microsoft.Network/publicIPAddresses/delete",
  "Microsoft.Network/publicIPAddresses/join/action",
  "Microsoft.Network/natGateways/write",
  "Microsoft.Network/natGateways/delete",
  "Microsoft.Network/natGateways/join/action",
  "Microsoft.ManagedIdentity/userAssignedIdentities/write",
  "Microsoft.ManagedIdentity/userAssignedIdentities/delete",
  "Microsoft.ManagedIdentity/userAssignedIdentities/assign/action",
  "Microsoft.Authorization/roleAssignments/write",
  "Microsoft.Authorization/roleAssignments/delete",
  "Microsoft.ContainerService/managedClusters/write",
  "Microsoft.ContainerService/managedClusters/delete",
  "Microsoft.ContainerService/managedClusters/listClusterUserCredential/action",
  "Microsoft.ContainerService/managedClusters/agentPools/write",
  "Microsoft.ContainerService/managedClusters/agentPools/delete",
  // Data action: UDP dựng namespace và RBAC trong cluster (§12.2)
  "Microsoft.ContainerService/managedClusters/namespaces/write",
  "Microsoft.ContainerService/managedClusters/rbac.authorization.k8s.io/clusterrolebindings/write",
];

const HOURS_PER_MONTH = 730;
const monthly = (usdPerHour: number): number =>
  Math.round(usdPerHour * HOURS_PER_MONTH * 100) / 100;

export const azurePlan: ProviderPlan = {
  provider: "azure",
  networkSteps: AZURE_NETWORK_STEPS,
  clusterSteps: AZURE_CLUSTER_STEPS,
  kindsWithoutCreateTags: ["subnet", "iam-policy", "nodegroup"],
  physicalName: azurePhysicalName,
  requiredPermissions: AZURE_REQUIRED_PERMISSIONS,
  pricing: {
    asOf: "2026-09-01",
    // AKS tier Standard (có SLA) 0,10 USD/giờ/cluster
    controlPlaneMonthlyUsd: monthly(0.1),
    // NAT gateway 0,045 USD/giờ (chưa kể dữ liệu xử lý)
    natGatewayMonthlyUsd: monthly(0.045),
    loadBalancerMonthlyUsd: monthly(0.025),
    nodeMonthlyUsd: {
      small: monthly(0.096),
      medium: monthly(0.192),
      large: monthly(0.384),
    },
  },
  docUrl: "https://udp.example/docs/byoc/azure",
};

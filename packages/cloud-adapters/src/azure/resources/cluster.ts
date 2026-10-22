import { parentNames } from "../plan.js";
import {
  armId,
  located,
  parentOf,
  specOf,
  type AzureKindHandler,
} from "./types.js";

/**
 * AKS: cluster và agent pool. PUT trả về ngay khi ARM NHẬN yêu cầu (tạo cluster mất 5–10
 * phút); `waitReady` của lõi đọc `provisioningState`. Cluster sinh kèm một pool hệ thống
 * nhỏ (AKS không cho cluster không có pool `System`); pool của workload là step riêng.
 */

export const AKS_API = "2024-09-01";
const MANAGED_CLUSTERS = "Microsoft.ContainerService/managedClusters";

export const clusterHandler: AzureKindHandler = {
  apiVersion: AKS_API,
  ownership: "tag",
  idFor: (ctx) => armId(ctx.scope, MANAGED_CLUSTERS, ctx.physicalName),
  idOfName: (s, name) => armId(s, MANAGED_CLUSTERS, name),
  body: (ctx) => {
    const spec = specOf(ctx, "cluster");
    const subnetId = parentOf(ctx, "subnet").id;
    return Promise.resolve({
      ...located(ctx),
      sku: { name: "Base", tier: "Standard" },
      identity: {
        type: "UserAssigned",
        userAssignedIdentities: { [parentOf(ctx, "identity").id]: {} },
      },
      properties: {
        dnsPrefix: ctx.physicalName,
        enableRBAC: true,
        // Chỉ Entra ID: không có chứng chỉ admin cục bộ nào để lộ (§4.2 getKubeAuthToken)
        aadProfile: { managed: true, enableAzureRBAC: true },
        disableLocalAccounts: true,
        // API server chỉ mở cho control plane của UDP (ADR-06)
        apiServerAccessProfile: {
          authorizedIPRanges: [...spec.authorizedCidrs],
        },
        networkProfile: {
          networkPlugin: "azure",
          networkPluginMode: "overlay",
          podCidr: spec.podCidr,
          serviceCidr: spec.serviceCidr,
          dnsServiceIP: spec.dnsServiceIp,
          outboundType: "userAssignedNATGateway",
          loadBalancerSku: "standard",
        },
        oidcIssuerProfile: { enabled: true },
        securityProfile: { workloadIdentity: { enabled: true } },
        agentPoolProfiles: [
          {
            name: "system",
            mode: "System",
            count: 1,
            vmSize: spec.systemVmSize,
            osType: "Linux",
            type: "VirtualMachineScaleSets",
            vnetSubnetID: subnetId,
          },
        ],
      },
    });
  },
};

/** Agent pool là tài nguyên CON của cluster: không có tag ARM, sở hữu suy từ cluster cha */
export const agentPoolHandler: AzureKindHandler = {
  apiVersion: AKS_API,
  ownership: "parent",
  idFor: (ctx) =>
    `${parentOf(ctx, "cluster").id}/agentPools/${ctx.physicalName}`,
  idOfName: (s, name) =>
    `${armId(s, MANAGED_CLUSTERS, parentNames.clusterOfPool(name))}/agentPools/${name}`,
  body: (ctx) => {
    const spec = specOf(ctx, "nodegroup");
    return Promise.resolve({
      properties: {
        mode: "User",
        osType: "Linux",
        type: "VirtualMachineScaleSets",
        vmSize: spec.vmSize,
        count: spec.nodeCount,
        enableAutoScaling: true,
        minCount: 1,
        maxCount: spec.maxNodeCount,
        vnetSubnetID: parentOf(ctx, "subnet").id,
      },
    });
  },
};

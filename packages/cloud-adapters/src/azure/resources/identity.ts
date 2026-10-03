import { armRequest } from "../http.js";
import { parentNames } from "../plan.js";
import {
  armId,
  located,
  ownershipMarker,
  parentOf,
  required,
  specOf,
  type ArmResource,
  type AzureKindHandler,
} from "./types.js";

/**
 * Danh tính của control plane AKS: một user-assigned managed identity, và role assignment
 * "Network Contributor" của nó trên subnet node — AKS với VNet tự quản cần quyền đó để
 * gắn NIC và load balancer, và ARM không tự cấp (chỉ CLI làm hộ).
 */

const MSI_API = "2023-01-31";
export const AUTH_API = "2022-04-01";
const ROLE_ASSIGNMENTS = "providers/Microsoft.Authorization/roleAssignments";

export const managedIdentityHandler: AzureKindHandler = {
  apiVersion: MSI_API,
  ownership: "tag",
  idFor: (ctx) =>
    armId(
      ctx.scope,
      "Microsoft.ManagedIdentity/userAssignedIdentities",
      ctx.physicalName,
    ),
  idOfName: (s, name) =>
    armId(s, "Microsoft.ManagedIdentity/userAssignedIdentities", name),
  body: (ctx) => Promise.resolve(located(ctx)),
};

/**
 * Role assignment không có tag: `description` mang dấu `udp.key`, tên là GUID tất định
 * (mang mã ngắn của project ⇒ suy lại được subnet là scope của nó).
 */
export const roleAssignmentHandler: AzureKindHandler = {
  apiVersion: AUTH_API,
  ownership: "description",
  idFor: (ctx) =>
    `${parentOf(ctx, "subnet").id}/${ROLE_ASSIGNMENTS}/${ctx.physicalName}`,
  idOfName: (s, guid) => {
    const { vnet, subnet } = parentNames.subnetOfRoleAssignment(guid);
    return `${armId(s, "Microsoft.Network/virtualNetworks", vnet)}/subnets/${subnet}/${ROLE_ASSIGNMENTS}/${guid}`;
  },
  body: async (ctx) => {
    const spec = specOf(ctx, "iam-policy");
    const identity = await armRequest<ArmResource>(
      ctx.scope.http,
      "GET",
      parentOf(ctx, "identity").id,
      MSI_API,
    );
    return {
      properties: {
        roleDefinitionId: `/subscriptions/${ctx.scope.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${spec.roleDefinitionGuid}`,
        principalId: required(
          identity.properties?.principalId,
          "principalId của managed identity",
        ),
        // Identity vừa tạo có thể chưa lan tới Entra ID: khai kiểu để ARM không tra nó
        principalType: "ServicePrincipal",
        description: ownershipMarker(ctx.idempotencyKey),
      },
    };
  },
};

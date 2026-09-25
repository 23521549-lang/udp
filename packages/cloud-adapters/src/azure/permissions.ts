import type { PermissionCheck } from "../core/gateway.js";
import { armListAll, type AzureHttp } from "./http.js";

/**
 * Preflight quyền Azure (§4.3 bảng "ba cloud, ba cách"): danh sách quyền HIỆU LỰC của
 * credential trên resource group, khớp wildcard phía client ⇒ `heuristic` — danh sách
 * đó không phản ánh deny assignment và điều kiện ABAC, nên "có" ở đây chưa phải chắc có.
 */

export interface AzurePermission {
  actions?: string[];
  notActions?: string[];
  dataActions?: string[];
  notDataActions?: string[];
}

/** Mẫu quyền ARM (`Microsoft.Network/*`, `*`) ⇒ phép khớp; không phân biệt hoa thường */
function matcher(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}

const anyMatch = (patterns: readonly string[] | undefined, action: string) =>
  (patterns ?? []).some((p) => matcher(p).test(action));

/**
 * Một action được cho khi CÓ một mục quyền cho nó mà không loại trừ nó. Action và data
 * action nằm ở hai không gian tên rời nhau, nên một danh sách yêu cầu chung là đủ.
 */
export function isGranted(
  permissions: readonly AzurePermission[],
  action: string,
): boolean {
  return permissions.some(
    (p) =>
      (anyMatch(p.actions, action) && !anyMatch(p.notActions, action)) ||
      (anyMatch(p.dataActions, action) && !anyMatch(p.notDataActions, action)),
  );
}

interface NetworkUsage {
  name?: { value?: string };
  currentValue?: number;
  limit?: number;
}

/** Kế hoạch AKS cần MỘT Public IP Standard cho NAT gateway */
const PUBLIC_IP_USAGES = ["PublicIPAddresses", "StandardSkuPublicIpAddresses"];

async function publicIpWarnings(
  http: AzureHttp,
  subscriptionId: string,
  region: string,
): Promise<string[]> {
  const usages = await armListAll<NetworkUsage>(
    http,
    `/subscriptions/${subscriptionId}/providers/Microsoft.Network/locations/${region}/usages`,
    "2024-05-01",
  );
  return usages.flatMap((u) => {
    const name = u.name?.value ?? "";
    const left = (u.limit ?? 0) - (u.currentValue ?? 0);
    return PUBLIC_IP_USAGES.includes(name) && left < 1
      ? [
          `Hạn mức ${name} ở ${region} còn ${String(left)}/${String(u.limit ?? 0)} — cần 1 cho NAT gateway`,
        ]
      : [];
  });
}

export async function checkAzurePermissions(
  http: AzureHttp,
  scope: { subscriptionId: string; resourceGroup: string; region: string },
  required: readonly string[],
): Promise<PermissionCheck> {
  const permissions = await armListAll<AzurePermission>(
    http,
    `/subscriptions/${scope.subscriptionId}/resourceGroups/${scope.resourceGroup}/providers/Microsoft.Authorization/permissions`,
    "2022-04-01",
  );
  return {
    missing: required.filter((a) => !isGranted(permissions, a)),
    confidence: "heuristic",
    quotaWarnings: await publicIpWarnings(
      http,
      scope.subscriptionId,
      scope.region,
    ),
  };
}

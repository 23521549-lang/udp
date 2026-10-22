import type { CreatedResource } from "@udp/adapter-core";
import { GatewayError } from "../../core/gateway.js";
import type { AzureHttp } from "../http.js";
import type { AzureSpec } from "../plan.js";

/** Ngữ cảnh gọi ARM trong MỘT resource group của khách, ở MỘT region */
export interface AzureScope {
  http: AzureHttp;
  subscriptionId: string;
  resourceGroup: string;
  region: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface AzureCreateContext {
  scope: AzureScope;
  physicalName: string;
  idempotencyKey: string;
  spec: AzureSpec;
  tags: Readonly<Record<string, string>>;
  parents: Readonly<Record<string, CreatedResource>>;
}

/** Hình chung của mọi tài nguyên ARM — chỉ những trường cổng đọc */
export interface ArmResource {
  id?: string;
  name?: string;
  type?: string;
  location?: string;
  tags?: Record<string, string>;
  properties?: {
    provisioningState?: string;
    description?: string;
    principalId?: string;
  } & Record<string, unknown>;
}

export interface AzureKindHandler {
  apiVersion: string;
  /**
   * Cách nhận ra tài nguyên của UDP: tài nguyên cấp cao mang tag `udp.key`; role
   * assignment (không có tag) mang dấu trong `description`; tài nguyên con (subnet, agent
   * pool) thuộc về cha — tên cha tất định và cha đã được kiểm dấu.
   */
  ownership: "tag" | "description" | "parent";
  /** ARM id của tài nguyên SẼ tạo — tên vật lý tất định, nên id cũng tất định */
  idFor(ctx: AzureCreateContext): string;
  /** ARM id suy từ tên vật lý — đường tra theo tên (§4.5 quy tắc 2) */
  idOfName(s: AzureScope, physicalName: string): string;
  body(ctx: AzureCreateContext): Promise<object>;
  /** Gỡ liên kết mà ARM chặn xoá (NAT gateway còn gắn subnet) — chạy ngay trước DELETE */
  beforeRemove?(s: AzureScope, id: string): Promise<void>;
}

export const rgPath = (s: AzureScope): string =>
  `/subscriptions/${s.subscriptionId}/resourceGroups/${s.resourceGroup}`;

export const armId = (s: AzureScope, type: string, name: string): string =>
  `${rgPath(s)}/providers/${type}/${name}`;

/** `description` đánh dấu role assignment của UDP — nó không có tag */
export const ownershipMarker = (idempotencyKey: string): string =>
  `udp.key=${idempotencyKey}`;

export function specOf<T extends AzureSpec["type"]>(
  ctx: AzureCreateContext,
  type: T,
): Extract<AzureSpec, { type: T }> {
  if (ctx.spec.type !== type) {
    throw new GatewayError(
      "permanent",
      `spec ${ctx.spec.type} gửi nhầm cho handler ${type}`,
    );
  }
  return ctx.spec as Extract<AzureSpec, { type: T }>;
}

export function parentOf(
  ctx: AzureCreateContext,
  name: string,
): CreatedResource {
  const parent = ctx.parents[name];
  if (parent === undefined) {
    throw new GatewayError("permanent", `thiếu tài nguyên cha ${name}`);
  }
  return parent;
}

export function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new GatewayError("transient", `ARM không trả ${what}`);
  }
  return value;
}

/** Tài nguyên cấp cao: có vị trí và tag của riêng nó */
export const located = (ctx: AzureCreateContext) => ({
  location: ctx.scope.region,
  tags: { ...ctx.tags },
});

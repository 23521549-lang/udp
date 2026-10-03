import type { CreatedResource } from "@udp/adapter-core";
import { GatewayError } from "../../core/gateway.js";
import type { AwsClients } from "../clients.js";
import type { AwsSpec } from "../plan.js";

/** Những gì một handler cần để tạo MỘT tài nguyên */
export interface AwsCreateContext {
  clients: AwsClients;
  region: string;
  physicalName: string;
  idempotencyKey: string;
  spec: AwsSpec;
  /** Tag dạng chuẩn (AWS giữ nguyên) */
  tags: Readonly<Record<string, string>>;
  parents: Readonly<Record<string, CreatedResource>>;
}

export interface AwsDescribed {
  tags: Record<string, string>;
  ready: boolean;
}

/**
 * Một kind AWS: tạo, đọc lại, xoá. `describe` trả `null` khi tài nguyên KHÔNG còn (đã phân
 * loại `not-found`); mọi lỗi khác ném `GatewayError`.
 */
export interface AwsKindHandler {
  create(ctx: AwsCreateContext): Promise<string>;
  describe(clients: AwsClients, id: string): Promise<AwsDescribed | null>;
  remove(clients: AwsClients, id: string): Promise<void>;
}

/** Spec của step phải đúng loại mà handler này xử lý — sai là lỗi lắp ráp kế hoạch */
export function specOf<T extends AwsSpec["type"]>(
  ctx: AwsCreateContext,
  type: T,
): Extract<AwsSpec, { type: T }> {
  if (ctx.spec.type !== type) {
    throw new GatewayError(
      "permanent",
      `spec ${ctx.spec.type} gửi nhầm cho handler ${type}`,
    );
  }
  return ctx.spec as Extract<AwsSpec, { type: T }>;
}

/** Tài nguyên cha bắt buộc — thiếu là lỗi vĩnh viễn, không phải lỗi tạm */
export function parentOf(ctx: AwsCreateContext, name: string): CreatedResource {
  const parent = ctx.parents[name];
  if (parent === undefined) {
    throw new GatewayError("permanent", `thiếu tài nguyên cha ${name}`);
  }
  return parent;
}

export const parentsOfKind = (
  ctx: AwsCreateContext,
  kind: CreatedResource["kind"],
): CreatedResource[] =>
  Object.values(ctx.parents).filter((p) => p.kind === kind);

/** Giá trị bắt buộc trong response của AWS — thiếu là cloud trả sai hợp đồng */
export function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new GatewayError("transient", `AWS không trả ${what}`);
  }
  return value;
}

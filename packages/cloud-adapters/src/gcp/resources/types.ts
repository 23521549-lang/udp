import type { CreatedResource } from "@udp/adapter-core";
import { GatewayError } from "../../core/gateway.js";
import type { GcpHttp } from "../http.js";
import type { GcpSpec } from "../plan.js";

/** Ngữ cảnh gọi API của MỘT project GCP ở MỘT region */
export interface GcpScope {
  http: GcpHttp;
  gcpProject: string;
  region: string;
}

export interface GcpCreateContext {
  scope: GcpScope;
  physicalName: string;
  idempotencyKey: string;
  spec: GcpSpec;
  /** Label ĐÃ mã hoá theo luật GCP (chỉ cluster dùng) */
  labels: Readonly<Record<string, string>>;
  parents: Readonly<Record<string, CreatedResource>>;
}

export interface GcpDescribed {
  /** Label đã đọc lại (dạng GCP); kind không có label trả `{}` */
  labels: Record<string, string>;
  /** `description` — nơi kind không có label mang `udp.key` */
  description: string;
  ready: boolean;
  /** Trạng thái hỏng vĩnh viễn (cluster `ERROR`) — chờ tiếp là vô ích */
  failed?: boolean;
}

export interface GcpKindHandler {
  create(ctx: GcpCreateContext): Promise<string>;
  describe(scope: GcpScope, id: string): Promise<GcpDescribed | null>;
  remove(scope: GcpScope, id: string): Promise<void>;
}

/** `description` đánh dấu tài nguyên của UDP — kind không có label dựa vào nó */
export const ownershipMarker = (idempotencyKey: string): string =>
  `udp.key=${idempotencyKey}`;

export function specOf<T extends GcpSpec["type"]>(
  ctx: GcpCreateContext,
  type: T,
): Extract<GcpSpec, { type: T }> {
  if (ctx.spec.type !== type) {
    throw new GatewayError(
      "permanent",
      `spec ${ctx.spec.type} gửi nhầm cho handler ${type}`,
    );
  }
  return ctx.spec as Extract<GcpSpec, { type: T }>;
}

export function parentOf(ctx: GcpCreateContext, name: string): CreatedResource {
  const parent = ctx.parents[name];
  if (parent === undefined) {
    throw new GatewayError("permanent", `thiếu tài nguyên cha ${name}`);
  }
  return parent;
}

export function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new GatewayError("transient", `Google không trả ${what}`);
  }
  return value;
}

/** Hạn chờ operation của Compute/IAM — tạo mạng mất vài giây tới vài chục giây */
export const COMPUTE_OPERATION_TIMEOUT_MS = 5 * 60_000;

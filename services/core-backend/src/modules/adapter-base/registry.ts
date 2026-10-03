import type {
  CapabilityBinding,
  CapabilityDeclaration,
} from "@udp/shared-types";
import type {
  DomainAdapter,
  DomainToolConfig,
  ReadOnlyAdapterContext,
} from "@udp/adapter-core";
import type { ZodType } from "zod";
import { createDescriptorAdapter } from "./descriptor.js";

/**
 * `RegistryAdapter` — họ registry DỊCH VỤ (Plan #35 QĐ-3b): ECR, Artifact Registry, ACR, Docker
 * Hub, GHCR, GitHub Packages. Từ Plan #36 là một cách dùng lớp nền mô tả (`descriptor.ts`), không
 * còn là lớp nền riêng: phần chung (một ConfigMap mô tả trong `udp-system`, drift hai chiều,
 * teardown chỉ gỡ phần UDP dựng) sống ở một chỗ cho cả registry lẫn CI dịch vụ.
 *
 * Không cài gì vào cluster và không gọi API nào: registry đã chạy ở nhà cung cấp, và việc cluster
 * KÉO được image là của định danh node (registry của cloud) hay của `udp-registry-pull` mà nền
 * tảng phân phối từ `pullCredential` (QĐ-2, QĐ-3). Thứ họ này thêm vào lớp nền là tên ConfigMap
 * `udp-registry-<tool>` và mô tả chỉ đọc cấu hình (registry không đọc binding nào).
 */

export interface RegistryAdapterSpec {
  domainType: DomainAdapter["domainType"];
  toolId: string;
  version: string;
  capabilities: CapabilityDeclaration;
  configSchema: ZodType;
  /** Mô tả registry — KHÔNG mang khoá; khoá đi đường `pullCredential` */
  describe: (config: DomainToolConfig) => Record<string, string>;
  bindings: (
    ctx: ReadOnlyAdapterContext,
    config: DomainToolConfig,
  ) => CapabilityBinding[];
  /** Prefix khoá bỏ qua khi so drift — cùng luật tường minh với các lớp nền kia */
  ignoredKeyPrefixes?: readonly string[];
}

/** Tên ConfigMap mô tả của một registry — test drift sửa đúng đối tượng này */
export const registryDescriptorName = (toolId: string): string =>
  `udp-registry-${toolId}`;

export function createRegistryAdapter(
  spec: RegistryAdapterSpec,
): DomainAdapter {
  return createDescriptorAdapter({
    ...spec,
    descriptorName: registryDescriptorName(spec.toolId),
  });
}

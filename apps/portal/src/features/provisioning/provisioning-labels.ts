import type { ProvisionBlocker } from "@udp/shared-types/provisioning-api";
import type {
  JobDetailWire,
  ProvisioningJobWire,
} from "@udp/shared-types/wire";
import { messagesOf } from "../../i18n";
import { provisioningLabelMessages } from "./provisioning-labels.messages";

/**
 * Nhãn của provisioning theo ngôn ngữ đang chọn (Plan #54) — hàm tra đọc ngôn ngữ lúc gọi, như `formatNumber`;
 * component gọi chúng đã theo dõi ngôn ngữ qua chữ của chính nó. Chữ ở `provisioning-labels.messages.ts`.
 */

/**
 * Tra chữ từ một mã dây kiểu `string` (danh sách quản trị, trang chủ): mã lạ — máy chủ mới hơn Portal —
 * hiện nguyên mã thay vì một ô trống.
 */
export function labelOf<K extends string>(
  table: Record<K, string>,
  code: string,
): string {
  return code in table ? table[code as K] : code;
}

const labels = () => messagesOf(provisioningLabelMessages);

export const jobStateLabel = (
  state: ProvisioningJobWire["state"] | (string & {}),
): string => labelOf(labels().jobState, state);

export const jobTypeLabel = (
  type: ProvisioningJobWire["jobType"] | (string & {}),
): string => labelOf(labels().jobType, type);

export const blockerLabel = (blocker: ProvisionBlocker): string =>
  labels().blocker[blocker];

export const resourceStatusLabel = (
  status: JobDetailWire["resources"][number]["status"],
): string => labels().resourceStatus[status];

export const costItemLabel = (item: string): string =>
  labelOf(labels().costItem, item);

/** Bốn pha tiến về phía trước, theo thứ tự chạy (§8.1) */
export const PHASES = [
  "NETWORK",
  "CLUSTER",
  "CLUSTER_ACCESS",
  "DOMAINS",
] as const satisfies readonly ProvisioningJobWire["state"][];

export const TERMINAL_STATES: readonly ProvisioningJobWire["state"][] = [
  "DONE",
  "FAILED",
  "COMPENSATION_FAILED",
];

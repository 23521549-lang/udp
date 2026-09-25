import type { ProvisionBlocker } from "@udp/shared-types/provisioning-api";
import type {
  JobDetailWire,
  ProvisioningJobWire,
} from "@udp/shared-types/wire";

/**
 * Chữ hiển thị của provisioning (I37: mã ở máy chủ, câu ở Portal). `Record` theo đúng kiểu
 * dây: thêm một trạng thái hay một lý do chặn mà quên câu là lỗi biên dịch.
 */

export const JOB_STATE_LABEL: Record<ProvisioningJobWire["state"], string> = {
  QUEUED: "Đang chờ worker",
  NETWORK: "Dựng mạng",
  CLUSTER: "Dựng cluster",
  CLUSTER_ACCESS: "Cấp quyền cluster",
  DOMAINS: "Cài domain",
  DONE: "Hoàn tất",
  CANCEL_REQUESTED: "Đang hủy",
  COMPENSATING: "Đang dọn tài nguyên",
  COMPENSATION_FAILED: "Dọn chưa hết tài nguyên",
  FAILED: "Thất bại, đã dọn",
};

/** Bốn pha tiến về phía trước, theo thứ tự chạy (§8.1) */
export const PHASES = [
  "NETWORK",
  "CLUSTER",
  "CLUSTER_ACCESS",
  "DOMAINS",
] as const satisfies readonly ProvisioningJobWire["state"][];

export const BLOCKER_LABEL: Record<ProvisionBlocker, string> = {
  "project-not-draft": "Project đã triển khai hoặc đang triển khai.",
  "job-active": "Đang có một lượt triển khai chạy.",
  "cloud-not-validated":
    "Credential cloud chưa được kiểm. Vào Cài đặt, thẻ Cloud, bấm Kiểm tra credential.",
  "egress-not-configured":
    "Máy chủ UDP chưa cấu hình địa chỉ egress. Báo quản trị hệ thống.",
  "domains-invalid":
    "Cấu hình domain đang lưu không hợp lệ. Sửa ở trang Domain.",
  "orphans-pending":
    "Lượt trước còn tài nguyên chưa dọn được trên cloud. Quản trị cần xử lý trước khi chạy lại.",
};

export const RESOURCE_STATUS_LABEL: Record<
  JobDetailWire["resources"][number]["status"],
  string
> = {
  CREATING: "Đang tạo",
  CREATED: "Đã tạo, chờ sẵn sàng",
  READY: "Sẵn sàng",
  DELETING: "Đang xoá",
  DELETED: "Đã xoá",
  ORPHAN_SUSPECTED: "Nghi mồ côi, cần xem",
};

/** Mục chi phí của adapter; mục lạ hiện nguyên mã thay vì biến mất khỏi tổng */
const COST_ITEM_LABEL: Readonly<Record<string, string>> = {
  "control-plane": "Control plane",
  "nat-gateway": "NAT gateway",
  "load-balancer": "Load balancer",
  nodes: "Node",
};
export const costItemLabel = (item: string): string =>
  COST_ITEM_LABEL[item] ?? item;

export const TERMINAL_STATES: readonly ProvisioningJobWire["state"][] = [
  "DONE",
  "FAILED",
  "COMPENSATION_FAILED",
];

export const usd = (n: number): string => `$${n.toFixed(2)}`;

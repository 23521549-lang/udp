import type { ProvisionBlocker } from "@udp/shared-types/provisioning-api";
import type {
  JobDetailWire,
  ProvisioningJobWire,
} from "@udp/shared-types/wire";
import { defineMessages } from "../../i18n";

/**
 * Chữ hiển thị của provisioning (I37: mã ở máy chủ, câu ở Portal). Bảng theo đúng kiểu dây: thêm một trạng
 * thái hay một lý do chặn mà quên câu là lỗi biên dịch — ở cả hai ngôn ngữ.
 */
export const provisioningLabelMessages = defineMessages({
  vi: {
    jobState: {
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
    } satisfies Record<ProvisioningJobWire["state"], string>,
    jobType: {
      PROVISION: "Dựng hạ tầng",
      TEARDOWN: "Gỡ hạ tầng",
      DOMAIN_APPLY: "Áp domain",
      ENVIRONMENT_APPLY: "Áp environment",
    } satisfies Record<ProvisioningJobWire["jobType"], string>,
    blocker: {
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
    } satisfies Record<ProvisionBlocker, string>,
    resourceStatus: {
      CREATING: "Đang tạo",
      CREATED: "Đã tạo, chờ sẵn sàng",
      READY: "Sẵn sàng",
      DELETING: "Đang xoá",
      DELETED: "Đã xoá",
      ORPHAN_SUSPECTED: "Nghi mồ côi, cần xem",
    } satisfies Record<JobDetailWire["resources"][number]["status"], string>,
    /** Mục chi phí của adapter; mục lạ hiện nguyên mã thay vì biến mất khỏi tổng */
    costItem: {
      "control-plane": "Control plane",
      "nat-gateway": "NAT gateway",
      "load-balancer": "Load balancer",
      nodes: "Node",
    } as Record<string, string>,
  },
  en: {
    jobState: {
      QUEUED: "Waiting for a worker",
      NETWORK: "Building the network",
      CLUSTER: "Building the cluster",
      CLUSTER_ACCESS: "Granting cluster access",
      DOMAINS: "Installing domains",
      DONE: "Done",
      CANCEL_REQUESTED: "Cancelling",
      COMPENSATING: "Cleaning up resources",
      COMPENSATION_FAILED: "Cleanup incomplete",
      FAILED: "Failed, cleaned up",
    },
    jobType: {
      PROVISION: "Provision",
      TEARDOWN: "Tear down",
      DOMAIN_APPLY: "Apply domains",
      ENVIRONMENT_APPLY: "Apply environments",
    },
    blocker: {
      "project-not-draft": "The project is already deployed or deploying.",
      "job-active": "A deployment run is in progress.",
      "cloud-not-validated":
        "The cloud credential has not been validated. Go to Settings, Cloud tab, and click Validate credential.",
      "egress-not-configured":
        "The UDP server has no egress address configured. Contact the system administrator.",
      "domains-invalid":
        "The saved domain configuration is invalid. Fix it on the Domains page.",
      "orphans-pending":
        "The previous run left resources that could not be cleaned up. An administrator must handle them before running again.",
    },
    resourceStatus: {
      CREATING: "Creating",
      CREATED: "Created, waiting to be ready",
      READY: "Ready",
      DELETING: "Deleting",
      DELETED: "Deleted",
      ORPHAN_SUSPECTED: "Suspected orphan, needs attention",
    },
    costItem: {
      "control-plane": "Control plane",
      "nat-gateway": "NAT gateway",
      "load-balancer": "Load balancer",
      nodes: "Nodes",
    },
  },
});

import type { CloudProvider } from "./credential.js";
import type { CreatedResourceKind } from "./cloud.js";

/**
 * [v4.10] Sổ tài nguyên ở dạng DTO thuần (§2.2, ADR-08).
 *
 * `ProvisionedResourceRow` trước v4.10 được DÙNG ở `rebuildLedgerFromCloud` mà chưa
 * từng được định nghĩa ở đâu — tức kiểu trả về của hàm mang mệnh đề trung tâm của C3
 * chỉ là một cái tên trống.
 */

/** Sáu trạng thái của máy trạng thái §4.5; khớp enum `ResourceStatus` của database */
export type ResourceStatus =
  | "CREATING"
  | "CREATED"
  | "READY"
  | "DELETING"
  | "DELETED"
  | "ORPHAN_SUSPECTED";

/**
 * Bốn bước; khớp enum `ProvisionStep`.
 *
 * `K8S_MANAGED` là cách SỔ biểu diễn tài nguyên do Kubernetes sinh (ELB/ENI/EBS).
 * Bảng `provisioned_resources` không có cột boolean nào cho việc đó, nên
 * `CreatedResource.managedByK8s` (kết quả phát hiện từ cloud) và `step` ở đây là hai
 * thứ khác nhau có chủ đích.
 */
export type ProvisionStep = "NETWORK" | "CLUSTER" | "DOMAINS" | "K8S_MANAGED";

/**
 * Một hàng của sổ.
 *
 * Khớp từng cột của bảng với hai ngoại lệ, cả hai có lý lẽ:
 *
 * - **Không có `jobId`.** ADR-08 nói mọi cột suy ra được từ tag **trừ** `job_id`. Cột
 *   đó là NOT NULL với khoá ngoại Restrict, nên điểm crash K10 (mất sạch sổ) phải tách
 *   hai biến thể: K10a nối lại job cũ, K10b tạo một job tổng hợp có đánh dấu tường minh
 *   — để lịch sử mất một cách NHÌN THẤY ĐƯỢC thay vì bị bịa.
 * - **Không có `managedByK8s`.** Trong sổ, tính chất đó là `step = "K8S_MANAGED"`.
 */
export interface ProvisionedResourceRow {
  projectId: string;
  step: ProvisionStep;
  kind: CreatedResourceKind;
  /** `{projectId}:{step}:{kind}:{name}` — chính giá trị của tag `udp.key` */
  idempotencyKey: string;
  /** `null` khi đã ghi ý định nhưng chưa biết id — đây là trạng thái của điểm crash K2/K3 */
  providerId: string | null;
  provider: CloudProvider;
  region: string;
  status: ResourceStatus;
}

/**
 * Tên tám trường của `ProvisionedResourceRow`, ở dạng chạy được.
 *
 * Kiểu TypeScript biến mất lúc chạy, nên "DTO khớp từng cột của bảng" sẽ là một câu
 * trong chú thích chứ không phải một phép kiểm. Hằng số này để `@udp/design-lint` đối
 * chiếu với cột thật của `provisioned_resources` — trừ `job_id` (ADR-08 nói nó không suy
 * ra được từ tag) và trừ mọi cột không thuộc hợp đồng dựng lại sổ.
 */
export const PROVISIONED_RESOURCE_ROW_FIELDS: readonly string[] = [
  "projectId",
  "step",
  "kind",
  "idempotencyKey",
  "providerId",
  "provider",
  "region",
  "status",
];

/** Cột của bảng mà DTO cố tình KHÔNG mang, mỗi cái có lý lẽ ở chú thích trên */
export const PROVISIONED_RESOURCE_ROW_OMITTED: readonly string[] = [
  "id",
  "job_id",
  "created_at",
  "updated_at",
];

/**
 * Chín cạnh hợp lệ của máy trạng thái §4.5.
 *
 * Hai cạnh cuối là bổ sung của v4.10: bản v4.9 có đúng 7 cạnh và **không có**
 * `CREATING → DELETING` lẫn `CREATED → DELETING`, nên compensation một hàng chưa
 * `READY` là bất hợp pháp — mà đó là ca thường xuyên nhất sau một lần crash.
 *
 * `ORPHAN_SUSPECTED` cố tình KHÔNG có cạnh ra: nó là trạng thái cần người xem, và
 * `GET /admin/orphan-resources` hiển thị nó kèm chi phí đang chạy theo USD/giờ. Vì
 * vậy nó cũng KHÔNG được nhận cạnh vào từ một lỗi TẠM như `indeterminate`.
 */
export const LEDGER_TRANSITIONS: readonly (readonly [
  ResourceStatus | "ABSENT",
  ResourceStatus,
])[] = [
  ["ABSENT", "CREATING"],
  ["CREATING", "CREATED"],
  ["CREATED", "READY"],
  ["READY", "DELETING"],
  ["CREATING", "DELETING"],
  ["CREATED", "DELETING"],
  ["DELETING", "DELETED"],
  ["DELETING", "ORPHAN_SUSPECTED"],
  ["CREATING", "ORPHAN_SUSPECTED"],
];

/** Cạnh này có trong sơ đồ §4.5 không? Sổ từ chối mọi cạnh ngoài danh sách trên */
export function isLedgerTransitionAllowed(
  from: ResourceStatus | "ABSENT",
  to: ResourceStatus,
): boolean {
  return LEDGER_TRANSITIONS.some(([a, b]) => a === from && b === to);
}

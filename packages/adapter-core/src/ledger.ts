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
/** Bản chạy được của `ResourceStatus`, để phép kiểm gương so được với enum database */
export const RESOURCE_STATUSES: readonly ResourceStatus[] = [
  "CREATING",
  "CREATED",
  "READY",
  "DELETING",
  "DELETED",
  "ORPHAN_SUSPECTED",
];

/** Bản chạy được của `ProvisionStep` — cùng lý do */
export const PROVISION_STEPS: readonly ProvisionStep[] = [
  "NETWORK",
  "CLUSTER",
  "DOMAINS",
  "K8S_MANAGED",
];

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
 * Mười một cạnh hợp lệ của máy trạng thái §4.5.
 *
 * Bốn cạnh là bổ sung của v4.10; bản v4.9 có đúng 7 cạnh:
 *
 *  - `CREATING → DELETING` và `CREATED → DELETING`: không có chúng thì compensation một
 *    hàng chưa `READY` là bất hợp pháp — mà đó là ca thường xuyên nhất sau một lần crash.
 *  - `READY → CREATING` và `CREATED → CREATING`: hàng K7 của bảng khôi phục nói "khi resume
 *    tạo ⇒ tạo lại", nhưng v4.9 không có cạnh nào cho việc đó. Không có nó, sổ giữ mãi
 *    `provider_id` của thứ khách đã xoá, và teardown sau đó xoá một id không tồn tại trong
 *    khi tài nguyên THẬT rò — đúng loại lỗi chỉ lộ ra khi hoá đơn về.
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
  ["READY", "CREATING"],
  ["CREATED", "CREATING"],
  ["CREATING", "DELETING"],
  ["CREATED", "DELETING"],
  ["DELETING", "DELETED"],
  ["DELETING", "ORPHAN_SUSPECTED"],
  ["CREATING", "ORPHAN_SUSPECTED"],
];

/** Cạnh này có trong sơ đồ §4.5 không? Sổ từ chối mọi cạnh ngoài danh sách trên */
/**
 * Hai lỗi của sổ, ở ĐÂY chứ không ở `./testing`.
 *
 * Trước P9 chúng nạm trong `in-memory-ledger.ts`, tức một hiện thục sổ DÙNG THẬT muốn
 * ném đúng loại lỗi thì phải import từ subpath `./testing`. Đó là một mũi chỉ sai
 * hướng: hình dạng lỗi là phần của **hợp đồng**, không phải của bản mô phỏng — và
 * một dấu vết `@udp/adapter-core/testing` trong mã sản phẩm là thứ đọc mã sẽ thấy
 * ngược mắt nhưng khó sửa về sau.
 */
export class LedgerTransitionError extends Error {
  readonly code = "LEDGER_TRANSITION_INVALID";
  constructor(
    readonly idempotencyKey: string,
    readonly from: ResourceStatus,
    readonly to: ResourceStatus,
  ) {
    super(`không có cạnh ${from} → ${to} cho ${idempotencyKey}`);
    this.name = "LedgerTransitionError";
  }
}

/** Gọi `mark*` trên một khóa không có hàng — luôn là lỗi, không bao giờ là no-op */
export class LedgerMissingRowError extends Error {
  readonly code = "LEDGER_ROW_MISSING";
  constructor(readonly idempotencyKey: string) {
    super(`sổ không có hàng nào cho ${idempotencyKey}`);
    this.name = "LedgerMissingRowError";
  }
}

/**
 * Mọi trạng thái đi được TỚI `to`, suy từ `LEDGER_TRANSITIONS`.
 *
 * Hiện thục Postgres cưỡng chế máy trạng thái bằng một `UPDATE ... WHERE status IN
 * (...)` — một câu, không đọc-rồi-ghi, nên hai worker không chen vào giữa được. Danh
 * sách `IN` đó phải ĐỢC SUY từ bảng cạnh, không viết tay: một cạnh mới thêm vào §4.5
 * mà danh sách viết tay không biết là một lỗi im lặng — câu UPDATE đổi 0 hàng và
 * hiện thục báo "không có cạnh đó" cho đúng một cạnh vừa được thêm.
 *
 * `ABSENT` BỊ Bỏ KHỎĐI kết quả, và đó không phải tiện lợi. Nó là một **giả trạng
 * thái** — kiểu `ResourceStatus` không có nó, và enum `resource_status` của Postgres
 * cũng không. "Không có hàng" không phải một giá trị của cột `status`, nên nó không
 * vào được một `WHERE status IN (...)`; để sót thì câu đó chỉ vỡ lúc chạy với một
 * lỗi enum khó đọc. Cạnh `ABSENT → CREATING` có đường riêng: nó là một `INSERT`, và
 * `idempotency_key UNIQUE` là thứ cưỡng chế nó.
 */
export function allowedSourcesOf(
  to: ResourceStatus,
): readonly ResourceStatus[] {
  return LEDGER_TRANSITIONS.filter(
    ([src, dst]) => dst === to && src !== "ABSENT",
  ).map(([src]) => src as ResourceStatus);
}

export function isLedgerTransitionAllowed(
  from: ResourceStatus | "ABSENT",
  to: ResourceStatus,
): boolean {
  return LEDGER_TRANSITIONS.some(([a, b]) => a === from && b === to);
}

import type { CreatedResourceKind } from "../cloud.js";
import type { CloudProvider } from "../credential.js";
import type {
  ProvisionedResourceRow,
  ProvisionStep,
  ResourceStatus,
} from "../ledger.js";

/**
 * [v4.10] Ba cổng mà `CloudAdapterRunner` chạy trên (ADR-07, ADR-08).
 *
 * Runner là một lõi hexagonal: nó không biết sổ nằm ở Postgres hay trong bộ nhớ, không
 * biết `version` được cưỡng chế ở đâu, và không biết ai đang xem tiến trình. Nhờ vậy
 * lưới khôi phục 130 ô chạy được **không cần database**, còn năm ô cần `version` thật
 * thì đổi một hiện thực cổng là xong — không sửa một dòng nào của runner.
 */

/** Ghi ý định trước khi hành động (ADR-08 quy tắc 1) */
export interface LedgerIntent {
  projectId: string;
  step: ProvisionStep;
  kind: CreatedResourceKind;
  idempotencyKey: string;
  provider: CloudProvider;
  region: string;
}

/**
 * Sổ tài nguyên.
 *
 * Nó là *gợi ý về thứ tự* để chạy compensation ngược, và là nơi ghi ý định trước khi
 * hành động. Nó **không** được tin khi lệch với cloud.
 *
 * Mọi hiện thực phải qua cùng một bộ `LEDGER_CONTRACT_CHECKS` — không có nó thì bản
 * trong bộ nhớ và bản Postgres lệch ngữ nghĩa, và tầng in-process của lưới mất giá trị.
 */
export interface Ledger {
  /** `ABSENT → CREATING`. Ném nếu khoá đã tồn tại với trạng thái không cho phép */
  intend(intent: LedgerIntent): Promise<void>;
  /** `CREATING → CREATED`, gắn `provider_id` vào hàng ĐÃ CÓ (đây là cách K3 được đóng) */
  markCreated(idempotencyKey: string, providerId: string): Promise<void>;
  markReady(idempotencyKey: string): Promise<void>;
  markDeleting(idempotencyKey: string): Promise<void>;
  markDeleted(idempotencyKey: string): Promise<void>;
  markOrphanSuspected(idempotencyKey: string, reason: string): Promise<void>;
  byKey(idempotencyKey: string): Promise<ProvisionedResourceRow | null>;
  /** Theo thứ tự chèn — compensation chạy ngược danh sách này */
  rowsOf(projectId: string): Promise<ProvisionedResourceRow[]>;
}

/**
 * Chặn một worker đã mất lease khỏi tác động tiếp.
 *
 * Điểm crash K9: worker cũ bị chặn ở lần GHI kế tiếp vì `version` đã đổi. Cổng này là
 * chỗ duy nhất runner hỏi "tôi còn được phép không", và runner gọi nó ở sáu chốt.
 */
export interface Fence {
  /** Ném nếu lease đã mất. Runner KHÔNG bắt lỗi này — nó là lỗi chí tử */
  assert(): Promise<void>;
}

/** Các pha của runner; cũng là tập điểm có thể tiêm crash (QĐ-14) */
export type RunnerPhase =
  | "before-lookup"
  | "after-lookup"
  | "before-intend"
  | "after-intend"
  | "before-create"
  | "after-create-commit"
  | "after-create-respond"
  | "before-mark-created"
  | "after-mark-created"
  | "before-wait-ready"
  | "after-wait-ready"
  | "before-delete"
  | "after-delete";

/**
 * Quan sát tiến trình.
 *
 * Đây là **cổng của mã sản phẩm**, không phải một hook chỉ tồn tại cho test: người dùng
 * thật là SSE progress của §8.1 và histogram của E2. Bộ test chỉ cắm một hiện thực khác
 * ném `SimulatedCrash` ở đúng pha — nên lưới khôi phục không đòi thêm một dòng mã test
 * nào trong runner.
 */
export interface RunnerObserver {
  onPhase(phase: RunnerPhase, stepName: string): Promise<void> | void;
}

/** Không làm gì — mặc định của production khi không ai xem */
export const silentObserver: RunnerObserver = {
  onPhase() {
    /* không làm gì */
  },
};

/** Một bản ghi trạng thái để test khẳng định hội tụ */
export interface LedgerSnapshot {
  rows: ProvisionedResourceRow[];
  /** Có hàng nào còn kẹt ở `CREATING` hay `CREATED` không (yêu cầu (b) của I31) */
  stuck: ProvisionedResourceRow[];
}

/** Hai trạng thái mà I31 yêu cầu mọi hàng phải hội tụ về */
export const TERMINAL_STATUSES: readonly ResourceStatus[] = [
  "READY",
  "DELETED",
];

export function snapshotOf(rows: ProvisionedResourceRow[]): LedgerSnapshot {
  return {
    rows,
    stuck: rows.filter(
      (r) =>
        !TERMINAL_STATUSES.includes(r.status) &&
        r.status !== "ORPHAN_SUSPECTED",
    ),
  };
}

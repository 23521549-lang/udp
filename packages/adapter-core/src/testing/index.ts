import type { CreatedResource, CreatedResourceKind } from "../cloud.js";

/**
 * [v4.10] Cổng của hiện thực giả tất định (§13.2).
 *
 * `CloudControl` là **cửa hậu tác động ngoài luồng**: xoá tag, xoá tài nguyên, bơm lỗi.
 * Nó là một cổng chứ không phải một tiện ích của cloud mô phỏng, vì đó là điều kiện để
 * bộ hợp đồng là HỢP ĐỒNG: khi trả nợ `I31-localstack`, `control` được hiện thực bằng
 * SDK cloud thật và **thân test không đổi một dòng**.
 */

/** Ba hạng lỗi mà adapter phải phân biệt — trộn chúng lại là một chế độ hỏng thật */
export type InjectedFaultClass =
  | "throttle"
  | "transient5xx"
  | "permanent4xx"
  /** Cloud đã ghi state nhưng client không nhận được phản hồi — đây là điểm crash K3 */
  | "commit-then-timeout";

/** Một lời gọi đã xảy ra, theo thứ tự — oracle của mọi phép kiểm về thứ tự */
export interface CloudCallRecord {
  at: number;
  verb: string;
  kind: CreatedResourceKind | "unknown";
  /** Danh tính worker, để K9 khẳng định "0 lời gọi ghi sau khi mất lease" */
  workerId: string;
  idempotencyKey?: string;
}

export interface CloudControl {
  /** Khách xoá tag `udp.key` ngoài luồng — điểm crash K8 */
  removeTag(resourceId: string, tagKey: string): Promise<void>;
  /** Khách xoá tài nguyên ngoài luồng — điểm crash K7 */
  deleteOutOfBand(resourceId: string): Promise<void>;
  /** Bơm lỗi cho lời gọi thứ `n` của một `kind` */
  failNthCall(
    kind: CreatedResourceKind,
    n: number,
    fault: InjectedFaultClass,
  ): Promise<void>;
  /**
   * Cửa sổ lan truyền tag: `lookup` theo tag trả `indeterminate` trong `ms` đầu sau
   * `create`. Đây là nguồn lỗi "tạo trùng" thật trên AWS, và là ô `K2b` của §4.5.
   */
  setTagPropagationDelay(ms: number): Promise<void>;
  /** Mọi thứ đang có trên "cloud", kể cả nhiễu */
  listAll(): Promise<CreatedResource[]>;
  /** Nhật ký lời gọi có thứ tự */
  calls(): Promise<CloudCallRecord[]>;
  /**
   * Bơm bốn loại nhiễu bắt buộc (O-2).
   *
   * Nó ở đây chứ không ở một tiện ích riêng vì nó CŨNG là tác động ngoài luồng: tài nguyên
   * của project khác, tài nguyên khách tự tạo, và tài nguyên ở region khác đều tồn tại
   * trong một tài khoản cloud thật mà không ai bơm chúng.
   */
  seedNoise(projectId: string, owner: string): Promise<void>;
  /** Tạo một tài nguyên do "Kubernetes" sinh, giữ tham chiếu VPC (S-10) */
  seedK8sManaged(args: {
    kind: "k8s-loadbalancer" | "k8s-eni" | "k8s-volume";
    clusterName: string;
    attachedTo: string;
  }): Promise<CreatedResource>;
}

/**
 * Hằng số kỳ vọng **viết tay**.
 *
 * Không suy từ `steps.length` của chính adapter: suy từ hiện thực là một tautology —
 * một adapter khai THIẾU một step vẫn xanh vì kỳ vọng tự co lại theo nó.
 */
export interface CloudFixture {
  /** Tổng số tài nguyên một lần provision đầy đủ phải tạo */
  expectedResourceCount: number;
  /** Bảng `kind → số lượng`, để một step biến mất là một test đỏ chứ không phải một dòng diff */
  expectedByKind: Readonly<Partial<Record<CreatedResourceKind, number>>>;
  /** Số step của fixture — `CRASH_POINTS.length` KHÔNG chặn được việc nó tụt từ 13 xuống 1 */
  expectedStepCount: number;
}

export {
  InMemoryLedger,
} from "./in-memory-ledger.js";

export {
  KINDS_WITH_IDEMPOTENCY_TOKEN,
  KINDS_WITHOUT_CREATE_TAGS,
  SIM_DEPENDENCY_VIOLATION,
  SIM_NOT_FOUND,
  SIM_PERMANENT,
  SIM_SEPARATE_TAGGING_REJECTED,
  SIM_THROTTLE,
  SIM_TRANSIENT,
  SimCloud,
  SimCloudError,
} from "./sim-cloud.js";
export type { SimCloudOptions } from "./sim-cloud.js";

export {
  CLOUD_FIXTURE,
  CONSISTENCY_VARIANTS,
  CRASH_POINTS,
  EXPECTED_BY_KIND,
  EXPECTED_RESOURCE_COUNT,
  EXPECTED_STEP_COUNT,
  FIXTURE_STEPS,
  K10_VARIANTS,
} from "./fixture.js";

export {
  createSimAdapter,
  idempotencyKeyOf,
  parseIdempotencyKey,
  simTags,
} from "./sim-adapter.js";
export type { SimAdapterOptions } from "./sim-adapter.js";

/**
 * MOT hien thuc gia duy nhat cua `ClusterAccess` (QD-27) — dung o P11 va P18.
 *
 * Xem chu thich trong `fake-cluster.ts` ve vi sao "mot" la phan quan trong.
 */
export {
  ClusterIdentityDeniedError,
  createFakeClusterAccess,
  refKey,
} from "./fake-cluster.js";
export type {
  FakeCall,
  FakeClusterAccess,
  FakeClusterOptions,
} from "./fake-cluster.js";

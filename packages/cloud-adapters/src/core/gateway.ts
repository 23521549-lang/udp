import type {
  CloudProvider,
  ClusterInfo,
  CreatedResource,
  CreatedResourceKind,
} from "@udp/adapter-core";

/**
 * Cổng trung tính giữa lõi điều phối và MỘT cloud (Plan #26 QĐ-2).
 *
 * Ba cloud khác nhau ở API nhưng giống nhau ở mọi luật khó (ghi sổ trước, lookup ba trạng
 * thái, thứ tự teardown, dựng lại sổ từ tag). Cổng gói phần khác nhau; lõi giữ phần giống
 * nhau — một lần, không ba lần.
 *
 * **Hợp đồng lỗi của cổng:** mọi phương thức chỉ ném `GatewayError`. Lỗi gốc của SDK được
 * PHÂN LOẠI và BỎ ĐI ngay trong cổng: AWS SDK v3 để credential trong `err.config` và
 * `err.$metadata`, nên giữ `cause` gốc là mang bí mật đi qua mọi tầng phía trên (§4.2
 * "Không adapter nào được ghi log payload credential").
 */

export type GatewayErrorClass =
  /** Tài nguyên không tồn tại — với `remove` đây là THÀNH CÔNG (idempotent) */
  | "not-found"
  /** Bị giới hạn tốc độ — thử lại sau là đúng */
  | "throttled"
  /** Lỗi tạm của cloud (5xx, mạng) */
  | "transient"
  /** Còn tài nguyên phụ thuộc (DependencyViolation) — xoá sau */
  | "dependency"
  /** Tham số sai — thử lại vô ích */
  | "permanent"
  /** Credential thiếu quyền hoặc không hợp lệ */
  | "permission"
  /** API không cho gắn tag lúc tạo và từ chối gắn riêng */
  | "separate-tagging"
  /** Cấu hình phía UDP thiếu (khoá ký OIDC, identity nền) */
  | "configuration";

export class GatewayError extends Error {
  constructor(
    readonly errorClass: GatewayErrorClass,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export const isGatewayError = (e: unknown): e is GatewayError =>
  e instanceof GatewayError;

/** Lỗi bất kỳ ⇒ một câu an toàn để đưa lên `AdapterResult.message` */
export function safeMessage(e: unknown): string {
  return isGatewayError(e)
    ? `${e.errorClass}: ${e.message}`
    : "lỗi không phân loại được từ cloud";
}

export interface CreateRequest {
  kind: CreatedResourceKind;
  /** Tên logic trong kế hoạch (`vpc`, `subnet-a`) — nằm trong khoá idempotency */
  name: string;
  /** Tên vật lý trên cloud, tất định theo project — đường tra cứu dự phòng */
  physicalName: string;
  idempotencyKey: string;
  /** Tham số riêng của cloud cho kind này — do kế hoạch dựng */
  spec: unknown;
  /** Tag dạng CHUẨN (`udp.project`, …); cổng tự mã hoá theo luật của cloud */
  tags: Readonly<Record<string, string>>;
  /** Tài nguyên đã tạo của các step đứng trước, theo tên logic */
  parents: Readonly<Record<string, CreatedResource>>;
}

export interface PermissionCheck {
  missing: string[];
  confidence: "exact" | "heuristic";
  quotaWarnings: string[];
}

export interface CloudGateway {
  readonly provider: CloudProvider;
  readonly region: string;
  /** Định danh của credential đang dùng — phép kiểm credential rẻ nhất có thể */
  whoAmI(): Promise<string>;
  checkPermissions(required: readonly string[]): Promise<PermissionCheck>;
  create(req: CreateRequest): Promise<CreatedResource>;
  /** Tra theo tag dạng CHUẨN; kết quả mang tag đã giải mã về dạng chuẩn */
  findByTag(key: string, value: string): Promise<CreatedResource[]>;
  findByName(
    kind: CreatedResourceKind,
    physicalName: string,
  ): Promise<CreatedResource | null>;
  describe(
    kind: CreatedResourceKind,
    id: string,
  ): Promise<CreatedResource | null>;
  isReady(resource: CreatedResource): Promise<boolean>;
  remove(resource: CreatedResource): Promise<"deleted" | "not-found">;
  /** Mọi tài nguyên mang tag project — ĐỦ mọi trang; lỗi giữa chừng là ném, không trả thiếu */
  listByProject(projectId: string): Promise<CreatedResource[]>;
  clusterInfo(
    clusterId: string,
  ): Promise<Omit<ClusterInfo, "controlPlaneServiceAccounts">>;
  kubeToken(cluster: ClusterInfo): Promise<{ token: string; expiresAt: Date }>;
}

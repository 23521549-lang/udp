import type { AdapterResult } from "@udp/shared-types";
import type { CloudProvider, ResolvedCredential } from "./credential.js";
import type { ProvisionedResourceRow } from "./ledger.js";

/**
 * [v4.10] Hợp đồng của Cloud Adapter (§4.1, §4.2) — mười phương thức, không phải sáu.
 *
 * ADR-07: adapter KHÔNG tự chạy vòng lặp tạo tài nguyên. Nó **khai báo** một danh sách
 * `ResourceStep` có thứ tự; `CloudAdapterRunner` dùng chung chạy các step, ghi sổ TRƯỚC
 * mỗi `create()`, và chạy `delete()` theo thứ tự ngược khi compensation.
 */

/** Trần tài nguyên của project — adapter PHẢI tự kiểm trước khi gọi SDK cloud (§4.4 lớp 1) */
export interface ResourceQuota {
  maxNodes: number;
  maxNodeSize: "small" | "medium" | "large";
  maxDatabases: number;
  maxStorageGb: number;
  /**
   * LB là nguồn chi phí ẩn lớn thứ hai sau NAT.
   *
   * Trong phạm vi Plan #24, adapter chỉ cưỡng chế được LB do CHÍNH NÓ tạo. Đếm cả LB
   * do domain adapter hay ứng dụng sinh ra cần một admission webhook trong cluster —
   * xem sổ nợ `quota-lb-webhook`.
   */
  maxLoadBalancers: number;
}

/**
 * Danh sách `kind` đủ.
 *
 * Bốn giá trị `k8s-*` là tài nguyên do Kubernetes tạo ra: adapter không gọi API nào để
 * tạo chúng, nhưng **phải dọn** chúng, vì chúng giữ tham chiếu tới VPC và làm
 * `DeleteVpc` thất bại vĩnh viễn trong khi vẫn tính tiền.
 */
export type CreatedResourceKind =
  | "vpc"
  | "subnet"
  | "internet-gateway"
  | "nat-gateway"
  | "elastic-ip"
  | "route-table"
  | "security-group"
  | "firewall-rule"
  | "cloud-router"
  | "nsg"
  | "iam-role"
  | "iam-policy"
  | "oidc-provider"
  | "service-account"
  | "managed-identity"
  | "cluster"
  | "nodegroup"
  | "addon"
  | "controlplane-sa"
  | "k8s-loadbalancer"
  | "k8s-volume"
  | "k8s-eni";

/**
 * Bốn khoá tag BẮT BUỘC, cộng `udp.ttl` CHỈ khi project có `expires_at`.
 *
 * Đòi đúng năm khoá làm một project `expiry_action = WARN` không đặt `expires_at` —
 * mặc định của BYOC, hoàn toàn hợp lệ — hoặc đỏ, hoặc buộc hiện thực gắn một tag bịa.
 */
export const REQUIRED_TAG_KEYS: readonly string[] = [
  "udp.project",
  "udp.key",
  "udp.owner",
  "udp.managed",
];

/** Tag có điều kiện: gắn khi và chỉ khi project có mốc hết hạn */
export const CONDITIONAL_TTL_TAG_KEY = "udp.ttl";

/** Tập khoá tag mong đợi cho một project cụ thể */
export function expectedTagKeys(hasExpiresAt: boolean): readonly string[] {
  return hasExpiresAt
    ? [...REQUIRED_TAG_KEYS, CONDITIONAL_TTL_TAG_KEY]
    : REQUIRED_TAG_KEYS;
}

/**
 * Một tài nguyên đã tồn tại trên cloud.
 *
 * `tags` là tag **đọc lại từ cloud**, không phải tag ta định gắn — và nó BẮT BUỘC.
 * Trước v4.10 trường này không có, trong khi `listTaggedResources()` trả
 * `CreatedResource[]` và là đầu vào DUY NHẤT của `rebuildLedgerFromCloud`, mà hàm đó
 * phải đọc `udp.key` của từng tài nguyên để dựng lại hàng sổ. Không có tag thì mệnh đề
 * trung tâm của C3 không hiện thực được, và cũng không lọc được tài nguyên của project
 * khác trong cùng tài khoản.
 */
export interface CreatedResource {
  kind: CreatedResourceKind;
  id: string;
  provider: CloudProvider;
  region: string;
  createdAt: string;
  tags: Readonly<Record<string, string>>;
  /** Phát hiện qua tag `kubernetes.io/cluster/*`. Trong SỔ, tính chất này là `step` */
  managedByK8s?: boolean;
}

/**
 * Kết quả tra cứu — BA trạng thái.
 *
 * `null` không phân biệt được "thật sự không có" với "không tra được". Với tagging API
 * nhất quán cuối, một tag vừa gắn có thể chưa thấy trong vài giây; runner đọc `null` sẽ
 * `create()` lần hai và **tạo trùng** — đúng chế độ hỏng mà điểm crash K3 sinh ra để chặn.
 */
export type LookupOutcome =
  | { kind: "found"; resource: CreatedResource }
  | { kind: "absent" }
  | { kind: "indeterminate"; reason: string };

/** Một bước tạo tài nguyên; runner chung điều phối và ghi sổ (ADR-07) */
export interface ResourceStep {
  kind: CreatedResourceKind;
  /** `"vpc"`, `"subnet-a"`, `"nodegroup-default"` — cũng là khoá của `prior` */
  name: string;
  /** `{projectId}:{step}:{kind}:{name}` */
  idempotencyKey: string;
  /** Đường tra cứu CHÍNH: theo tag `udp.key`. Chạy TRƯỚC mọi `create()` (ADR-08 quy tắc 2) */
  lookup(cred: ResolvedCredential): Promise<LookupOutcome>;
  /**
   * Đường tra cứu DỰ PHÒNG khi khách đã xoá tag nhưng sổ còn id (điểm crash K8).
   *
   * `absent` nghĩa là tài nguyên **thật sự không còn** — sự phân biệt đó nay nằm trong
   * KIỂU, không chỉ trong một câu chú thích.
   */
  lookupById(
    cred: ResolvedCredential,
    providerId: string,
  ): Promise<LookupOutcome>;
  /** Adapter khai mình dùng đường nào; bộ hợp đồng kiểm đúng đường đó hoạt động */
  readonly lookupBy: "tag" | "deterministic-name";
  /**
   * Khoá của `prior` là `name` của một step ĐỨNG TRƯỚC trong cùng danh sách.
   *
   * Đây là cách `clusterSteps(params, network)` nối hai bước, nên nó là hợp đồng chứ
   * không phải chi tiết cài đặt.
   */
  create(
    cred: ResolvedCredential,
    prior: Readonly<Record<string, CreatedResource>>,
  ): Promise<CreatedResource>;
  /** Poll có timeout. Chỉ `READY` là xong — trả sớm ở `CREATED` làm K4 sai âm thầm */
  waitReady(cred: ResolvedCredential, r: CreatedResource): Promise<void>;
  /** NOT_FOUND = thành công; compensation chạy lại phải idempotent */
  delete(cred: ResolvedCredential, r: CreatedResource): Promise<void>;
}

export interface ProvisionNetworkParams {
  projectId: string;
  networkName: string;
  cidrBlock: string;
  region: string;
  quota: ResourceQuota;
  idempotencyKey: string;
  tags: Record<string, string>;
  controlPlaneCidrs: string[];
}

export interface NetworkInfo {
  networkId: string;
  networkName: string;
  cidrBlock: string;
}

export interface ProvisionClusterParams {
  projectId: string;
  clusterName: string;
  nodeSize: "small" | "medium" | "large";
  nodeCount: number;
  /** Adapter PHẢI reject nếu vượt trần, TRƯỚC khi gọi SDK cloud */
  quota: ResourceQuota;
  region: string;
  idempotencyKey: string;
  tags: Record<string, string>;
  /** Địa chỉ egress của UDP, để giới hạn API endpoint public (ADR-06) */
  controlPlaneCidrs: string[];
}

export interface ClusterInfo {
  clusterId: string;
  clusterName: string;
  apiEndpoint: string;
  /** CA của API server */
  caData: string;
  status: "PROVISIONING" | "READY" | "ERROR" | "DELETING";
  /** Ba SA có ClusterRole rời nhau (§12.2) — không phải một */
  controlPlaneServiceAccounts?: {
    workload: string;
    traffic: string;
    tooling: string;
  };
}

export interface PreflightReport {
  ok: boolean;
  /**
   * `exact` khi có API mô phỏng (AWS SimulatePrincipalPolicy, GCP testIamPermissions);
   * `heuristic` khi phải tự match wildcard phía client (Azure).
   *
   * Khai `exact` mà thực chất đoán là một phép kiểm đỏ: §4.2 phân biệt hai mức này để
   * trung thực, không phải để trang trí.
   */
  confidence: "exact" | "heuristic";
  missingPermissions: string[];
  quotaWarnings: string[];
  docUrl: string;
}

export interface CostEstimate {
  monthlyUsd: number;
  /** PHẢI có `control-plane`, `nat-gateway`, `load-balancer` — ba mục hay bị bỏ sót nhất */
  breakdown: { item: string; monthlyUsd: number }[];
  isEstimate: boolean;
  /** Ngày của bảng giá tĩnh */
  pricingAsOf: string;
}

/** Mười phương thức. Đếm lại từ §4.2, và bộ hợp đồng đối chiếu con số này với tài liệu */
export interface CloudAdapter {
  readonly providerId: CloudProvider;

  validateCredential(
    credential: ResolvedCredential,
  ): Promise<AdapterResult<{ valid: boolean; reason?: string }>>;

  preflightPermissions(
    credential: ResolvedCredential,
  ): Promise<AdapterResult<PreflightReport>>;

  estimateCost(
    params: ProvisionClusterParams,
  ): Promise<AdapterResult<CostEstimate>>;

  networkSteps(params: ProvisionNetworkParams): ResourceStep[];
  clusterSteps(
    params: ProvisionClusterParams,
    network: NetworkInfo,
  ): ResourceStep[];

  getClusterStatus(
    credential: ResolvedCredential,
    clusterId: string,
  ): Promise<AdapterResult<ClusterInfo>>;

  getKubeAuthToken(
    credential: ResolvedCredential,
    cluster: ClusterInfo,
  ): Promise<AdapterResult<{ token: string; expiresAt: Date }>>;

  listTaggedResources(
    credential: ResolvedCredential,
    projectId: string,
  ): Promise<AdapterResult<CreatedResource[]>>;

  /**
   * Dựng lại TOÀN BỘ sổ của một project chỉ từ tag trên tài nguyên, **không đọc gì từ
   * database**. Nếu hàm này đúng thì sổ của UDP là cache dựng lại được, không phải nguồn
   * sự thật.
   *
   * Quét tag THẤT BẠI không phải là "cloud rỗng": trả `status: "FAILED"` và runner
   * **không** reconcile. Coi một lần quét lỗi là "không có gì trên cloud" sẽ tạo lại toàn
   * bộ hạ tầng của khách — một lỗi tiêu tiền thật trong tài khoản người khác.
   */
  rebuildLedgerFromCloud(
    credential: ResolvedCredential,
    projectId: string,
  ): Promise<
    AdapterResult<{
      rows: ProvisionedResourceRow[];
      unmatched: CreatedResource[];
    }>
  >;

  /**
   * Teardown theo đúng những gì ĐÃ TẠO, theo thứ tự ngược, idempotent với tài nguyên
   * đã biến mất. Trước khi xoá network PHẢI xoá tài nguyên `k8s-*` và **chờ** chúng
   * biến mất — nếu không `DeleteVpc` thất bại vĩnh viễn và tiếp tục tính tiền.
   */
  teardown(
    credential: ResolvedCredential,
    resources: CreatedResource[],
  ): Promise<AdapterResult<{ deleted: string[]; failed: string[] }>>;
}

/** Mười tên phương thức, để test đối chiếu với §4.2 của tài liệu */
export const CLOUD_ADAPTER_METHODS: readonly string[] = [
  "validateCredential",
  "preflightPermissions",
  "estimateCost",
  "networkSteps",
  "clusterSteps",
  "getClusterStatus",
  "getKubeAuthToken",
  "listTaggedResources",
  "rebuildLedgerFromCloud",
  "teardown",
];

/** Thứ tự teardown cố định, chín bậc (§4.2) */
export const TEARDOWN_ORDER: readonly string[] = [
  "k8s-managed",
  "wait-k8s-gone",
  "addon",
  "nodegroup",
  "cluster",
  "oidc-iam",
  "nat",
  "subnet-route",
  "vpc",
];

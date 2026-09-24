import type { DomainType } from "@udp/config/domains";
import type {
  AdapterResult,
  CapabilityBinding,
  CapabilityDeclaration,
  CapabilityId,
} from "@udp/shared-types";
import type { ZodType } from "zod";
import type { ResourceQuota } from "./cloud.js";
import { readOnlyAccess } from "./cluster.js";
import type {
  ClusterAccess,
  KubernetesClient,
  ReadOnlyClusterAccess,
} from "./cluster.js";

/**
 * [v4.10] Hợp đồng của Domain Adapter (§5.2) — **bảy** phương thức và **sáu** thuộc tính.
 *
 * Con số đó được đếm lại từ chính §5.2 (`deploy`, `configure`, `upgrade`, `detectDrift`,
 * `onDependencyChanged`, `healthcheck`, `teardown`), vì một bản nháp trước của plan này
 * ghi "tám phương thức" và chính phép kiểm đối chiếu tài liệu sẽ đỏ vì con số đó.
 */

export interface DomainToolConfig {
  [key: string]: unknown;
}

/** Bối cảnh đầy đủ mà adapter cần — thay cho việc chỉ truyền `ClusterInfo` */
export interface DomainAdapterContext {
  /** Client K8s đã xác thực bằng bound SA token; adapter KHÔNG tự lấy kubeconfig */
  k8s: ClusterAccess;
  /** Với `scope = "namespace"`: environment đích. Với `scope = "cluster"`: vắng */
  environment?: {
    id: string;
    name: string;
    k8sNamespace: string;
    isProduction: boolean;
  };
  /** Namespace hệ thống cho tooling cluster-scoped */
  systemNamespace: string;
  region: string;
  quota: ResourceQuota;
  /** Giá trị mà adapter khác đã cung cấp — đọc từ bảng, không từ bộ nhớ worker */
  resolved: Readonly<Partial<Record<CapabilityId, CapabilityBinding>>>;
  tags: Readonly<Record<string, string>>;
  /** Ghi log tiến trình để Portal stream về cho người dùng */
  progress: (message: string) => void;
  /**
   * Egress guard chống SSRF (§12 T11).
   *
   * MỌI lời gọi HTTP ra ngoài của adapter đi qua đây. Một lint rule chặn `fetch` toàn
   * cục trong thư mục adapter, và bộ hợp đồng thay `globalThis.fetch` bằng một hàm ném
   * lỗi — nên lách được thì test đỏ.
   */
  fetch: typeof fetch;
}

/**
 * [v4.10] Bối cảnh KHÔNG GHI ĐƯỢC - thứ mà `detectDrift` nhận.
 *
 * §4.6 nói rõ lý do tách verb đọc khỏi verb ghi: *"cho hàm quét drift nhận
 * `ReadOnlyKubernetesClient` biến điều đó thành tính chất của KIỂU"*. Nhưng `detectDrift`
 * lại nhận một `DomainAdapterContext`, mà `ctx.k8s.getClient()` trả về client đầy đủ, nên
 * cho tới P21 lời khai đó không có hiệu lực - và chính chú thích trong bộ hợp đồng đang
 * nói "tầng một là kiểu" trong khi tầng đó rỗng.
 *
 * Kiểu này cũng là kiểu của mọi hàm SUY DIỄN thuần của hai lớp nền (`values`, `bindings`,
 * `configureBody`): chúng tính ra cái gì **nên** có, và không có việc gì phải ghi.
 */
export interface ReadOnlyAdapterContext extends Omit<
  DomainAdapterContext,
  "k8s"
> {
  k8s: ReadOnlyClusterAccess;
}

/**
 * Hạ một bối cảnh đầy đủ xuống bối cảnh chỉ đọc - đường mà job quét drift dùng.
 *
 * Lúc chạy thật, `DRIFT_SCAN` có trong tay một `ClusterAccess` đầy đủ (nó cũng là
 * process chạy `deploy`). Hàm này là chỗ chuyển đổi DUY NHẤT, nên "quyền ghi dừng ở đây"
 * là một dòng mã chỉ ra được, không phải một quy ước người ta nhớ hoặc quên.
 */
export function readOnlyContext(
  ctx: DomainAdapterContext | ReadOnlyAdapterContext,
): ReadOnlyAdapterContext {
  return { ...ctx, k8s: readOnlyAccess(ctx.k8s) };
}

export interface DomainAdapter {
  readonly domainType: DomainType;
  /** `"github-actions"`, `"prometheus-grafana"` */
  readonly toolId: string;
  /** Phiên bản adapter (và chart/operator nó cài) — ghi vào `DomainConfig.adapter_version` */
  readonly version: string;
  /**
   * Istio control plane, operator CNPG/Gatekeeper, Argo Rollouts controller đều
   * cluster-scoped: cài MỘT lần vào `udp-system`. Chỉ CR mới theo namespace của
   * environment. Bản v3 bắt mọi adapter deploy vào namespace env — không thực hiện được
   * cho nửa số domain.
   */
  readonly scope: "cluster" | "namespace";
  readonly capabilities: CapabilityDeclaration;
  /** Schema của `tool_config`; trường `.describe("secret")` được mã hoá khi lưu */
  readonly configSchema: ZodType;

  /**
   * Đường DUY NHẤT mà bộ hợp đồng gọi.
   *
   * §5.2 nói `SaaSAdapter` chỉ viết `configure()`, còn §13.2 lại gọi `deploy()`. Chốt:
   * base `SaaSAdapter` hiện thực `deploy()` bằng cách gọi `configure()`, nên bộ hợp đồng
   * có đúng một điểm vào cho cả hai họ.
   */
  deploy(
    ctx: DomainAdapterContext,
    config: DomainToolConfig,
  ): Promise<AdapterResult<CapabilityBinding[]>>;

  configure(
    ctx: DomainAdapterContext,
    config: DomainToolConfig,
  ): Promise<AdapterResult<CapabilityBinding[]>>;

  /** Day-2: nâng chart/operator lên `version` mới mà không teardown */
  upgrade(
    ctx: DomainAdapterContext,
    config: DomainToolConfig,
    fromVersion: string,
  ): Promise<AdapterResult<CapabilityBinding[]>>;

  /**
   * Day-2: so trạng thái thật trên cluster với cấu hình mong muốn.
   *
   * [v4.10] Nhận `ReadOnlyAdapterContext`: chiều (c) của I32 ("không bao giờ tự sửa") là
   * tính chất của KIỂU trước, rồi mới là một phép đếm. Đây là thay đổi chữ ký DUY NHẤT
   * sau khi bề mặt interface được đóng băng ở P18 (tag `adapter-interface-v1`), và nó là
   * một quyết định chứ không phải một lần thêm cho tiện: bề mặt giữ đúng **bảy phương
   * thức** cùng tên, chỉ quyền của một tham số bị thu hẹp. Mọi adapter đang có vẫn biên
   * dịch; adapter nào đang ghi trong lúc quét thì không.
   */
  detectDrift(
    ctx: ReadOnlyAdapterContext,
    config: DomainToolConfig,
  ): Promise<AdapterResult<{ drifted: boolean; details?: string }>>;

  /**
   * Được gọi khi provider của một capability mà adapter này `requires` đổi.
   *
   * Bản v3 không có hook này nên consumer giữ endpoint cũ vĩnh viễn sau khi swap.
   */
  onDependencyChanged(
    ctx: DomainAdapterContext,
    config: DomainToolConfig,
    changed: CapabilityBinding,
  ): Promise<AdapterResult<void>>;

  healthcheck(
    ctx: DomainAdapterContext,
  ): Promise<AdapterResult<{ healthy: boolean; details?: string }>>;

  /** `reason` cho phép giữ lại dữ liệu (PVC) khi chỉ đổi tool, và dọn sạch khi tắt domain */
  teardown(
    ctx: DomainAdapterContext,
    reason: "disable" | "switch" | "project-teardown",
  ): Promise<AdapterResult<void>>;
}

/** Bảy tên phương thức, để test đối chiếu với §5.2 */
export const DOMAIN_ADAPTER_METHODS: readonly string[] = [
  "deploy",
  "configure",
  "upgrade",
  "detectDrift",
  "onDependencyChanged",
  "healthcheck",
  "teardown",
];

/** Sáu thuộc tính read-only */
export const DOMAIN_ADAPTER_PROPERTIES: readonly string[] = [
  "domainType",
  "toolId",
  "version",
  "scope",
  "capabilities",
  "configSchema",
];

/**
 * Sự kiện deploy đã phân tích từ webhook của CI.
 *
 * Trước v4.10 kiểu này được dùng ở `CicdDomainAdapter.parsePayload` mà chưa từng được
 * định nghĩa, nên interface đó không dịch được.
 */
export interface WebhookDeployEvent {
  /** `toolId` của adapter đã phân tích */
  provider: string;
  repo: string;
  ref: string;
  commitSha: string;
  /** Tên environment đích, suy từ `ref` theo cấu hình Golden Path */
  environment: string;
  /** Image đã build, nếu payload có. Vắng nghĩa là pipeline chưa push */
  imageRef?: string;
  actor: string;
}

export interface PipelineTemplateParams {
  projectSlug: string;
  environments: { name: string; isProduction: boolean }[];
  /** Địa chỉ registry lấy từ `CapabilityBinding` của `registry.oci` */
  registryRef: string;
  /** Flag mà template gắn sẵn nhãn `ff` cho (§6.8) */
  flagKeys: string[];
  rolloutStrategy: "udp-driven" | "tool-driven";
}

/** CI/CD adapter mở rộng thêm phần webhook — §8.3 nhắc nhưng v3 không có trong interface */
export interface CicdDomainAdapter extends DomainAdapter {
  /** So sánh HẰNG THỜI GIAN; một `===` trên chuỗi chữ ký là một lỗ định thời */
  verifySignature(
    headers: Record<string, string>,
    rawBody: Buffer,
    secret: Buffer,
  ): boolean;
  parsePayload(rawBody: Buffer): WebhookDeployEvent;
  /** Sinh file pipeline mẫu cho Golden Path (§11) */
  renderPipelineTemplate(params: PipelineTemplateParams): string;
}

/**
 * Bề mặt tác dụng mà một adapter tự khai, dùng cho bộ hợp đồng (§13.2).
 *
 * Luật: **khai rỗng thì phép kiểm ĐẢO CHIỀU, không biến mất.** `externalHosts: []` nghĩa
 * là *mọi* lời gọi ra ngoài là đỏ; `quotaDimensions: []` nghĩa là adapter *phải* chạy
 * được với quota toàn 0 **và** không được tiêu thụ chiều nào. Không có luật này thì một
 * fixture rỗng là cách rẻ nhất để làm cả bộ hợp đồng xanh.
 */
export interface AdapterFixture {
  validConfig: DomainToolConfig;
  invalidConfigs: readonly DomainToolConfig[];
  externalHosts: readonly string[];
  quotaDimensions: readonly (keyof ResourceQuota)[];
  /** Mỗi prefix PHẢI kèm lý do, để danh sách không mọc rêu */
  ignoredLabelPrefixes: readonly { prefix: string; reason: string }[];
  /** Cách sửa tay trên cluster để chiều (a) của I32 có đối tượng */
  driftMutations: readonly {
    name: string;
    apply: (c: KubernetesClient) => Promise<void>;
  }[];
}

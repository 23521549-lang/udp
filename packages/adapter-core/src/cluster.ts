import type { AdapterResult } from "@udp/shared-types";

/**
 * [v4.10] Đường DUY NHẤT chạm vào cluster của tenant (§4.6, hiện thực ADR-06).
 *
 * Nguyên tắc: không code nghiệp vụ nào được tự dựng kubeconfig, tự gọi `TokenRequest`,
 * hay tự biết cluster ở chế độ `direct` hay `agent`. Mọi thứ đi qua interface này, nên
 * đổi chế độ không chạm vào luồng nghiệp vụ.
 */

export type ClusterAccessMode = "direct" | "agent";

/** Danh tính bên gọi — quyết định SA nào được cấp (§12.2). KHÔNG do bên gọi tự khai */
export type ControlPlaneIdentity = "workload" | "traffic" | "tooling";

/**
 * Ba ServiceAccount rời nhau trong `udp-system`.
 *
 * Nếu cả ba bên dùng chung một SA thì bất biến I25 chỉ được bảo đảm bằng kỷ luật lập
 * trình. Tách ba thì **API server từ chối**, và audit log của chính nó thành bằng chứng.
 */
export const IDENTITY_SERVICE_ACCOUNTS: Readonly<
  Record<ControlPlaneIdentity, string>
> = {
  workload: "udp-system/udp-workload",
  traffic: "udp-system/udp-traffic",
  tooling: "udp-system/udp-tooling",
};

export type K8sReadVerb = "get" | "list" | "watch";

export type K8sWriteVerb =
  | "create"
  | "update"
  | "patch"
  | "replace"
  | "delete"
  | "deletecollection"
  | "apply";

export const K8S_READ_VERBS: readonly K8sReadVerb[] = ["get", "list", "watch"];

export const K8S_WRITE_VERBS: readonly K8sWriteVerb[] = [
  "create",
  "update",
  "patch",
  "replace",
  "delete",
  "deletecollection",
  "apply",
];

export interface ObjectRef {
  apiVersion: string;
  kind: string;
  namespace?: string;
  name?: string;
  labelSelector?: string;
  /**
   * [v4.11, Plan #51] Subresource của đối tượng. `status` là đường duy nhất mà `udp-traffic` được ghi lên một
   * `Rollout` của Argo (§12.2, D-P39): promote, promote-full, abort, retry đều là patch lên `status` — đúng các
   * patch mà `kubectl argo rollouts` gửi. Ghi `spec` của cùng đối tượng thì API server từ chối (I25).
   */
  subresource?: "status";
}

/**
 * Nửa ĐỌC của cổng Kubernetes.
 *
 * Vì sao tách: bất biến I32 chiều (c) nói hệ thống **không bao giờ** tự sửa drift. Cho
 * hàm quét drift nhận đúng kiểu này biến điều đó thành tính chất của KIỂU — nó *không
 * thể* gọi một verb ghi. Đếm lời gọi trên một hiện thực giả vẫn giữ làm lớp thứ hai,
 * nhưng một phép đếm chỉ bắt được lỗi sau khi nó đã xảy ra.
 */
export interface ReadOnlyKubernetesClient {
  read<T>(verb: K8sReadVerb, ref: ObjectRef): Promise<T | null>;
}

export interface KubernetesClient extends ReadOnlyKubernetesClient {
  write(verb: K8sWriteVerb, ref: ObjectRef, body?: unknown): Promise<void>;
}

/**
 * [v4.10] Nửa CHỈ ĐỌC của `ClusterAccess` - kiểu mà đường quét drift nhận.
 *
 * Tách `ReadOnlyKubernetesClient` khỏi `KubernetesClient` chỉ là một nửa việc. Nửa còn
 * lại là cái cổng để lấy client: nếu hàm quét drift nhận cả `ClusterAccess` thì nó gọi
 * `getClient()` và có ngay trong tay một client GHI ĐƯỢC, và lời khai ở §4.6 ("cho hàm
 * quét drift nhận `ReadOnlyKubernetesClient` biến điều đó thành tính chất của KIỂU") là
 * một lời khai không có hiệu lực. Nó đã không có hiệu lực cho tới P21.
 *
 * `ClusterAccess` mở rộng interface này và thu hẹp kiểu trả về của `getClient`, nên mọi
 * nơi đang truyền `ClusterAccess` vẫn biên dịch, còn đường quét drift chỉ thấy `read`.
 */
export interface ReadOnlyClusterAccess {
  readonly mode: ClusterAccessMode;
  readonly clusterId: string;
  getClient(as: ControlPlaneIdentity): Promise<ReadOnlyKubernetesClient>;
}

export interface ClusterAccess extends ReadOnlyClusterAccess {
  readonly mode: ClusterAccessMode;
  readonly clusterId: string;

  /**
   * Client đã xác thực bằng bound SA token 1 giờ của ĐÚNG identity.
   *
   * Token được cache trong bộ nhớ và xin lại trước hạn; **không bao giờ** ghi xuống
   * database hay đĩa (I24). Tham số `as` là **bắt buộc**: không có nó thì ba SA của
   * §12.2 vô nghĩa vì mọi bên sẽ dùng chung token mạnh nhất.
   */
  getClient(as: ControlPlaneIdentity): Promise<KubernetesClient>;

  /**
   * Gọi một Service trong cluster mà KHÔNG phơi nó ra Internet, qua API-server service
   * proxy. Đây là cách Prometheus nội bộ được truy vấn (ADR-06) — [v4.11, D-P30] bởi Service 1
   * thay Service 3 — và là cách DUY
   * NHẤT — một `fetch` trực tiếp tới ClusterIP sẽ không chạy khi control plane nằm
   * ngoài VPC, và sẽ vòng qua egress guard của T11.
   */
  proxyService(
    target: {
      namespace: string;
      service: string;
      port: number;
      scheme: "http" | "https";
    },
    path: string,
    init?: RequestInit,
  ): Promise<Response>;

  /**
   * Kiểm nhanh trước khi chạy luồng dài.
   *
   * Phát hiện "không vào được cluster" ở phút thứ 12 sau khi đã tạo nửa hạ tầng là đúng
   * cái ADR-02 và preflight của §4.2 sinh ra để tránh.
   */
  probe(): Promise<
    AdapterResult<{ reachable: boolean; serverVersion?: string }>
  >;
}

/**
 * [v4.10] Tầng HAI của I32 chiều (c): bóc `write` ở LÚC CHẠY, không chỉ ở tầng kiểu.
 *
 * Một bảo đảm ở tầng kiểu mất hiệu lực ngay khi ai đó viết một `as`, và phương thức
 * trong TypeScript là **song biến**: một adapter khai `detectDrift(ctx:
 * DomainAdapterContext)` vẫn thoả interface. Hàm này khoá cả hai lỗ đó, vì object trả về
 * là object MỚI **chỉ có** `read`: một lời gọi `write` trên đó là `TypeError` tại chỗ,
 * chứ không phải một lần ghi đè vào cluster của khách lúc 3 giờ sáng.
 *
 * Nó KHÔNG trả về chính `access` đã thu hẹp kiểu: làm như vậy thì `write` vẫn còn đó và
 * một `as` lấy lại được.
 */
export function readOnlyAccess(
  access: ReadOnlyClusterAccess,
): ReadOnlyClusterAccess {
  return {
    mode: access.mode,
    clusterId: access.clusterId,
    async getClient(
      as: ControlPlaneIdentity,
    ): Promise<ReadOnlyKubernetesClient> {
      const client = await access.getClient(as);
      return {
        read<T>(verb: K8sReadVerb, ref: ObjectRef): Promise<T | null> {
          return client.read<T>(verb, ref);
        },
      };
    },
  };
}

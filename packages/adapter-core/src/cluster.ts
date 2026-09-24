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

export interface ClusterAccess {
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
   * proxy. Đây là cách Service 3 truy vấn Prometheus nội bộ (ADR-06), và là cách DUY
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

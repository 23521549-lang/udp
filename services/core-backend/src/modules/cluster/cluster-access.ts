import {
  IDENTITY_SERVICE_ACCOUNTS,
  type ClusterAccess,
  type ControlPlaneIdentity,
  type K8sReadVerb,
  type K8sWriteVerb,
  type KubernetesClient,
  type ObjectRef,
} from "@udp/adapter-core";

/**
 * [v4.10] `ClusterAccess` chế độ `direct` (§4.6, hiện thực ADR-06).
 *
 * Nguyên tắc của §4.6, chép nguyên vì nó là lý do tệp này tồn tại: *không code nghiệp vụ
 * nào được tự dựng kubeconfig, tự gọi `TokenRequest`, hay tự biết cluster ở chế độ
 * `direct` hay `agent`*. Mọi thứ đi qua interface này.
 *
 * **Ba điều kiện mà hiện thực này cưỡng chế, không khuyến nghị:**
 *
 * 1. `getClient(as)` **bắt buộc** khai identity, và token xin về là token của ĐÚNG
 *    ServiceAccount đó (§12.2). Không có tham số này thì ba SA vô nghĩa: mọi bên dùng
 *    chung token mạnh nhất, và bất biến I25 quay về phụ thuộc kỷ luật lập trình.
 * 2. Token sống trong **bộ nhớ**, xin lại trước hạn, và KHÔNG BAO GIỜ ghi xuống database
 *    hay đĩa (I24). Nó cũng không nằm trong đối tượng trả về ở chỗ ai cũng đọc được: nó
 *    bị đóng trong closure, và cách duy nhất dùng nó là gọi `read`/`write`.
 * 3. `proxyService` là **cách duy nhất** gọi service trong cluster. Một `fetch` trực tiếp
 *    tới ClusterIP sẽ không chạy khi control plane nằm ngoài VPC, và sẽ vòng qua RBAC
 *    `services/proxy` — tức qua cả phần cấp quyền hẹp của §12.2.
 *
 * **Vận chuyển được TIÊM VÀO.** `KubeTransport` là một cổng, không phải `fetch` gọi
 * thẳng. Hai lý do: máy phát triển không có cluster nào để gọi (xem sổ nợ
 * `clusteraccess-direct`), và quan trọng hơn, mọi lời gọi ra ngoài phải đi qua egress
 * guard chống SSRF (§12 T11) — một `fetch` gọi thẳng trong tệp này là đúng thứ khối lint
 * thứ ba sẽ cấm khi thư mục adapter đầu tiên xuất hiện.
 */

/** Một lượt đi ra ngoài; hiện thực thật bọc `fetch` đã qua egress guard */
export interface KubeTransport {
  request(url: string, init: RequestInit): Promise<Response>;
}

/** Bound SA token của một ServiceAccount, xin qua `TokenRequest` của API server */
export interface BoundToken {
  token: string;
  expiresAt: Date;
}

export interface TokenSource {
  /**
   * Xin bound SA token cho `serviceAccount` dạng `namespace/name`.
   *
   * Nó nhận CHUỖI SA chứ không nhận `ControlPlaneIdentity`: ánh xạ identity → SA là của
   * §12.2 và nằm ở `IDENTITY_SERVICE_ACCOUNTS`, nên một nguồn token không được phép có
   * ý kiến riêng về ánh xạ đó.
   */
  requestBoundToken(serviceAccount: string): Promise<BoundToken>;
}

export interface DirectClusterAccessOptions {
  clusterId: string;
  /** `https://ABCD.gr7.ap-southeast-1.eks.amazonaws.com` */
  apiEndpoint: string;
  transport: KubeTransport;
  tokens: TokenSource;
  /**
   * Xin lại token trước hạn bao lâu.
   *
   * Không phải số tuỳ ý: token sống 1 giờ (I24), và một lời gọi dài có thể bắt đầu ngay
   * trước hạn rồi chạy qua mốc đó. 5 phút là biên đủ cho một lời gọi API server chậm mà
   * vẫn xa 1 giờ.
   */
  refreshSkewMs?: number;
  now?: () => number;
}

export const DEFAULT_REFRESH_SKEW_MS = 300_000;

/**
 * Tên số nhiều của một kind — đúng quy tắc mà API server dùng cho kind dựng sẵn và mà
 * `controller-gen` dùng cho CRD: `NetworkPolicy` ⇒ `networkpolicies`, `Ingress` ⇒
 * `ingresses`. [v4.11] Bản trước chỉ thêm "s" (`networkpolicys`, `ingresss`) — sai đúng ở hai
 * kind mà bootstrap cluster (Plan #28) phải tạo.
 */
export function pluralOf(kind: string): string {
  const lower = kind.toLowerCase();
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  return `${lower}s`;
}

/** Path của một `ObjectRef` theo quy ước REST của Kubernetes */
export function objectPath(ref: ObjectRef): string {
  const core = ref.apiVersion === "v1";
  const base = core ? "/api/v1" : `/apis/${ref.apiVersion}`;
  const scope =
    ref.namespace === undefined ? "" : `/namespaces/${ref.namespace}`;
  const plural = pluralOf(ref.kind);
  const name = ref.name === undefined ? "" : `/${ref.name}`;
  const query =
    ref.labelSelector === undefined
      ? ""
      : `?labelSelector=${encodeURIComponent(ref.labelSelector)}`;
  return `${base}${scope}/${plural}${name}${query}`;
}

/** HTTP method của từng verb — `watch` là `GET` có `?watch=1`, không phải verb riêng */
const METHOD_OF: Readonly<Record<K8sReadVerb | K8sWriteVerb, string>> = {
  get: "GET",
  list: "GET",
  watch: "GET",
  create: "POST",
  update: "PUT",
  replace: "PUT",
  patch: "PATCH",
  apply: "PATCH",
  delete: "DELETE",
  deletecollection: "DELETE",
};

/** Chủ sở hữu trường của mọi server-side apply do control plane UDP gửi */
export const FIELD_MANAGER = "udp-control-plane";

export class ClusterCallFailedError extends Error {
  readonly code = "CLUSTER_CALL_FAILED";
  constructor(
    readonly status: number,
    readonly verb: string,
    readonly path: string,
  ) {
    super(`API server trả ${String(status)} cho ${verb} ${path}`);
    this.name = "ClusterCallFailedError";
  }
}

export function createDirectClusterAccess(
  options: DirectClusterAccessOptions,
): ClusterAccess {
  const { clusterId, apiEndpoint, transport, tokens } = options;
  const skew = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const now = options.now ?? ((): number => Date.now());

  /**
   * Bộ nhớ đệm token theo identity, sống trong closure.
   *
   * Nó KHÔNG phải một thuộc tính của đối tượng trả về, và đó là chủ ý: một thuộc tính
   * công khai là một chỗ mà `JSON.stringify(access)` sẽ tìm thấy token — tức đúng cái
   * I24 cấm, xảy ra qua một dòng log vô hại.
   */
  const cache = new Map<ControlPlaneIdentity, BoundToken>();

  async function tokenFor(identity: ControlPlaneIdentity): Promise<string> {
    const cached = cache.get(identity);
    if (cached !== undefined && cached.expiresAt.getTime() - skew > now()) {
      return cached.token;
    }
    const fresh = await tokens.requestBoundToken(
      IDENTITY_SERVICE_ACCOUNTS[identity],
    );
    cache.set(identity, fresh);
    return fresh.token;
  }

  async function call(
    identity: ControlPlaneIdentity,
    verb: K8sReadVerb | K8sWriteVerb,
    ref: ObjectRef,
    body?: unknown,
  ): Promise<Response> {
    const path = objectPath(ref);
    const sep = path.includes("?") ? "&" : "?";
    /**
     * [v4.11] `apply` là SERVER-SIDE APPLY (tạo hoặc cập nhật, idempotent) chứ không phải
     * merge-patch: merge-patch lên đối tượng chưa có trả 404, nên lần bootstrap đầu tiên của
     * mọi cluster sẽ vỡ. `force=true` để UDP giành lại trường nó quản lý khi ai đó sửa tay.
     */
    const suffix =
      verb === "watch"
        ? `${sep}watch=1`
        : verb === "apply"
          ? `${sep}fieldManager=${FIELD_MANAGER}&force=true`
          : "";
    const token = await tokenFor(identity);
    const res = await transport.request(`${apiEndpoint}${path}${suffix}`, {
      method: METHOD_OF[verb],
      headers: {
        authorization: `Bearer ${token}`,
        "content-type":
          verb === "apply"
            ? "application/apply-patch+yaml"
            : verb === "patch"
              ? "application/merge-patch+json"
              : "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res;
  }

  function clientFor(identity: ControlPlaneIdentity): KubernetesClient {
    return {
      /**
       * `404` trả `null`, không ném.
       *
       * Hàm quét drift hỏi "đối tượng này còn không"; với câu hỏi đó, "không có" là một
       * CÂU TRẢ LỜI, không phải một lỗi. Ném ở đây buộc mọi chỗ đọc phải bọc try/catch và
       * phân biệt 404 với lỗi mạng bằng cách đọc thông điệp — chỗ dễ sai nhất.
       */
      async read<T>(verb: K8sReadVerb, ref: ObjectRef): Promise<T | null> {
        const res = await call(identity, verb, ref);
        if (res.status === 404) return null;
        if (!res.ok) {
          throw new ClusterCallFailedError(res.status, verb, objectPath(ref));
        }
        return (await res.json()) as T;
      },
      async write(
        verb: K8sWriteVerb,
        ref: ObjectRef,
        body?: unknown,
      ): Promise<void> {
        const res = await call(identity, verb, ref, body);
        /** `delete` một thứ đã biến mất là THÀNH CÔNG — cùng lý lẽ với RUN9 của runner */
        if (res.status === 404 && METHOD_OF[verb] === "DELETE") return;
        if (!res.ok) {
          throw new ClusterCallFailedError(res.status, verb, objectPath(ref));
        }
      },
    };
  }

  return {
    mode: "direct",
    clusterId,

    getClient(as: ControlPlaneIdentity): Promise<KubernetesClient> {
      return Promise.resolve(clientFor(as));
    },

    /**
     * Service proxy của API server — không phơi service nào ra Internet.
     *
     * Hình path là của Kubernetes, không phải do ta chọn:
     * `/api/v1/namespaces/{ns}/services/{scheme}:{name}:{port}/proxy/{path}`
     *
     * Identity dùng ở đây là `traffic`: §12.2 mở `services/proxy` **chỉ trên service của
     * nguồn metrics** cho `udp-traffic`, và đó là người dùng chính của hàm này (Prometheus
     * nội bộ, ADR-06 — [v4.11, D-P30] Service 1 đo thay Service 3).
     */
    async proxyService(target, path, init): Promise<Response> {
      const token = await tokenFor("traffic");
      const clean = path.startsWith("/") ? path.slice(1) : path;
      const url =
        `${apiEndpoint}/api/v1/namespaces/${target.namespace}` +
        `/services/${target.scheme}:${target.service}:${String(target.port)}` +
        `/proxy/${clean}`;
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return await transport.request(url, { ...init, headers });
    },

    /**
     * `probe()` tồn tại vì §8.1 và §8.3 là những luồng dài.
     *
     * Phát hiện "không vào được cluster" ở phút thứ 12 sau khi đã tạo nửa hạ tầng là đúng
     * cái ADR-06 muốn tránh. Nó hỏi hai câu trong một lượt: endpoint có tới được, và token
     * có cấp được — vì hỏng một trong hai đều dẫn tới cùng một kết cục.
     */
    async probe() {
      try {
        const token = await tokenFor("workload");
        const res = await transport.request(`${apiEndpoint}/version`, {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          return {
            status: "FAILED" as const,
            message: `/version trả ${String(res.status)}`,
            data: { reachable: false },
          };
        }
        const body = (await res.json()) as { gitVersion?: string };
        return {
          status: "SUCCESS" as const,
          data: {
            reachable: true,
            ...(body.gitVersion === undefined
              ? {}
              : { serverVersion: body.gitVersion }),
          },
        };
      } catch (err) {
        /**
         * Thông điệp KHÔNG mang lỗi gốc nguyên vẹn.
         *
         * Một số SDK nhét credential vào `error.config` (§12 T3, I12), và `probe()` là
         * hàm mà Portal hiển thị kết quả. Chỉ lấy tên lỗi.
         */
        return {
          status: "FAILED" as const,
          message: err instanceof Error ? err.name : "lỗi không rõ",
          data: { reachable: false },
        };
      }
    },
  };
}

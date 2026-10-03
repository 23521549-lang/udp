import type {
  ClusterAccess,
  ClusterAccessMode,
  ControlPlaneIdentity,
  K8sReadVerb,
  K8sWriteVerb,
  KubernetesClient,
  ObjectRef,
} from "../cluster.js";

/**
 * [v4.10] MỘT hiện thực giả duy nhất của `ClusterAccess` (QĐ-27).
 *
 * "Một" là phần quan trọng. Mỗi bộ test tự dựng một fake riêng là cách ba bộ test cùng
 * tin ba ngữ nghĩa khác nhau về cùng một cổng: một fake cho `write` đi qua im lặng, một
 * fake khác ném, và một fake thứ ba không phân biệt đọc với ghi. Lúc đó "S3 không sửa
 * được deployment" là đúng ở bộ test này và không được kiểm ở bộ kia, mà không ai thấy.
 * Fake này dùng ở P11 (`ClusterAccess`) và dùng lại ở P18 (hợp đồng Domain Adapter).
 *
 * **Nó ghi nhật ký mọi lời gọi, và đó là lý do nó tồn tại.** Bất biến I32 chiều (c) nói
 * hệ thống **không bao giờ** tự sửa drift. Tầng thứ nhất bảo đảm điều đó là KIỂU: hàm
 * quét drift nhận `ReadOnlyKubernetesClient`, nên nó *không thể* gọi verb ghi. Nhưng một
 * bảo đảm ở tầng kiểu mất hiệu lực ngay khi ai đó viết một `as`, nên tầng thứ hai là đếm:
 * `writes` phải rỗng sau một lượt quét. Hai tầng bắt hai loại lỗi khác nhau — tầng kiểu
 * bắt trước khi chạy, tầng đếm bắt cả khi có người lách kiểu.
 */

export interface FakeCall {
  identity: ControlPlaneIdentity;
  verb: K8sReadVerb | K8sWriteVerb;
  ref: ObjectRef;
}

export interface FakeClusterOptions {
  mode?: ClusterAccessMode;
  clusterId?: string;
  /** Đối tượng mà `read` trả về, khoá theo `kind/namespace/name` */
  objects?: Readonly<Record<string, unknown>>;
  /** Identity KHÔNG được cấp client — để test đường từ chối của §12.2 */
  denyIdentities?: readonly ControlPlaneIdentity[];
  /** `probe()` trả về không tới được */
  unreachable?: boolean;
  serverVersion?: string;
  /**
   * [Plan #61 61d-2b-1] Thứ `issuerKeys()` trả về. Không khai ⇒ **ném**, đúng như một cụm chưa bật
   * issuer discovery: test nào cần đường đó phải nói ra là nó cần, chứ không nhận một giá trị mặc định
   * im lặng (cùng lý lẽ với `denyIdentities`).
   */
  issuerKeys?: { issuer: string; algorithms: readonly string[]; jwks: unknown };
}

export interface FakeClusterAccess extends ClusterAccess {
  /** Mọi lời gọi theo thứ tự — oracle của mọi phép kiểm về "ai được làm gì" */
  readonly calls: readonly FakeCall[];
  /** Chỉ các verb GHI; I32(c) đòi danh sách này rỗng sau một lượt quét drift */
  readonly writes: readonly FakeCall[];
  /** Đối tượng đang có trên cluster giả, khoá theo `refKey` — để test khẳng định trạng thái */
  snapshot(): Readonly<Record<string, unknown>>;
  /** Số lần xin token, theo identity — để kiểm bộ nhớ đệm token (I24) */
  readonly tokenRequests: Readonly<Record<ControlPlaneIdentity, number>>;
  /** [Plan #61 61d-2b-1] Số lần `issuerKeys()` được gọi — oracle cho cache khoá của cụm */
  readonly issuerKeyReads: number;
  reset(): void;
}

export function refKey(ref: ObjectRef): string {
  return [ref.kind, ref.namespace ?? "-", ref.name ?? "-"].join("/");
}

export class ClusterIdentityDeniedError extends Error {
  readonly code = "CLUSTER_IDENTITY_DENIED";
  constructor(readonly identity: ControlPlaneIdentity) {
    super(`identity ${identity} không được cấp client cho cluster này`);
    this.name = "ClusterIdentityDeniedError";
  }
}

export function createFakeClusterAccess(
  options: FakeClusterOptions = {},
): FakeClusterAccess {
  const calls: FakeCall[] = [];
  let issuerKeyReads = 0;
  const tokenRequests: Record<ControlPlaneIdentity, number> = {
    workload: 0,
    traffic: 0,
    tooling: 0,
  };
  const objects = options.objects ?? {};
  const denied = new Set(options.denyIdentities ?? []);

  /**
   * Kho đối tượng SỐNG: `write` đổi nó, `read` đọc nó.
   *
   * [v4.10] Bản đầu của fake này chỉ **ghi nhật ký** lời gọi ghi rồi bỏ qua nội dung,
   * nên `read` luôn trả đúng thứ được seed từ đầu. Điều đó làm phép d13 của bộ hợp
   * đồng Domain **không dựng được**: `driftMutations` sửa một đối tượng trên cluster giả,
   * rồi `detectDrift` đọc lại và không thấy gì khác — tức phép kiểm "phát hiện được
   * sửa tay" luôn đỏ bất kể adapter đúng hay sai.
   *
   * Nhật ký lời gọi VẪN giữ, vì nó trả lời câu khác: "ai đã gọi verb nào" (I32
   * chiều c, định danh của §12.2). Hai câu hỏi khác nhau, hai cơ chế khác nhau.
   */
  const store = new Map<string, unknown>(Object.entries(objects));

  function clientFor(identity: ControlPlaneIdentity): KubernetesClient {
    return {
      read<T>(verb: K8sReadVerb, ref: ObjectRef): Promise<T | null> {
        calls.push({ identity, verb, ref });
        const found = store.get(refKey(ref));
        return Promise.resolve(found === undefined ? null : (found as T));
      },
      write(verb: K8sWriteVerb, ref: ObjectRef, body?: unknown): Promise<void> {
        calls.push({ identity, verb, ref });
        const key = refKey(ref);
        if (verb === "delete" || verb === "deletecollection") {
          store.delete(key);
          return Promise.resolve();
        }
        /**
         * `patch` và `apply` TRỘN vào giá trị cũ; `create`/`update`/`replace` thay hẳn.
         *
         * Phân biệt này không phải sự tỉ mỉ: một `driftMutation` thực tế là một lần
         * `patch` thêm một nhãn, và nếu fake coi nó như `replace` thì đối tượng mất mọi
         * trường khác — `detectDrift` sẽ thấy drift, nhưng vì một lý do bịa ra bởi fake.
         */
        if ((verb === "patch" || verb === "apply") && body !== null) {
          const prev = store.get(key);
          if (
            typeof prev === "object" &&
            prev !== null &&
            typeof body === "object"
          ) {
            store.set(key, { ...prev, ...body });
            return Promise.resolve();
          }
        }
        store.set(key, body ?? {});
        return Promise.resolve();
      },
    };
  }

  return {
    mode: options.mode ?? "direct",
    clusterId: options.clusterId ?? "cluster-gia",

    /**
     * `as` là THAM SỐ BẮT BUỘC, và fake này không có mặc định cho nó.
     *
     * Một fake nhận `as` tuỳ chọn rồi tự chọn `"workload"` khi thiếu là fake làm mất chính
     * tính chất mà §4.6 nói interface phải cưỡng chế: "không có tham số này thì ba
     * ServiceAccount của §12.2 vô nghĩa, mọi bên sẽ dùng chung token mạnh nhất".
     */
    getClient(as: ControlPlaneIdentity): Promise<KubernetesClient> {
      if (denied.has(as)) {
        return Promise.reject(new ClusterIdentityDeniedError(as));
      }
      tokenRequests[as] += 1;
      return Promise.resolve(clientFor(as));
    },

    proxyService(target, path): Promise<Response> {
      calls.push({
        identity: "traffic",
        verb: "get",
        ref: {
          apiVersion: "v1",
          kind: "Service",
          namespace: target.namespace,
          name: `${target.scheme}:${target.service}:${String(target.port)}`,
        },
      });
      return Promise.resolve(
        new Response(JSON.stringify({ path }), { status: 200 }),
      );
    },

    issuerKeys() {
      const keys = options.issuerKeys;
      if (keys === undefined) {
        return Promise.reject(
          new Error("FakeCluster: chưa khai issuerKeys cho cụm giả này"),
        );
      }
      issuerKeyReads += 1;
      return Promise.resolve(keys);
    },

    probe() {
      const reachable = options.unreachable !== true;
      return Promise.resolve({
        status: reachable ? ("SUCCESS" as const) : ("FAILED" as const),
        data: {
          reachable,
          ...(options.serverVersion === undefined
            ? {}
            : { serverVersion: options.serverVersion }),
        },
      });
    },

    get issuerKeyReads() {
      return issuerKeyReads;
    },

    get calls() {
      return calls;
    },
    get writes() {
      return calls.filter((c) => !isReadVerb(c.verb));
    },
    get tokenRequests() {
      return tokenRequests;
    },
    snapshot() {
      return Object.fromEntries(store);
    },
    /**
     * `reset` xoá NHẬT KÝ, không xoá kho đối tượng.
     *
     * Hai thứ có vòng đời khác nhau: nhật ký là của một lượt đo ("teardown có gọi delete
     * không"), còn kho là trạng thái cluster kéo dài qua nhiều lượt. Xoá cả hai làm phép
     * `teardown sau deploy` mất đối tượng để xoá, và nó sẽ xanh vì không còn gì.
     */
    reset() {
      calls.length = 0;
      issuerKeyReads = 0;
      tokenRequests.workload = 0;
      tokenRequests.traffic = 0;
      tokenRequests.tooling = 0;
    },
  };
}

function isReadVerb(verb: K8sReadVerb | K8sWriteVerb): verb is K8sReadVerb {
  return verb === "get" || verb === "list" || verb === "watch";
}

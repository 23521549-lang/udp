import type {
  CloudProvider,
  CreatedResource,
  CreatedResourceKind,
} from "@udp/adapter-core";
import {
  SIM_DEPENDENCY_VIOLATION,
  SIM_NOT_FOUND,
  SIM_PERMANENT,
  SIM_SEPARATE_TAGGING_REJECTED,
  SIM_THROTTLE,
  SIM_TRANSIENT,
  SimCloudError,
  type SimCloud,
} from "@udp/adapter-core/testing";
import {
  GatewayError,
  type CloudGateway,
  type GatewayErrorClass,
} from "../core/gateway.js";
import type { TagCodec } from "../core/plan.js";

/**
 * `CloudGateway` dựng trên `SimCloud` — để kế hoạch THẬT của từng cloud chạy qua đủ bộ
 * hợp đồng Cloud (bơm lỗi, xoá tag, xoá ngoài luồng, trễ lan truyền tag).
 *
 * Tag đi qua CODEC của cloud ở biên: mã hoá, khẳng định mọi khoá/giá trị hợp lệ theo luật
 * của cloud đó, rồi giải mã về dạng chuẩn trước khi lưu — bộ hợp đồng đọc kho của SimCloud
 * ở dạng chuẩn (Plan #26 spec v2, review v1 → v2).
 *
 * SimCloud không có API mô phỏng quyền, nên `checkPermissions` luôn khai `heuristic`: khai
 * `exact` ở đây là nói quá (§4.2, phép c8).
 */
export interface SimGatewayOptions {
  cloud: SimCloud;
  provider: CloudProvider;
  codec: TagCodec;
  /** Nhãn credential; `thieu-quyen` = credential thiếu quyền có chủ đích (phép c8) */
  credentialLabel: string;
}

const CLASS_OF: Record<string, GatewayErrorClass> = {
  [SIM_NOT_FOUND]: "not-found",
  [SIM_THROTTLE]: "throttled",
  [SIM_TRANSIENT]: "transient",
  [SIM_DEPENDENCY_VIOLATION]: "dependency",
  [SIM_PERMANENT]: "permanent",
  [SIM_SEPARATE_TAGGING_REJECTED]: "separate-tagging",
};

/** Phân loại rồi BỎ lỗi gốc — SimCloudError cố ý mang sentinel ở chỗ SDK thật mang credential */
function sanitize(e: unknown): GatewayError {
  if (e instanceof GatewayError) return e;
  if (e instanceof SimCloudError) {
    return new GatewayError(
      CLASS_OF[e.code] ?? "transient",
      `cloud mô phỏng trả ${e.code}`,
    );
  }
  return new GatewayError(
    "transient",
    "lỗi không phân loại được từ cloud mô phỏng",
  );
}

async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw sanitize(e);
  }
}

/** Kind tồn tại độc lập với tài nguyên mà nó tham chiếu — xoá theo bậc `oidc-iam` SAU cluster */
const REFERENCE_ONLY_KINDS: readonly CreatedResourceKind[] = [
  "oidc-provider",
  "iam-role",
  "iam-policy",
  "service-account",
  "managed-identity",
];

export function createSimGateway(options: SimGatewayOptions): CloudGateway {
  const { cloud, codec, provider } = options;

  /** Mã hoá → kiểm luật của cloud → giải mã: chứng minh bộ tag này gửi được thật */
  const throughCodec = (
    tags: Readonly<Record<string, string>>,
  ): Record<string, string> => {
    const raw = codec.encode(tags);
    const problems = codec.problems(raw);
    if (problems.length > 0) {
      throw new GatewayError(
        "permanent",
        `tag không hợp lệ với ${provider}: ${problems.join("; ")}`,
      );
    }
    return codec.decode(raw);
  };

  const withProvider = (r: CreatedResource): CreatedResource => ({
    ...r,
    provider,
  });

  return {
    provider,
    region: "sim-region-1",

    whoAmI: () => guarded(() => `sim:${options.credentialLabel}`),

    checkPermissions: (required) =>
      guarded(() => ({
        missing:
          options.credentialLabel === "thieu-quyen" ? required.slice(0, 2) : [],
        confidence: "heuristic" as const,
        quotaWarnings: [],
      })),

    create: (req) =>
      guarded(() => {
        // SimCloud gắn một cha; lấy step phụ thuộc đầu tiên theo thứ tự khai của kế hoạch.
        // Kind định danh chỉ THAM CHIẾU cha (OIDC provider trỏ issuer của cluster), không bị
        // nó chứa: gắn vào thì cluster không xoá được trước chúng, trái thứ tự §4.2
        const parent = REFERENCE_ONLY_KINDS.includes(req.kind)
          ? undefined
          : Object.values(req.parents)[0];
        return withProvider(
          cloud.createResource({
            kind: req.kind,
            name: req.physicalName,
            tags: throughCodec(req.tags),
            idempotencyKey: req.idempotencyKey,
            ...(parent === undefined ? {} : { attachedTo: parent.id }),
          }),
        );
      }),

    findByTag: (key, value) =>
      guarded(() => cloud.findByTag(key, value).map(withProvider)),

    findByName: (kind: CreatedResourceKind, physicalName) =>
      guarded(() => {
        const r = cloud.findByName(kind, physicalName);
        return r === null ? null : withProvider(r);
      }),

    describe: (_kind, id) =>
      guarded(() => {
        const r = cloud.describeById(id);
        return r === null ? null : withProvider(r);
      }),

    isReady: (r) => guarded(() => cloud.pollReady(r.id)),

    remove: (r) => guarded(() => cloud.deleteResource(r.id)),

    listByProject: (projectId) =>
      guarded(() => {
        const out: CreatedResource[] = [];
        let cursor: string | undefined;
        do {
          const page = cloud.listTaggedPage(projectId, cursor);
          out.push(...page.items.map(withProvider));
          cursor = page.next;
        } while (cursor !== undefined);
        return out;
      }),

    clusterInfo: (clusterId) =>
      guarded(() => {
        const status = cloud.clusterStatusOf(clusterId);
        if (status === "ERROR") {
          throw new GatewayError(
            "not-found",
            `không thấy cluster ${clusterId}`,
          );
        }
        return {
          clusterId,
          clusterName: clusterId,
          apiEndpoint: `https://${clusterId}.sim.invalid`,
          caData: "c2ltLWNh",
          status,
        };
      }),

    kubeToken: (cluster) =>
      guarded(() => cloud.kubeTokenFor(cluster.clusterId)),
  };
}

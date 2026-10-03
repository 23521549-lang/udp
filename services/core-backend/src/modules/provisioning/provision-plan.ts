import type {
  CloudAdapter,
  CreatedResource,
  NetworkInfo,
  ProvisionClusterParams,
  ProvisionNetworkParams,
  ResourceQuota,
  ResourceStep,
} from "@udp/adapter-core";
import { z } from "zod";

/**
 * Kế hoạch provisioning của một project (Plan #28) — THUẦN: từ `payload` đã chốt lúc
 * `POST /provision` ra đúng tham số của hai pha. Worker, preview và bù trừ cùng dựng từ đây,
 * nên ba đường không thể lệch nhau về tên, tag hay khoá idempotency.
 *
 * `payload` là ảnh chụp tại lúc người dùng xác nhận (§8.1 "payload đầy đủ"): đổi quota hay
 * region sau đó không đổi lượt đang chạy, và resume sau khi worker chết dựng lại CÙNG tập
 * step — điều kiện để `lookup` theo khoá idempotency tìm lại được thứ đã tạo.
 */

/** Mạng riêng /16 của project — adapter Azure tự chọn dải pod không chồng lên nó */
export const DEFAULT_CIDR_BLOCK = "10.0.0.0/16";
/** Hai node: một node chết không kéo sập ứng dụng; không bao giờ vượt `maxNodes` của khách */
export const DEFAULT_NODE_COUNT = 2;
export const NETWORK_NAME = "udp";
export const CLUSTER_NAME = "main";
/** Bộ hợp đồng Cloud gọi mạng gốc là `vpc` ở mọi kế hoạch (`plan.ts` của cloud-adapters) */
const ROOT_NETWORK_STEP = "vpc";

const quotaSchema = z
  .object({
    maxNodes: z.number().int().min(1),
    maxNodeSize: z.enum(["small", "medium", "large"]),
    maxDatabases: z.number().int().min(0),
    maxStorageGb: z.number().int().min(0),
    maxLoadBalancers: z.number().int().min(0),
  })
  .strict();

export const provisionPayloadSchema = z
  .object({
    provider: z.enum(["aws", "gcp", "azure"]),
    region: z.string().min(1),
    cidrBlock: z.string().min(1),
    nodeSize: z.enum(["small", "medium", "large"]),
    nodeCount: z.number().int().min(1),
    controlPlaneCidrs: z.array(z.string().min(1)).min(1),
    quota: quotaSchema,
    /** Email chủ project — tag `udp.owner` */
    owner: z.string().min(1),
    /** ISO 8601 khi project có TTL — tag `udp.ttl` (§4.4 lớp 3) */
    expiresAt: z.string().nullable(),
  })
  .strict();

export type ProvisionPayload = z.infer<typeof provisionPayloadSchema>;

export function clusterShapeOf(quota: ResourceQuota): {
  nodeSize: ResourceQuota["maxNodeSize"];
  nodeCount: number;
} {
  return {
    nodeSize: quota.maxNodeSize,
    nodeCount: Math.min(DEFAULT_NODE_COUNT, quota.maxNodes),
  };
}

export function payloadOf(args: {
  provider: ProvisionPayload["provider"];
  region: string;
  quota: ResourceQuota;
  owner: string;
  expiresAt: Date | null;
  controlPlaneCidrs: readonly string[];
}): ProvisionPayload {
  return {
    provider: args.provider,
    region: args.region,
    cidrBlock: DEFAULT_CIDR_BLOCK,
    ...clusterShapeOf(args.quota),
    controlPlaneCidrs: [...args.controlPlaneCidrs],
    quota: { ...args.quota },
    owner: args.owner,
    expiresAt: args.expiresAt?.toISOString() ?? null,
  };
}

/** Bốn tag bắt buộc + `udp.ttl` khi có hạn (`expectedTagKeys`); `udp.key` do adapter gắn */
export function tagsOf(
  projectId: string,
  payload: ProvisionPayload,
): Record<string, string> {
  return {
    "udp.project": projectId,
    "udp.owner": payload.owner,
    "udp.managed": "true",
    ...(payload.expiresAt === null ? {} : { "udp.ttl": payload.expiresAt }),
  };
}

export function networkParamsOf(
  projectId: string,
  payload: ProvisionPayload,
): ProvisionNetworkParams {
  return {
    projectId,
    networkName: NETWORK_NAME,
    cidrBlock: payload.cidrBlock,
    region: payload.region,
    quota: payload.quota,
    idempotencyKey: `${projectId}:NETWORK:vpc:${ROOT_NETWORK_STEP}`,
    tags: tagsOf(projectId, payload),
    controlPlaneCidrs: payload.controlPlaneCidrs,
  };
}

export function clusterParamsOf(
  projectId: string,
  payload: ProvisionPayload,
): ProvisionClusterParams {
  return {
    projectId,
    clusterName: CLUSTER_NAME,
    nodeSize: payload.nodeSize,
    nodeCount: payload.nodeCount,
    quota: payload.quota,
    region: payload.region,
    idempotencyKey: `${projectId}:CLUSTER:cluster:cluster`,
    tags: tagsOf(projectId, payload),
    controlPlaneCidrs: payload.controlPlaneCidrs,
  };
}

/**
 * `NetworkInfo` cho pha CLUSTER: dải của payload, id của mạng gốc khi đã biết. Chưa biết
 * (bù trừ một job chưa từng qua pha mạng) thì id rỗng — danh sách step lúc đó chỉ dùng để
 * tra và xoá theo khoá idempotency, không `create` gì.
 */
export function networkInfoOf(
  payload: ProvisionPayload,
  network: Readonly<Record<string, CreatedResource>>,
): NetworkInfo {
  return {
    networkId: network[ROOT_NETWORK_STEP]?.id ?? "",
    networkName: NETWORK_NAME,
    cidrBlock: payload.cidrBlock,
  };
}

export interface PhaseSteps {
  network: ResourceStep[];
  cluster: ResourceStep[];
}

export function phaseSteps(
  adapter: CloudAdapter,
  projectId: string,
  payload: ProvisionPayload,
  network: Readonly<Record<string, CreatedResource>> = {},
): PhaseSteps {
  return {
    network: adapter.networkSteps(networkParamsOf(projectId, payload)),
    cluster: adapter.clusterSteps(
      clusterParamsOf(projectId, payload),
      networkInfoOf(payload, network),
    ),
  };
}

/**
 * Thời gian ước tính, phút — dải có chủ đích, không một con số: tạo control plane là phần
 * dài nhất và dao động theo cloud (EKS 15–20 phút, GKE/AKS nhanh hơn), mỗi bậc domain thêm
 * vài phút cài chart. Hiển thị ở bước xem trước (§8.1 `estimatedTime`).
 */
const CLOUD_MINUTES: Readonly<
  Record<ProvisionPayload["provider"], { min: number; max: number }>
> = {
  aws: { min: 15, max: 25 },
  gcp: { min: 8, max: 15 },
  azure: { min: 10, max: 20 },
};
const MINUTES_PER_DOMAIN_TIER = { min: 1, max: 4 };

export function estimatedMinutesOf(
  provider: ProvisionPayload["provider"],
  domainTiers: number,
): { min: number; max: number } {
  const base = CLOUD_MINUTES[provider];
  return {
    min: base.min + domainTiers * MINUTES_PER_DOMAIN_TIER.min,
    max: base.max + domainTiers * MINUTES_PER_DOMAIN_TIER.max,
  };
}

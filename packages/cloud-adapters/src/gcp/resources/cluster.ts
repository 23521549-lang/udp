import { gcpGetOrNull, gcpRequest } from "../http.js";
import { PODS_RANGE, SERVICES_RANGE } from "../plan.js";
import {
  ownershipMarker,
  parentOf,
  required,
  specOf,
  type GcpKindHandler,
  type GcpScope,
} from "./types.js";

/**
 * GKE: cluster và node pool. Tạo trả về ngay khi operation BẮT ĐẦU (tạo cluster mất 5–10
 * phút); `waitReady` của lõi đọc `status`. Cluster sinh kèm một node pool hệ thống nhỏ
 * (GKE không cho cluster rỗng node); node pool của workload là step riêng, theo cỡ.
 */

const CONTAINER = "https://container.googleapis.com/v1";
const clusters = (s: GcpScope) =>
  `${CONTAINER}/projects/${s.gcpProject}/locations/${s.region}/clusters`;

const SYSTEM_POOL_MACHINE = "e2-standard-2";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export interface GkeCluster {
  name?: string;
  description?: string;
  status?: string;
  endpoint?: string;
  resourceLabels?: Record<string, string>;
  masterAuth?: { clusterCaCertificate?: string };
}

export const clusterHandler: GcpKindHandler = {
  create: async (ctx) => {
    const spec = specOf(ctx, "cluster");
    const vpc = parentOf(ctx, "vpc");
    const subnet = parentOf(ctx, "subnet");
    const sa = parentOf(ctx, "node-sa");
    await gcpRequest(ctx.scope.http, "POST", clusters(ctx.scope), {
      cluster: {
        name: ctx.physicalName,
        description: ownershipMarker(ctx.idempotencyKey),
        network: vpc.id,
        subnetwork: subnet.id,
        resourceLabels: { ...ctx.labels },
        releaseChannel: { channel: spec.releaseChannel },
        ipAllocationPolicy: {
          useIpAliases: true,
          clusterSecondaryRangeName: PODS_RANGE,
          servicesSecondaryRangeName: SERVICES_RANGE,
        },
        privateClusterConfig: {
          enablePrivateNodes: true,
          enablePrivateEndpoint: false,
          masterIpv4CidrBlock: spec.masterCidr,
        },
        // API server chỉ mở cho control plane của UDP (ADR-06)
        masterAuthorizedNetworksConfig: {
          enabled: true,
          cidrBlocks: spec.authorizedCidrs.map((cidrBlock) => ({ cidrBlock })),
        },
        workloadIdentityConfig: {
          workloadPool: `${ctx.scope.gcpProject}.svc.id.goog`,
        },
        nodePools: [
          {
            name: "system",
            initialNodeCount: 1,
            config: {
              machineType: SYSTEM_POOL_MACHINE,
              serviceAccount: sa.id,
              oauthScopes: [CLOUD_PLATFORM_SCOPE],
            },
          },
        ],
      },
    });
    return ctx.physicalName;
  },
  describe: async (s, id) => {
    const c = await gcpGetOrNull<GkeCluster>(s.http, `${clusters(s)}/${id}`);
    if (c === null) return null;
    return {
      labels: { ...c.resourceLabels },
      description: c.description ?? "",
      ready: c.status === "RUNNING",
      failed: c.status === "ERROR",
    };
  },
  remove: async (s, id) => {
    await gcpRequest(s.http, "DELETE", `${clusters(s)}/${id}`);
  },
};

export const nodePoolIdOf = (id: string): { cluster: string; pool: string } => {
  const [cluster, pool] = id.split("/");
  return {
    cluster: required(cluster, `cluster trong ${id}`),
    pool: required(pool, `node pool trong ${id}`),
  };
};

interface GkeNodePool {
  status?: string;
}

export const nodePoolHandler: GcpKindHandler = {
  create: async (ctx) => {
    const spec = specOf(ctx, "nodegroup");
    const cluster = parentOf(ctx, "cluster");
    const sa = parentOf(ctx, "node-sa");
    await gcpRequest(
      ctx.scope.http,
      "POST",
      `${clusters(ctx.scope)}/${cluster.id}/nodePools`,
      {
        nodePool: {
          name: ctx.physicalName,
          initialNodeCount: spec.nodeCount,
          config: {
            machineType: spec.machineType,
            serviceAccount: sa.id,
            oauthScopes: [CLOUD_PLATFORM_SCOPE],
          },
          autoscaling: {
            enabled: true,
            minNodeCount: 1,
            maxNodeCount: spec.maxNodeCount,
          },
        },
      },
    );
    return `${cluster.id}/${ctx.physicalName}`;
  },
  describe: async (s, id) => {
    const { cluster, pool } = nodePoolIdOf(id);
    const np = await gcpGetOrNull<GkeNodePool>(
      s.http,
      `${clusters(s)}/${cluster}/nodePools/${pool}`,
    );
    return np === null
      ? null
      : {
          labels: {},
          description: "",
          ready: np.status === "RUNNING",
          failed: np.status === "ERROR",
        };
  },
  remove: async (s, id) => {
    const { cluster, pool } = nodePoolIdOf(id);
    await gcpRequest(
      s.http,
      "DELETE",
      `${clusters(s)}/${cluster}/nodePools/${pool}`,
    );
  },
};

export { clusters as clustersUrl };

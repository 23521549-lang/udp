import { DescribeClusterCommand } from "@aws-sdk/client-eks";
import { GetRoleCommand } from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type {
  ClusterInfo,
  CreatedResource,
  CreatedResourceKind,
  ResolvedCredential,
} from "@udp/adapter-core";
import { GatewayError, type CloudGateway } from "../core/gateway.js";
import type { AwsClients } from "./clients.js";
import { findAwsByTag } from "./discovery.js";
import { aws, awsOrNull } from "./errors.js";
import { eksKubeToken } from "./kube-token.js";
import type { AwsSpec } from "./plan.js";
import { checkAwsPermissions } from "./permissions.js";
import { clusterHandler, nodegroupHandler } from "./resources/cluster.js";
import { iamRoleHandler, oidcProviderHandler } from "./resources/identity.js";
import {
  k8sEniHandler,
  k8sLoadBalancerHandler,
  k8sVolumeHandler,
} from "./resources/k8s-managed.js";
import {
  elasticIpHandler,
  internetGatewayHandler,
  natGatewayHandler,
  routeTableHandler,
  securityGroupHandler,
  subnetHandler,
  vpcHandler,
} from "./resources/network.js";
import { required, type AwsKindHandler } from "./resources/types.js";
import { awsTagCodec } from "./tags.js";

const HANDLERS: Partial<Record<CreatedResourceKind, AwsKindHandler>> = {
  vpc: vpcHandler,
  subnet: subnetHandler,
  "internet-gateway": internetGatewayHandler,
  "elastic-ip": elasticIpHandler,
  "nat-gateway": natGatewayHandler,
  "route-table": routeTableHandler,
  "security-group": securityGroupHandler,
  "iam-role": iamRoleHandler,
  "oidc-provider": oidcProviderHandler,
  cluster: clusterHandler,
  nodegroup: nodegroupHandler,
  "k8s-loadbalancer": k8sLoadBalancerHandler,
  "k8s-volume": k8sVolumeHandler,
  "k8s-eni": k8sEniHandler,
};

/**
 * Kind mà lệnh xoá của AWS trả về NGAY còn tài nguyên thì biến mất sau vài phút. `remove`
 * chờ tới khi nó biến mất thật: teardown xoá theo bậc, và bậc sau (subnet, VPC) chỉ xoá
 * được khi bậc trước đã đi hẳn — nếu không là `DependencyViolation` vĩnh viễn.
 */
const ASYNC_DELETE: readonly CreatedResourceKind[] = [
  "nodegroup",
  "cluster",
  "nat-gateway",
  "k8s-loadbalancer",
];

const EKS_STATUS: Record<string, ClusterInfo["status"]> = {
  CREATING: "PROVISIONING",
  UPDATING: "PROVISIONING",
  PENDING: "PROVISIONING",
  ACTIVE: "READY",
  FAILED: "ERROR",
  DELETING: "DELETING",
};

export interface AwsGatewayOptions {
  region: string;
  clients: AwsClients;
  credential: ResolvedCredential;
  deleteWait: { intervalMs: number; timeoutMs: number };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function handlerOf(kind: CreatedResourceKind): AwsKindHandler {
  const handler = HANDLERS[kind];
  if (handler === undefined) {
    throw new GatewayError(
      "permanent",
      `AWS không có kind ${kind} trong kế hoạch EKS`,
    );
  }
  return handler;
}

export function createAwsGateway(options: AwsGatewayOptions): CloudGateway {
  const { clients: c, region } = options;

  const view = (
    kind: CreatedResourceKind,
    id: string,
    tags: Record<string, string>,
  ): CreatedResource => ({
    kind,
    id,
    provider: "aws",
    region: kind === "iam-role" || kind === "oidc-provider" ? "global" : region,
    createdAt: new Date(options.now()).toISOString(),
    tags,
  });

  const describe = async (kind: CreatedResourceKind, id: string) => {
    const d = await handlerOf(kind).describe(c, id);
    return d === null
      ? null
      : { resource: view(kind, id, d.tags), ready: d.ready };
  };

  const waitGone = async (r: CreatedResource): Promise<void> => {
    const deadline = options.now() + options.deleteWait.timeoutMs;
    while ((await describe(r.kind, r.id)) !== null) {
      if (options.now() >= deadline) {
        throw new GatewayError(
          "transient",
          `${r.kind} ${r.id} chưa biến mất sau ${String(options.deleteWait.timeoutMs)} ms`,
        );
      }
      await options.sleep(options.deleteWait.intervalMs);
    }
  };

  return {
    provider: "aws",
    region,

    whoAmI: async () => {
      const res = await aws(() => c.sts.send(new GetCallerIdentityCommand({})));
      return required(res.Arn, "Arn của credential");
    },

    checkPermissions: (actions) => checkAwsPermissions(c, actions),

    create: async (req) => {
      const problems = awsTagCodec.problems(awsTagCodec.encode(req.tags));
      if (problems.length > 0) {
        throw new GatewayError(
          "permanent",
          `tag không hợp lệ: ${problems.join("; ")}`,
        );
      }
      const id = await handlerOf(req.kind).create({
        clients: c,
        region,
        physicalName: req.physicalName,
        idempotencyKey: req.idempotencyKey,
        spec: req.spec as AwsSpec,
        tags: req.tags,
        parents: req.parents,
      });
      return view(req.kind, id, { ...req.tags });
    },

    findByTag: (key, value) => findAwsByTag(c, region, key, value),

    /**
     * Kế hoạch AWS không có kind phải tra theo tên (mọi API nhận tag lúc tạo). Hai kind có
     * tên vật lý là định danh — role và cluster — tra được; kind khác ném, để lookup ra
     * `indeterminate` chứ không ra `absent` giả.
     */
    findByName: async (kind, physicalName) => {
      if (kind === "iam-role") {
        const res = await awsOrNull(() =>
          c.iam.send(new GetRoleCommand({ RoleName: physicalName })),
        );
        const arn = res?.Role?.Arn;
        return arn === undefined
          ? null
          : ((await describe(kind, arn))?.resource ?? null);
      }
      if (kind === "cluster") {
        return (await describe(kind, physicalName))?.resource ?? null;
      }
      throw new GatewayError("permanent", `AWS không tra ${kind} theo tên`);
    },

    describe: async (kind, id) => (await describe(kind, id))?.resource ?? null,

    isReady: async (r) => {
      const d = await describe(r.kind, r.id);
      if (d === null) {
        throw new GatewayError(
          "not-found",
          `${r.kind} ${r.id} biến mất khi đang chờ sẵn sàng`,
        );
      }
      return d.ready;
    },

    remove: async (r) => {
      try {
        await handlerOf(r.kind).remove(c, r.id);
      } catch (e) {
        if (e instanceof GatewayError && e.errorClass === "not-found")
          return "not-found";
        throw e;
      }
      if (ASYNC_DELETE.includes(r.kind)) await waitGone(r);
      return "deleted";
    },

    listByProject: (projectId) =>
      findAwsByTag(c, region, "udp.project", projectId),

    clusterInfo: async (clusterId) => {
      const res = await aws(() =>
        c.eks.send(new DescribeClusterCommand({ name: clusterId })),
      );
      const cluster = required(res.cluster, "cluster");
      return {
        clusterId,
        clusterName: required(cluster.name, "cluster.name"),
        apiEndpoint: required(cluster.endpoint, "cluster.endpoint"),
        caData: required(
          cluster.certificateAuthority?.data,
          "certificateAuthority.data",
        ),
        status: EKS_STATUS[cluster.status ?? ""] ?? "ERROR",
      };
    },

    kubeToken: (cluster) =>
      eksKubeToken(
        options.credential,
        region,
        cluster.clusterName,
        options.now,
      ),
  };
}

import {
  CreateClusterCommand,
  CreateNodegroupCommand,
  DeleteClusterCommand,
  DeleteNodegroupCommand,
  DescribeClusterCommand,
  DescribeNodegroupCommand,
} from "@aws-sdk/client-eks";
import { aws, awsOrNull } from "../errors.js";
import { clientToken } from "./network.js";
import {
  parentOf,
  parentsOfKind,
  required,
  specOf,
  type AwsKindHandler,
} from "./types.js";

/**
 * EKS: cluster và managed node group. `id` của cluster là TÊN (EKS định danh theo tên);
 * `id` của node group là `<cluster>/<nodegroup>` — cặp mà mọi API node group đòi.
 */

export const nodegroupIdOf = (
  id: string,
): { clusterName: string; nodegroupName: string } => {
  const [clusterName, nodegroupName] = id.split("/");
  return {
    clusterName: required(clusterName, `tên cluster trong ${id}`),
    nodegroupName: required(nodegroupName, `tên node group trong ${id}`),
  };
};

export const clusterHandler: AwsKindHandler = {
  create: async (ctx) => {
    const s = specOf(ctx, "cluster");
    const role = parentOf(ctx, "iam-cluster");
    const sg = parentOf(ctx, "sg");
    const res = await aws(() =>
      ctx.clients.eks.send(
        new CreateClusterCommand({
          name: ctx.physicalName,
          version: s.kubernetesVersion,
          roleArn: role.id,
          resourcesVpcConfig: {
            subnetIds: parentsOfKind(ctx, "subnet").map((p) => p.id),
            securityGroupIds: [sg.id],
            endpointPrivateAccess: true,
            endpointPublicAccess: true,
            publicAccessCidrs: [...s.publicAccessCidrs],
          },
          tags: { ...ctx.tags },
          clientRequestToken: clientToken(ctx.idempotencyKey),
        }),
      ),
    );
    return required(res.cluster?.name, "cluster.name");
  },
  describe: async (c, id) => {
    const res = await awsOrNull(() =>
      c.eks.send(new DescribeClusterCommand({ name: id })),
    );
    const cluster = res?.cluster;
    // DELETING vẫn là CÒN: xoá EKS mất ~10 phút, và VPC chỉ xoá được khi nó biến mất hẳn
    return cluster === undefined
      ? null
      : { tags: { ...cluster.tags }, ready: cluster.status === "ACTIVE" };
  },
  remove: async (c, id) => {
    await aws(() => c.eks.send(new DeleteClusterCommand({ name: id })));
  },
};

export const nodegroupHandler: AwsKindHandler = {
  create: async (ctx) => {
    const s = specOf(ctx, "nodegroup");
    const cluster = parentOf(ctx, "cluster");
    const role = parentOf(ctx, "iam-node");
    const res = await aws(() =>
      ctx.clients.eks.send(
        new CreateNodegroupCommand({
          clusterName: cluster.id,
          nodegroupName: ctx.physicalName,
          nodeRole: role.id,
          subnets: parentsOfKind(ctx, "subnet").map((p) => p.id),
          instanceTypes: [s.instanceType],
          scalingConfig: {
            desiredSize: s.desiredSize,
            minSize: s.minSize,
            maxSize: s.maxSize,
          },
          tags: { ...ctx.tags },
          clientRequestToken: clientToken(ctx.idempotencyKey),
        }),
      ),
    );
    const name = required(res.nodegroup?.nodegroupName, "nodegroupName");
    return `${cluster.id}/${name}`;
  },
  describe: async (c, id) => {
    const { clusterName, nodegroupName } = nodegroupIdOf(id);
    const res = await awsOrNull(() =>
      c.eks.send(new DescribeNodegroupCommand({ clusterName, nodegroupName })),
    );
    const ng = res?.nodegroup;
    return ng === undefined
      ? null
      : { tags: { ...ng.tags }, ready: ng.status === "ACTIVE" };
  },
  remove: async (c, id) => {
    const { clusterName, nodegroupName } = nodegroupIdOf(id);
    await aws(() =>
      c.eks.send(new DeleteNodegroupCommand({ clusterName, nodegroupName })),
    );
  },
};

import {
  DeleteNetworkInterfaceCommand,
  DeleteVolumeCommand,
  DescribeNetworkInterfacesCommand,
  DescribeVolumesCommand,
} from "@aws-sdk/client-ec2";
import {
  DeleteLoadBalancerCommand,
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { GatewayError } from "../../core/gateway.js";
import { aws, awsOrNull } from "../errors.js";
import { tagsFromList } from "../tags.js";
import type { AwsKindHandler } from "./types.js";

/**
 * Tài nguyên do KUBERNETES sinh ra (§4.5 "chỗ mọi state file đều mù"): Service
 * LoadBalancer ⇒ ELB, PVC ⇒ EBS, pod ⇒ ENI. Adapter không bao giờ TẠO chúng, nhưng phải
 * đọc và xoá được, vì chúng giữ VPC lại và tiếp tục tính tiền sau khi cluster đã xoá.
 */
const neverCreated = (kind: string): Promise<string> =>
  Promise.reject(
    new GatewayError(
      "permanent",
      `${kind} do Kubernetes tạo, adapter không tạo`,
    ),
  );

export const k8sLoadBalancerHandler: AwsKindHandler = {
  create: () => neverCreated("k8s-loadbalancer"),
  describe: async (c, arn) => {
    const res = await awsOrNull(() =>
      c.elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [arn] })),
    );
    if (res?.LoadBalancers?.[0] === undefined) return null;
    const tags = await aws(() =>
      c.elb.send(new DescribeTagsCommand({ ResourceArns: [arn] })),
    );
    return {
      tags: tagsFromList(tags.TagDescriptions?.[0]?.Tags),
      ready: true,
    };
  },
  remove: async (c, arn) => {
    await aws(() =>
      c.elb.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: arn })),
    );
  },
};

export const k8sVolumeHandler: AwsKindHandler = {
  create: () => neverCreated("k8s-volume"),
  describe: async (c, id) => {
    const res = await awsOrNull(() =>
      c.ec2.send(new DescribeVolumesCommand({ VolumeIds: [id] })),
    );
    const volume = res?.Volumes?.[0];
    return volume === undefined
      ? null
      : { tags: tagsFromList(volume.Tags), ready: true };
  },
  remove: async (c, id) => {
    await aws(() => c.ec2.send(new DeleteVolumeCommand({ VolumeId: id })));
  },
};

export const k8sEniHandler: AwsKindHandler = {
  create: () => neverCreated("k8s-eni"),
  describe: async (c, id) => {
    const res = await awsOrNull(() =>
      c.ec2.send(
        new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [id] }),
      ),
    );
    const eni = res?.NetworkInterfaces?.[0];
    return eni === undefined
      ? null
      : { tags: tagsFromList(eni.TagSet), ready: true };
  },
  remove: async (c, id) => {
    await aws(() =>
      c.ec2.send(new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: id })),
    );
  },
};

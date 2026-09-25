import {
  AllocateAddressCommand,
  AssociateRouteTableCommand,
  AttachInternetGatewayCommand,
  CreateInternetGatewayCommand,
  CreateNatGatewayCommand,
  CreateRouteCommand,
  CreateRouteTableCommand,
  CreateSecurityGroupCommand,
  CreateSubnetCommand,
  CreateVpcCommand,
  DeleteInternetGatewayCommand,
  DeleteNatGatewayCommand,
  DeleteRouteTableCommand,
  DeleteSecurityGroupCommand,
  DeleteSubnetCommand,
  DeleteVpcCommand,
  DescribeAddressesCommand,
  DescribeAvailabilityZonesCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  DetachInternetGatewayCommand,
  DisassociateRouteTableCommand,
  ModifySubnetAttributeCommand,
  ModifyVpcAttributeCommand,
  ReleaseAddressCommand,
  type ResourceType,
} from "@aws-sdk/client-ec2";
import { createHash } from "node:crypto";
import { aws, awsOrNull } from "../errors.js";
import { ec2Tags, tagsFromList } from "../tags.js";
import {
  parentOf,
  parentsOfKind,
  required,
  specOf,
  type AwsKindHandler,
} from "./types.js";

/**
 * Tài nguyên mạng EC2 của kế hoạch EKS. Mọi `Create*` gắn tag bằng `TagSpecifications`
 * NGAY lúc tạo — không có khoảng hở "đã tạo mà chưa có tag" cho lookup trượt (K3).
 */

const tagSpec = (
  type: ResourceType,
  tags: Readonly<Record<string, string>>,
) => [{ ResourceType: type, Tags: ec2Tags(tags) }];

/** Token idempotency của EC2/EKS (≤ 64 ký tự) — tất định theo khoá của step */
export const clientToken = (idempotencyKey: string): string =>
  createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);

export const vpcHandler: AwsKindHandler = {
  create: async (ctx) => {
    const s = specOf(ctx, "vpc");
    const res = await aws(() =>
      ctx.clients.ec2.send(
        new CreateVpcCommand({
          CidrBlock: s.cidrBlock,
          TagSpecifications: tagSpec("vpc", ctx.tags),
        }),
      ),
    );
    const id = required(res.Vpc?.VpcId, "VpcId");
    // EKS đòi DNS hostname trong VPC, nếu không node không đăng ký được vào cluster
    await aws(() =>
      ctx.clients.ec2.send(
        new ModifyVpcAttributeCommand({
          VpcId: id,
          EnableDnsHostnames: { Value: true },
        }),
      ),
    );
    return id;
  },
  describe: async (c, id) => {
    const res = await awsOrNull(() =>
      c.ec2.send(new DescribeVpcsCommand({ VpcIds: [id] })),
    );
    const vpc = res?.Vpcs?.[0];
    return vpc === undefined
      ? null
      : { tags: tagsFromList(vpc.Tags), ready: vpc.State === "available" };
  },
  remove: async (c, id) => {
    await aws(() => c.ec2.send(new DeleteVpcCommand({ VpcId: id })));
  },
};

export const subnetHandler: AwsKindHandler = {
  create: async (ctx) => {
    const s = specOf(ctx, "subnet");
    const vpc = parentOf(ctx, "vpc");
    const zones = await aws(() =>
      ctx.clients.ec2.send(
        new DescribeAvailabilityZonesCommand({
          Filters: [{ Name: "state", Values: ["available"] }],
        }),
      ),
    );
    const names = (zones.AvailabilityZones ?? [])
      .flatMap((z) => (z.ZoneName === undefined ? [] : [z.ZoneName]))
      .sort();
    const zone = required(
      names[s.azIndex % Math.max(1, names.length)],
      "availability zone",
    );
    const elbRole =
      s.tier === "public"
        ? "kubernetes.io/role/elb"
        : "kubernetes.io/role/internal-elb";
    const res = await aws(() =>
      ctx.clients.ec2.send(
        new CreateSubnetCommand({
          VpcId: vpc.id,
          CidrBlock: s.cidrBlock,
          AvailabilityZone: zone,
          TagSpecifications: tagSpec("subnet", {
            ...ctx.tags,
            // Tag để controller load balancer của EKS chọn đúng subnet cho ELB
            [elbRole]: "1",
            [`kubernetes.io/cluster/${s.clusterName}`]: "shared",
          }),
        }),
      ),
    );
    const id = required(res.Subnet?.SubnetId, "SubnetId");
    if (s.tier === "public") {
      await aws(() =>
        ctx.clients.ec2.send(
          new ModifySubnetAttributeCommand({
            SubnetId: id,
            MapPublicIpOnLaunch: { Value: true },
          }),
        ),
      );
    }
    return id;
  },
  describe: async (c, id) => {
    const res = await awsOrNull(() =>
      c.ec2.send(new DescribeSubnetsCommand({ SubnetIds: [id] })),
    );
    const subnet = res?.Subnets?.[0];
    return subnet === undefined
      ? null
      : {
          tags: tagsFromList(subnet.Tags),
          ready: subnet.State === "available",
        };
  },
  remove: async (c, id) => {
    await aws(() => c.ec2.send(new DeleteSubnetCommand({ SubnetId: id })));
  },
};

export const internetGatewayHandler: AwsKindHandler = {
  create: async (ctx) => {
    const vpc = parentOf(ctx, "vpc");
    const res = await aws(() =>
      ctx.clients.ec2.send(
        new CreateInternetGatewayCommand({
          TagSpecifications: tagSpec("internet-gateway", ctx.tags),
        }),
      ),
    );
    const id = required(
      res.InternetGateway?.InternetGatewayId,
      "InternetGatewayId",
    );
    await aws(() =>
      ctx.clients.ec2.send(
        new AttachInternetGatewayCommand({
          InternetGatewayId: id,
          VpcId: vpc.id,
        }),
      ),
    );
    return id;
  },
  describe: async (c, id) => {
    const res = await awsOrNull(() =>
      c.ec2.send(
        new DescribeInternetGatewaysCommand({ InternetGatewayIds: [id] }),
      ),
    );
    const igw = res?.InternetGateways?.[0];
    return igw === undefined
      ? null
      : { tags: tagsFromList(igw.Tags), ready: true };
  },
  remove: async (c, id) => {
    const res = await aws(() =>
      c.ec2.send(
        new DescribeInternetGatewaysCommand({ InternetGatewayIds: [id] }),
      ),
    );
    // Gỡ khỏi VPC trước: xoá IGW còn gắn là DependencyViolation vĩnh viễn
    for (const attachment of res.InternetGateways?.[0]?.Attachments ?? []) {
      const vpcId = attachment.VpcId;
      if (vpcId === undefined) continue;
      await aws(() =>
        c.ec2.send(
          new DetachInternetGatewayCommand({
            InternetGatewayId: id,
            VpcId: vpcId,
          }),
        ),
      );
    }
    await aws(() =>
      c.ec2.send(new DeleteInternetGatewayCommand({ InternetGatewayId: id })),
    );
  },
};

export const elasticIpHandler: AwsKindHandler = {
  create: async (ctx) => {
    const res = await aws(() =>
      ctx.clients.ec2.send(
        new AllocateAddressCommand({
          Domain: "vpc",
          TagSpecifications: tagSpec("elastic-ip", ctx.tags),
        }),
      ),
    );
    return required(res.AllocationId, "AllocationId");
  },
  describe: async (c, id) => {
    const res = await awsOrNull(() =>
      c.ec2.send(new DescribeAddressesCommand({ AllocationIds: [id] })),
    );
    const address = res?.Addresses?.[0];
    return address === undefined
      ? null
      : { tags: tagsFromList(address.Tags), ready: true };
  },
  remove: async (c, id) => {
    await aws(() =>
      c.ec2.send(new ReleaseAddressCommand({ AllocationId: id })),
    );
  },
};

export const natGatewayHandler: AwsKindHandler = {
  create: async (ctx) => {
    const subnet = parentOf(ctx, "subnet-public-a");
    const eip = parentOf(ctx, "eip");
    const res = await aws(() =>
      ctx.clients.ec2.send(
        new CreateNatGatewayCommand({
          SubnetId: subnet.id,
          AllocationId: eip.id,
          ClientToken: clientToken(ctx.idempotencyKey),
          TagSpecifications: tagSpec("natgateway", ctx.tags),
        }),
      ),
    );
    return required(res.NatGateway?.NatGatewayId, "NatGatewayId");
  },
  describe: async (c, id) => {
    const res = await awsOrNull(() =>
      c.ec2.send(new DescribeNatGatewaysCommand({ NatGatewayIds: [id] })),
    );
    const nat = res?.NatGateways?.[0];
    // NAT đã xoá vẫn hiện một giờ với State=deleted: với lookup đó là KHÔNG còn
    if (nat === undefined || nat.State === "deleted") return null;
    return { tags: tagsFromList(nat.Tags), ready: nat.State === "available" };
  },
  remove: async (c, id) => {
    await aws(() =>
      c.ec2.send(new DeleteNatGatewayCommand({ NatGatewayId: id })),
    );
  },
};

export const routeTableHandler: AwsKindHandler = {
  create: async (ctx) => {
    const s = specOf(ctx, "route-table");
    const vpc = parentOf(ctx, "vpc");
    const target = required(parentsOfKind(ctx, s.via)[0], `đích ${s.via}`);
    const res = await aws(() =>
      ctx.clients.ec2.send(
        new CreateRouteTableCommand({
          VpcId: vpc.id,
          TagSpecifications: tagSpec("route-table", ctx.tags),
        }),
      ),
    );
    const id = required(res.RouteTable?.RouteTableId, "RouteTableId");
    await aws(() =>
      ctx.clients.ec2.send(
        new CreateRouteCommand({
          RouteTableId: id,
          DestinationCidrBlock: "0.0.0.0/0",
          ...(s.via === "internet-gateway"
            ? { GatewayId: target.id }
            : { NatGatewayId: target.id }),
        }),
      ),
    );
    for (const subnet of parentsOfKind(ctx, "subnet")) {
      await aws(() =>
        ctx.clients.ec2.send(
          new AssociateRouteTableCommand({
            RouteTableId: id,
            SubnetId: subnet.id,
          }),
        ),
      );
    }
    return id;
  },
  describe: async (c, id) => {
    const res = await awsOrNull(() =>
      c.ec2.send(new DescribeRouteTablesCommand({ RouteTableIds: [id] })),
    );
    const table = res?.RouteTables?.[0];
    return table === undefined
      ? null
      : { tags: tagsFromList(table.Tags), ready: true };
  },
  remove: async (c, id) => {
    const res = await aws(() =>
      c.ec2.send(new DescribeRouteTablesCommand({ RouteTableIds: [id] })),
    );
    for (const association of res.RouteTables?.[0]?.Associations ?? []) {
      const associationId = association.RouteTableAssociationId;
      if (association.Main === true || associationId === undefined) continue;
      await aws(() =>
        c.ec2.send(
          new DisassociateRouteTableCommand({ AssociationId: associationId }),
        ),
      );
    }
    await aws(() =>
      c.ec2.send(new DeleteRouteTableCommand({ RouteTableId: id })),
    );
  },
};

export const securityGroupHandler: AwsKindHandler = {
  create: async (ctx) => {
    const s = specOf(ctx, "security-group");
    const vpc = parentOf(ctx, "vpc");
    const res = await aws(() =>
      ctx.clients.ec2.send(
        new CreateSecurityGroupCommand({
          GroupName: ctx.physicalName,
          Description: s.description,
          VpcId: vpc.id,
          TagSpecifications: tagSpec("security-group", ctx.tags),
        }),
      ),
    );
    return required(res.GroupId, "GroupId");
  },
  describe: async (c, id) => {
    const res = await awsOrNull(() =>
      c.ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [id] })),
    );
    const group = res?.SecurityGroups?.[0];
    return group === undefined
      ? null
      : { tags: tagsFromList(group.Tags), ready: true };
  },
  remove: async (c, id) => {
    await aws(() =>
      c.ec2.send(new DeleteSecurityGroupCommand({ GroupId: id })),
    );
  },
};

import { DescribeClusterCommand } from "@aws-sdk/client-eks";
import {
  AttachRolePolicyCommand,
  CreateOpenIDConnectProviderCommand,
  CreateRoleCommand,
  DeleteOpenIDConnectProviderCommand,
  DeleteRoleCommand,
  DetachRolePolicyCommand,
  GetOpenIDConnectProviderCommand,
  GetRoleCommand,
  ListAttachedRolePoliciesCommand,
} from "@aws-sdk/client-iam";
import { aws, awsOrNull } from "../errors.js";
import { ec2Tags, tagsFromList } from "../tags.js";
import { parentOf, required, specOf, type AwsKindHandler } from "./types.js";

/**
 * IAM role và OIDC provider. IAM là dịch vụ TOÀN CỤC: `id` của hai kind này là ARN (chứa
 * sẵn tên), vì step sau (cluster, node group) cần đúng ARN để truyền cho EKS.
 */

/** Mọi role của UDP nằm dưới một path riêng — quét IAM theo tag chỉ đi trong path này */
export const UDP_IAM_PATH = "/udp/";

/**
 * Thumbprint CA gốc của OIDC issuer EKS. Từ 2023 IAM tự tin CA của issuer EKS và bỏ qua
 * giá trị này, nhưng API vẫn bắt buộc tham số — dùng thumbprint gốc công bố của AWS.
 */
export const EKS_OIDC_ROOT_THUMBPRINT =
  "9e99a48a9960b14926bb7f3b02e22da2b0ab7280";

export const roleNameOf = (arn: string): string =>
  required(arn.split("/").pop(), `tên role trong ${arn}`);

const trustPolicy = (service: string): string =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: service },
        Action: "sts:AssumeRole",
      },
    ],
  });

export const iamRoleHandler: AwsKindHandler = {
  create: async (ctx) => {
    const s = specOf(ctx, "iam-role");
    const res = await aws(() =>
      ctx.clients.iam.send(
        new CreateRoleCommand({
          RoleName: ctx.physicalName,
          Path: UDP_IAM_PATH,
          AssumeRolePolicyDocument: trustPolicy(s.service),
          Tags: ec2Tags(ctx.tags),
        }),
      ),
    );
    const arn = required(res.Role?.Arn, "Role.Arn");
    for (const policyArn of s.managedPolicyArns) {
      await aws(() =>
        ctx.clients.iam.send(
          new AttachRolePolicyCommand({
            RoleName: ctx.physicalName,
            PolicyArn: policyArn,
          }),
        ),
      );
    }
    return arn;
  },
  describe: async (c, id) => {
    const res = await awsOrNull(() =>
      c.iam.send(new GetRoleCommand({ RoleName: roleNameOf(id) })),
    );
    return res?.Role === undefined
      ? null
      : { tags: tagsFromList(res.Role.Tags), ready: true };
  },
  remove: async (c, id) => {
    const roleName = roleNameOf(id);
    // Role còn policy gắn là DeleteConflict vĩnh viễn: tháo hết trước
    const attached = await aws(() =>
      c.iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName })),
    );
    for (const policy of attached.AttachedPolicies ?? []) {
      const policyArn = policy.PolicyArn;
      if (policyArn === undefined) continue;
      await aws(() =>
        c.iam.send(
          new DetachRolePolicyCommand({
            RoleName: roleName,
            PolicyArn: policyArn,
          }),
        ),
      );
    }
    await aws(() => c.iam.send(new DeleteRoleCommand({ RoleName: roleName })));
  },
};

export const oidcProviderHandler: AwsKindHandler = {
  create: async (ctx) => {
    const cluster = parentOf(ctx, "cluster");
    const described = await aws(() =>
      ctx.clients.eks.send(new DescribeClusterCommand({ name: cluster.id })),
    );
    const issuer = required(
      described.cluster?.identity?.oidc?.issuer,
      "OIDC issuer của cluster",
    );
    const res = await aws(() =>
      ctx.clients.iam.send(
        new CreateOpenIDConnectProviderCommand({
          Url: issuer,
          ClientIDList: ["sts.amazonaws.com"],
          ThumbprintList: [EKS_OIDC_ROOT_THUMBPRINT],
          Tags: ec2Tags(ctx.tags),
        }),
      ),
    );
    return required(res.OpenIDConnectProviderArn, "OpenIDConnectProviderArn");
  },
  describe: async (c, id) => {
    const res = await awsOrNull(() =>
      c.iam.send(
        new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: id }),
      ),
    );
    return res === null ? null : { tags: tagsFromList(res.Tags), ready: true };
  },
  remove: async (c, id) => {
    await aws(() =>
      c.iam.send(
        new DeleteOpenIDConnectProviderCommand({
          OpenIDConnectProviderArn: id,
        }),
      ),
    );
  },
};

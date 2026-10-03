import {
  AllocateAddressCommand,
  AssociateRouteTableCommand,
  CreateRouteCommand,
  CreateRouteTableCommand,
  CreateSubnetCommand,
  CreateVpcCommand,
  DeleteInternetGatewayCommand,
  DeleteVpcCommand,
  DescribeAccountAttributesCommand,
  DescribeAddressesCommand,
  DescribeAvailabilityZonesCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DetachInternetGatewayCommand,
  EC2Client,
  ModifySubnetAttributeCommand,
  ModifyVpcAttributeCommand,
} from "@aws-sdk/client-ec2";
import {
  DeleteClusterCommand,
  DescribeClusterCommand,
  EKSClient,
} from "@aws-sdk/client-eks";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  IAMClient,
  ListOpenIDConnectProvidersCommand,
  ListRolesCommand,
  ListRoleTagsCommand,
  SimulatePrincipalPolicyCommand,
} from "@aws-sdk/client-iam";
import {
  GetResourcesCommand,
  ResourceGroupsTaggingAPIClient,
} from "@aws-sdk/client-resource-groups-tagging-api";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  SecretBuffer,
  type CreatedResource,
  type ResolvedCredential,
} from "@udp/adapter-core";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { awsClientsFor, awsCredentialsOf } from "../../src/aws/clients.js";
import { classifyAwsError } from "../../src/aws/errors.js";
import { createAwsGateway } from "../../src/aws/gateway.js";
import { KUBE_TOKEN_TTL_MS } from "../../src/aws/kube-token.js";
import { policySourceArnOf } from "../../src/aws/permissions.js";
import { GatewayError, type CloudGateway } from "../../src/index.js";

/**
 * Cổng AWS ở tầng command SDK (Plan #26 AC-5): đúng lệnh, đúng tham số, lỗi phân loại
 * đúng và KHÔNG mang credential. Tài khoản AWS thật là nợ kiểm chứng `cloud-aws-live`.
 */

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY-SENTINEL";

const credential = (expiresInMs = 3_600_000): ResolvedCredential => {
  const payload = new SecretBuffer(
    JSON.stringify({
      accessKeyId: "AKIAEXAMPLEEXAMPLE",
      secretAccessKey: SECRET,
    }),
  );
  return {
    provider: "aws",
    mode: "BYOC",
    authKind: "AWS_KEY",
    payload,
    expiresAt: new Date(Date.now() + expiresInMs),
    dispose: () => payload.dispose(),
  };
};

const ec2 = mockClient(EC2Client);
const eks = mockClient(EKSClient);
const iam = mockClient(IAMClient);
const sts = mockClient(STSClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
mockClient(ElasticLoadBalancingV2Client);

afterEach(() => {
  for (const m of [ec2, eks, iam, sts, tagging]) m.reset();
});

function gateway(): CloudGateway {
  const cred = credential();
  return createAwsGateway({
    region: "ap-southeast-1",
    clients: awsClientsFor(cred, "ap-southeast-1"),
    credential: cred,
    deleteWait: { intervalMs: 0, timeoutMs: 1_000 },
    now: Date.now,
    sleep: () => Promise.resolve(),
  });
}

const TAGS = {
  "udp.project": "11111111-2222-3333-4444-555555555555",
  "udp.key": "11111111-2222-3333-4444-555555555555:NETWORK:vpc:vpc",
  "udp.owner": "owner-1",
  "udp.managed": "true",
};

const res = (kind: CreatedResource["kind"], id: string): CreatedResource => ({
  kind,
  id,
  provider: "aws",
  region: "ap-southeast-1",
  createdAt: new Date().toISOString(),
  tags: {},
});

describe("tạo tài nguyên mạng", () => {
  it("vpc: tag gắn TRONG lời gọi tạo, rồi bật DNS hostname cho EKS", async () => {
    ec2.on(CreateVpcCommand).resolves({ Vpc: { VpcId: "vpc-1" } });
    ec2.on(ModifyVpcAttributeCommand).resolves({});
    const r = await gateway().create({
      kind: "vpc",
      name: "vpc",
      physicalName: "udp-111111112222-vpc",
      idempotencyKey: TAGS["udp.key"],
      spec: { type: "vpc", cidrBlock: "10.0.0.0/16" },
      tags: TAGS,
      parents: {},
    });
    expect(r.id).toBe("vpc-1");
    const input = ec2.commandCalls(CreateVpcCommand)[0]?.args[0].input;
    expect(input?.TagSpecifications?.[0]?.ResourceType).toBe("vpc");
    expect(input?.TagSpecifications?.[0]?.Tags).toContainEqual({
      Key: "udp.key",
      Value: TAGS["udp.key"],
    });
    expect(
      ec2.commandCalls(ModifyVpcAttributeCommand)[0]?.args[0].input,
    ).toEqual({
      VpcId: "vpc-1",
      EnableDnsHostnames: { Value: true },
    });
  });

  it("subnet: AZ chọn theo chỉ số trên danh sách ĐÃ SẮP XẾP; công khai thì bật IP công khai", async () => {
    ec2.on(DescribeAvailabilityZonesCommand).resolves({
      AvailabilityZones: [
        { ZoneName: "ap-southeast-1c" },
        { ZoneName: "ap-southeast-1a" },
      ],
    });
    ec2.on(CreateSubnetCommand).resolves({ Subnet: { SubnetId: "subnet-1" } });
    ec2.on(ModifySubnetAttributeCommand).resolves({});
    await gateway().create({
      kind: "subnet",
      name: "subnet-public-b",
      physicalName: "x",
      idempotencyKey: "k",
      spec: {
        type: "subnet",
        cidrBlock: "10.0.16.0/20",
        azIndex: 1,
        tier: "public",
        clusterName: "udp-c",
      },
      tags: TAGS,
      parents: { vpc: res("vpc", "vpc-1") },
    });
    const input = ec2.commandCalls(CreateSubnetCommand)[0]?.args[0].input;
    expect(input?.AvailabilityZone).toBe("ap-southeast-1c");
    expect(input?.VpcId).toBe("vpc-1");
    expect(input?.TagSpecifications?.[0]?.Tags).toContainEqual({
      Key: "kubernetes.io/role/elb",
      Value: "1",
    });
    expect(ec2.commandCalls(ModifySubnetAttributeCommand)).toHaveLength(1);
  });

  it("route table riêng: 0.0.0.0/0 đi qua NAT và gắn cả hai subnet riêng", async () => {
    ec2
      .on(CreateRouteTableCommand)
      .resolves({ RouteTable: { RouteTableId: "rtb-1" } });
    ec2.on(CreateRouteCommand).resolves({});
    ec2.on(AssociateRouteTableCommand).resolves({});
    await gateway().create({
      kind: "route-table",
      name: "rtb-private",
      physicalName: "x",
      idempotencyKey: "k",
      spec: { type: "route-table", via: "nat-gateway" },
      tags: TAGS,
      parents: {
        vpc: res("vpc", "vpc-1"),
        nat: res("nat-gateway", "nat-1"),
        "subnet-private-a": res("subnet", "subnet-a"),
        "subnet-private-b": res("subnet", "subnet-b"),
      },
    });
    expect(ec2.commandCalls(CreateRouteCommand)[0]?.args[0].input).toEqual({
      RouteTableId: "rtb-1",
      DestinationCidrBlock: "0.0.0.0/0",
      NatGatewayId: "nat-1",
    });
    expect(
      ec2
        .commandCalls(AssociateRouteTableCommand)
        .map((c) => c.args[0].input.SubnetId),
    ).toEqual(["subnet-a", "subnet-b"]);
  });

  it("thiếu tài nguyên cha ⇒ lỗi vĩnh viễn, KHÔNG gọi AWS", async () => {
    await expect(
      gateway().create({
        kind: "elastic-ip",
        name: "eip",
        physicalName: "x",
        idempotencyKey: "k",
        spec: { type: "elastic-ip" },
        tags: { ...TAGS, "aws:reserved": "x" },
        parents: {},
      }),
    ).rejects.toMatchObject({ errorClass: "permanent" });
    expect(ec2.commandCalls(AllocateAddressCommand)).toHaveLength(0);
  });
});

describe("đọc và xoá", () => {
  it("NAT đã xoá (State=deleted) là KHÔNG còn", async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({
      NatGateways: [{ NatGatewayId: "nat-1", State: "deleted" }],
    });
    expect(await gateway().describe("nat-gateway", "nat-1")).toBeNull();
  });

  it("xoá internet gateway: gỡ khỏi VPC TRƯỚC rồi mới xoá", async () => {
    ec2.on(DescribeInternetGatewaysCommand).resolves({
      InternetGateways: [
        { InternetGatewayId: "igw-1", Attachments: [{ VpcId: "vpc-1" }] },
      ],
    });
    ec2.on(DetachInternetGatewayCommand).resolves({});
    ec2.on(DeleteInternetGatewayCommand).resolves({});
    expect(await gateway().remove(res("internet-gateway", "igw-1"))).toBe(
      "deleted",
    );
    expect(ec2.commandCalls(DetachInternetGatewayCommand)).toHaveLength(1);
    expect(ec2.commandCalls(DeleteInternetGatewayCommand)).toHaveLength(1);
  });

  it("xoá tài nguyên đã biến mất ⇒ not-found (idempotent), không ném", async () => {
    ec2
      .on(DeleteVpcCommand)
      .rejects(
        Object.assign(new Error("gone"), { name: "InvalidVpcID.NotFound" }),
      );
    expect(await gateway().remove(res("vpc", "vpc-1"))).toBe("not-found");
  });

  it("xoá cluster CHỜ tới khi nó biến mất thật (DELETING vẫn là còn)", async () => {
    eks.on(DeleteClusterCommand).resolves({});
    eks
      .on(DescribeClusterCommand)
      .resolvesOnce({ cluster: { name: "c", status: "DELETING", tags: {} } })
      .rejectsOnce(
        Object.assign(new Error("x"), { name: "ResourceNotFoundException" }),
      );
    expect(await gateway().remove(res("cluster", "c"))).toBe("deleted");
    expect(eks.commandCalls(DescribeClusterCommand)).toHaveLength(2);
  });
});

describe("tra theo tag", () => {
  it("udp.key của kind IAM ⇒ chỉ quét IAM, không gọi API tag theo region", async () => {
    iam.on(ListRolesCommand).resolves({
      Roles: [
        {
          RoleName: "udp-a-iam-node",
          Arn: "arn:aws:iam::123456789012:role/udp/udp-a-iam-node",
          Path: "/udp/",
          RoleId: "r",
          CreateDate: new Date(),
        },
      ],
    });
    const key =
      "11111111-2222-3333-4444-555555555555:CLUSTER:iam-role:iam-node";
    iam
      .on(ListRoleTagsCommand)
      .resolves({ Tags: [{ Key: "udp.key", Value: key }] });
    const found = await gateway().findByTag("udp.key", key);
    expect(found.map((r) => r.kind)).toEqual(["iam-role"]);
    expect(tagging.commandCalls(GetResourcesCommand)).toHaveLength(0);
  });

  it("đọc ĐỦ mọi trang; ARN lạ (không phải của UDP) bị bỏ", async () => {
    tagging
      .on(GetResourcesCommand)
      .resolvesOnce({
        PaginationToken: "p2",
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:ec2:ap-southeast-1:1:vpc/vpc-1",
            Tags: [{ Key: "udp.project", Value: "p" }],
          },
          { ResourceARN: "arn:aws:s3:::bucket-cua-khach", Tags: [] },
        ],
      })
      .resolvesOnce({
        PaginationToken: "",
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:eks:ap-southeast-1:1:nodegroup/c/ng/uuid",
            Tags: [],
          },
        ],
      });
    iam.on(ListRolesCommand).resolves({ Roles: [] });
    iam
      .on(ListOpenIDConnectProvidersCommand)
      .resolves({ OpenIDConnectProviderList: [] });
    const found = await gateway().listByProject("p");
    expect(found.map((r) => `${r.kind}:${r.id}`)).toEqual([
      "vpc:vpc-1",
      "nodegroup:c/ng",
    ]);
  });

  it("một trang lỗi ⇒ NÉM, không trả danh sách thiếu", async () => {
    tagging
      .on(GetResourcesCommand)
      .resolvesOnce({ PaginationToken: "p2", ResourceTagMappingList: [] })
      .rejectsOnce(
        Object.assign(new Error("x"), { name: "ThrottlingException" }),
      );
    await expect(gateway().listByProject("p")).rejects.toMatchObject({
      errorClass: "throttled",
    });
  });
});

describe("preflight quyền", () => {
  it("SimulatePrincipalPolicy gọi được ⇒ exact, nêu đúng hành động bị từ chối", async () => {
    sts.on(GetCallerIdentityCommand).resolves({
      Arn: "arn:aws:sts::123456789012:assumed-role/udp-deployer/session-1",
    });
    ec2
      .on(DescribeAccountAttributesCommand)
      .resolves({ AccountAttributes: [] });
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [] });
    iam.on(SimulatePrincipalPolicyCommand).resolves({
      EvaluationResults: [
        { EvalActionName: "eks:CreateCluster", EvalDecision: "implicitDeny" },
        { EvalActionName: "ec2:CreateVpc", EvalDecision: "allowed" },
      ],
    });
    const check = await gateway().checkPermissions([
      "eks:CreateCluster",
      "ec2:CreateVpc",
    ]);
    expect(check).toMatchObject({
      confidence: "exact",
      missing: ["eks:CreateCluster"],
    });
    expect(
      iam.commandCalls(SimulatePrincipalPolicyCommand)[0]?.args[0].input
        .PolicySourceArn,
    ).toBe("arn:aws:iam::123456789012:role/udp-deployer");
  });

  it("không được gọi API mô phỏng ⇒ heuristic bằng DryRun, và NÓI RA phần không kiểm được", async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Arn: "arn:aws:iam::1:user/u" });
    ec2.on(DescribeAccountAttributesCommand).resolves({
      AccountAttributes: [
        {
          AttributeName: "vpc-max-elastic-ips",
          AttributeValues: [{ AttributeValue: "5" }],
        },
      ],
    });
    ec2
      .on(DescribeAddressesCommand)
      .resolves({ Addresses: [{}, {}, {}, {}, {}] });
    iam
      .on(SimulatePrincipalPolicyCommand)
      .rejects(Object.assign(new Error("x"), { name: "AccessDenied" }));
    ec2
      .on(CreateVpcCommand)
      .rejects(
        Object.assign(new Error("x"), { name: "UnauthorizedOperation" }),
      );
    const check = await gateway().checkPermissions([
      "ec2:CreateVpc",
      "eks:CreateCluster",
    ]);
    expect(check.confidence).toBe("heuristic");
    expect(check.missing).toEqual(["ec2:CreateVpc"]);
    expect(check.quotaWarnings.join(" ")).toContain("Elastic IP");
    expect(check.quotaWarnings.join(" ")).toContain("Không kiểm được 1 quyền");
  });

  it("ARN phiên AssumeRole ⇒ ARN role; ARN user giữ nguyên", () => {
    expect(
      policySourceArnOf("arn:aws:sts::123456789012:assumed-role/r/s"),
    ).toBe("arn:aws:iam::123456789012:role/r");
    expect(policySourceArnOf("arn:aws:iam::123456789012:user/u")).toBe(
      "arn:aws:iam::123456789012:user/u",
    );
  });
});

describe("lỗi và bí mật", () => {
  it("phân loại theo tên và mã HTTP", () => {
    const e = (name: string, status?: number) =>
      classifyAwsError(
        Object.assign(new Error("x"), {
          name,
          ...(status === undefined
            ? {}
            : { $metadata: { httpStatusCode: status } }),
        }),
      ).errorClass;
    expect(e("AccessDenied")).toBe("permission");
    expect(e("ThrottlingException")).toBe("throttled");
    expect(e("DependencyViolation")).toBe("dependency");
    expect(e("SomethingElse", 503)).toBe("transient");
    expect(e("ValidationException", 400)).toBe("permanent");
  });

  it("lỗi SDK mang credential ⇒ GatewayError sạch, không field nào chứa bí mật", async () => {
    ec2.on(DeleteVpcCommand).rejects(
      Object.assign(new Error("boom"), {
        name: "InternalError",
        config: { credentials: { secretAccessKey: SECRET } },
        $metadata: {
          httpStatusCode: 500,
          httpRequest: { headers: { authorization: SECRET } },
        },
        cause: { deep: { token: SECRET } },
      }),
    );
    const err = await gateway()
      .remove(res("vpc", "vpc-1"))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    const dump = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(dump).not.toContain("SENTINEL");
    expect((err as Error).cause).toBeUndefined();
  });

  it("credential hết hạn ⇒ permission; payload sai hình ⇒ configuration", async () => {
    await expect(awsCredentialsOf(credential(-1))()).rejects.toMatchObject({
      errorClass: "permission",
    });
    const bad = new SecretBuffer("{}");
    await expect(
      awsCredentialsOf({ ...credential(), payload: bad })(),
    ).rejects.toMatchObject({ errorClass: "configuration" });
  });
});

describe("token API server EKS", () => {
  it("k8s-aws-v1.<base64url của URL STS đã ký, có x-k8s-aws-id>", async () => {
    const token = await gateway().kubeToken({
      clusterId: "udp-c",
      clusterName: "udp-c",
      apiEndpoint: "https://x",
      caData: "",
      status: "READY",
    });
    expect(token.token.startsWith("k8s-aws-v1.")).toBe(true);
    const url = Buffer.from(
      token.token.slice("k8s-aws-v1.".length),
      "base64url",
    ).toString();
    expect(url).toMatch(/^https:\/\/sts\.ap-southeast-1\.amazonaws\.com\/\?/);
    expect(url).toContain("Action=GetCallerIdentity");
    expect(url).toContain("X-Amz-Signature=");
    expect(decodeURIComponent(url)).toContain("x-k8s-aws-id");
    expect(url).not.toContain(SECRET);
    expect(token.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      KUBE_TOKEN_TTL_MS,
    );
  });
});

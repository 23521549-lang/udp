import type { ProviderPlan, StepContext, StepSpec } from "../core/plan.js";
import { subnetCidr } from "../core/cidr.js";

/**
 * Kế hoạch EKS (§4.2, ADR-07): mạng hai tầng (subnet công khai cho load balancer, subnet
 * riêng cho node sau NAT), hai IAM role, cluster, OIDC provider (IRSA), node group.
 *
 * Mọi tham số tính TẤT ĐỊNH từ `StepContext` — cùng project, cùng tham số ⇒ cùng kế hoạch,
 * điều kiện để lookup trước create (ADR-08 quy tắc 2) có nghĩa.
 */

export type AwsSpec =
  | { type: "vpc"; cidrBlock: string }
  | {
      type: "subnet";
      cidrBlock: string;
      /** Chỉ số AZ trong danh sách AZ khả dụng đã sắp xếp của region */
      azIndex: number;
      tier: "public" | "private";
      clusterName: string;
    }
  | { type: "internet-gateway" }
  | { type: "elastic-ip" }
  | { type: "nat-gateway" }
  | {
      type: "route-table";
      /** Đích mặc định 0.0.0.0/0: internet gateway (công khai) hoặc NAT (riêng) */
      via: "internet-gateway" | "nat-gateway";
    }
  | { type: "security-group"; description: string }
  | {
      type: "iam-role";
      service: "eks.amazonaws.com" | "ec2.amazonaws.com";
      managedPolicyArns: readonly string[];
    }
  | {
      type: "cluster";
      kubernetesVersion: string;
      publicAccessCidrs: readonly string[];
    }
  | { type: "oidc-provider" }
  | {
      type: "nodegroup";
      instanceType: string;
      desiredSize: number;
      minSize: number;
      maxSize: number;
    };

/** Cỡ node tối thiểu 8 GB (§4.2: Istio + Prometheus + Argo Rollouts không vừa 4 GB) */
export const AWS_NODE_TYPES = {
  small: "t3.large",
  medium: "t3.xlarge",
  large: "m5.2xlarge",
} as const;

/** Phiên bản Kubernetes của EKS ghim ở kế hoạch — nâng cấp là việc của Day-2 (§8.6) */
export const EKS_KUBERNETES_VERSION = "1.33";

const POLICY = "arn:aws:iam::aws:policy/";

const network = (ctx: StepContext) => {
  if (ctx.phase !== "NETWORK")
    throw new Error("step mạng dựng ngoài pha NETWORK");
  return ctx.params;
};
const cluster = (ctx: StepContext) => {
  if (ctx.phase !== "CLUSTER")
    throw new Error("step cluster dựng ngoài pha CLUSTER");
  return ctx.params;
};

/** Tên cluster tất định — cùng hàm với `physicalName("cluster")` để subnet gắn đúng tag k8s */
export const clusterNameOf = (projectId: string): string =>
  awsPhysicalName(projectId, "cluster");

/**
 * `udp-<12 hex đầu của project>-<step>`: ≤ 64 ký tự (trần tên IAM role), chỉ `[a-z0-9-]`
 * (hợp với tên EKS, security group và IAM), tất định theo project.
 */
export function awsPhysicalName(projectId: string, stepName: string): string {
  return `udp-${projectId.replace(/-/g, "").slice(0, 12)}-${stepName}`;
}

const subnet = (
  name: string,
  index: number,
  azIndex: number,
  tier: "public" | "private",
): StepSpec => ({
  name,
  kind: "subnet",
  phase: "NETWORK",
  dependsOn: ["vpc"],
  build: (ctx): AwsSpec => {
    const p = network(ctx);
    return {
      type: "subnet",
      cidrBlock: subnetCidr(p.cidrBlock, 20, index),
      azIndex,
      tier,
      clusterName: clusterNameOf(p.projectId),
    };
  },
});

export const AWS_NETWORK_STEPS: readonly StepSpec[] = [
  {
    name: "vpc",
    kind: "vpc",
    phase: "NETWORK",
    dependsOn: [],
    build: (ctx): AwsSpec => ({
      type: "vpc",
      cidrBlock: network(ctx).cidrBlock,
    }),
  },
  subnet("subnet-public-a", 0, 0, "public"),
  subnet("subnet-public-b", 1, 1, "public"),
  subnet("subnet-private-a", 2, 0, "private"),
  subnet("subnet-private-b", 3, 1, "private"),
  {
    name: "igw",
    kind: "internet-gateway",
    phase: "NETWORK",
    dependsOn: ["vpc"],
    build: (): AwsSpec => ({ type: "internet-gateway" }),
  },
  {
    name: "eip",
    kind: "elastic-ip",
    phase: "NETWORK",
    dependsOn: [],
    build: (): AwsSpec => ({ type: "elastic-ip" }),
  },
  {
    name: "nat",
    kind: "nat-gateway",
    phase: "NETWORK",
    dependsOn: ["subnet-public-a", "eip"],
    build: (): AwsSpec => ({ type: "nat-gateway" }),
  },
  {
    name: "rtb-public",
    kind: "route-table",
    phase: "NETWORK",
    dependsOn: ["vpc", "igw", "subnet-public-a", "subnet-public-b"],
    build: (): AwsSpec => ({ type: "route-table", via: "internet-gateway" }),
  },
  {
    name: "rtb-private",
    kind: "route-table",
    phase: "NETWORK",
    dependsOn: ["vpc", "nat", "subnet-private-a", "subnet-private-b"],
    build: (): AwsSpec => ({ type: "route-table", via: "nat-gateway" }),
  },
];

export const AWS_CLUSTER_STEPS: readonly StepSpec[] = [
  {
    name: "sg",
    kind: "security-group",
    phase: "CLUSTER",
    dependsOn: ["vpc"],
    build: (): AwsSpec => ({
      type: "security-group",
      description: "UDP: control plane EKS <-> node",
    }),
  },
  {
    name: "iam-cluster",
    kind: "iam-role",
    phase: "CLUSTER",
    dependsOn: [],
    build: (): AwsSpec => ({
      type: "iam-role",
      service: "eks.amazonaws.com",
      managedPolicyArns: [`${POLICY}AmazonEKSClusterPolicy`],
    }),
  },
  {
    name: "iam-node",
    kind: "iam-role",
    phase: "CLUSTER",
    dependsOn: [],
    build: (): AwsSpec => ({
      type: "iam-role",
      service: "ec2.amazonaws.com",
      managedPolicyArns: [
        `${POLICY}AmazonEKSWorkerNodePolicy`,
        `${POLICY}AmazonEKS_CNI_Policy`,
        `${POLICY}AmazonEC2ContainerRegistryReadOnly`,
      ],
    }),
  },
  {
    name: "cluster",
    kind: "cluster",
    phase: "CLUSTER",
    dependsOn: [
      "iam-cluster",
      "sg",
      "subnet-private-a",
      "subnet-private-b",
      "subnet-public-a",
      "subnet-public-b",
    ],
    build: (ctx): AwsSpec => ({
      type: "cluster",
      kubernetesVersion: EKS_KUBERNETES_VERSION,
      // API server chỉ mở cho control plane của UDP (ADR-06), không 0.0.0.0/0
      publicAccessCidrs: cluster(ctx).controlPlaneCidrs,
    }),
  },
  {
    name: "oidc",
    kind: "oidc-provider",
    phase: "CLUSTER",
    dependsOn: ["cluster"],
    build: (): AwsSpec => ({ type: "oidc-provider" }),
  },
  {
    name: "nodegroup",
    kind: "nodegroup",
    phase: "CLUSTER",
    dependsOn: ["cluster", "iam-node", "subnet-private-a", "subnet-private-b"],
    build: (ctx): AwsSpec => {
      const p = cluster(ctx);
      return {
        type: "nodegroup",
        instanceType: AWS_NODE_TYPES[p.nodeSize],
        desiredSize: p.nodeCount,
        minSize: 1,
        maxSize: Math.max(p.nodeCount, p.quota.maxNodes),
      };
    },
  },
];

/** Quyền tối thiểu (§4.3 bảng "Quyền tối thiểu khuyến nghị cho BYOC") — đầu vào của preflight */
export const AWS_REQUIRED_PERMISSIONS: readonly string[] = [
  "ec2:CreateVpc",
  "ec2:ModifyVpcAttribute",
  "ec2:CreateSubnet",
  "ec2:CreateInternetGateway",
  "ec2:AttachInternetGateway",
  "ec2:AllocateAddress",
  "ec2:CreateNatGateway",
  "ec2:CreateRouteTable",
  "ec2:CreateRoute",
  "ec2:AssociateRouteTable",
  "ec2:CreateSecurityGroup",
  "ec2:CreateTags",
  "ec2:DescribeAvailabilityZones",
  "ec2:DeleteVpc",
  "ec2:DeleteSubnet",
  "ec2:DeleteNatGateway",
  "ec2:ReleaseAddress",
  "iam:CreateRole",
  "iam:AttachRolePolicy",
  "iam:PassRole",
  "iam:CreateOpenIDConnectProvider",
  "iam:DeleteRole",
  "eks:CreateCluster",
  "eks:DescribeCluster",
  "eks:DeleteCluster",
  "eks:CreateNodegroup",
  "eks:DeleteNodegroup",
  "tag:GetResources",
];

/** Giá us-east-1, theo giờ × 730 (§4.2 `CostEstimate`); ngày của bảng ghi ở `asOf` */
const HOURS_PER_MONTH = 730;
const monthly = (usdPerHour: number): number =>
  Math.round(usdPerHour * HOURS_PER_MONTH * 100) / 100;

export const awsPlan: ProviderPlan = {
  provider: "aws",
  networkSteps: AWS_NETWORK_STEPS,
  clusterSteps: AWS_CLUSTER_STEPS,
  // EC2, IAM và EKS đều nhận tag ngay lúc tạo: không kind nào phải tra theo tên
  kindsWithoutCreateTags: [],
  physicalName: awsPhysicalName,
  requiredPermissions: AWS_REQUIRED_PERMISSIONS,
  pricing: {
    asOf: "2026-09-01",
    controlPlaneMonthlyUsd: monthly(0.1),
    natGatewayMonthlyUsd: monthly(0.045),
    loadBalancerMonthlyUsd: monthly(0.0225),
    nodeMonthlyUsd: {
      small: monthly(0.0832),
      medium: monthly(0.1664),
      large: monthly(0.384),
    },
  },
  docUrl: "https://udp.example/docs/byoc/aws",
};

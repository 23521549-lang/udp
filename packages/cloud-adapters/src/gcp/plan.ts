import { subnetCidr } from "../core/cidr.js";
import type { ProviderPlan, StepContext, StepSpec } from "../core/plan.js";

/**
 * Kế hoạch GKE (§4.2): VPC chế độ tuỳ chỉnh, một subnet có hai dải phụ (pod, service),
 * firewall nội bộ, Cloud Router + Cloud NAT cho node riêng, service account cho node,
 * cluster GKE riêng (private nodes, master authorized networks chỉ gồm control plane
 * của UDP — ADR-06), node pool theo cỡ.
 *
 * GCP chỉ cho label trên cluster GKE; mọi kind khác tra theo TÊN tất định (§4.5 quy tắc 2).
 */

export type GcpSpec =
  | { type: "vpc" }
  | {
      type: "subnet";
      primaryCidr: string;
      podsCidr: string;
      servicesCidr: string;
    }
  | { type: "firewall-rule"; sourceRanges: readonly string[] }
  | { type: "cloud-router" }
  | { type: "nat-gateway" }
  | {
      type: "service-account";
      displayName: string;
      projectRoles: readonly string[];
    }
  | {
      type: "cluster";
      releaseChannel: "REGULAR";
      masterCidr: string;
      authorizedCidrs: readonly string[];
    }
  | {
      type: "nodegroup";
      machineType: string;
      nodeCount: number;
      maxNodeCount: number;
    };

/** Cỡ node tối thiểu 8 GB (§4.2) */
export const GCP_MACHINE_TYPES = {
  small: "e2-standard-2",
  medium: "e2-standard-4",
  large: "e2-standard-8",
} as const;

/** Tên dải phụ của subnet mà cluster GKE trỏ tới (IP alias) */
export const PODS_RANGE = "pods";
export const SERVICES_RANGE = "services";

/**
 * `udp-<12 hex đầu project>-<step>`: GCP đòi tên `[a-z]([-a-z0-9]{0,61}[a-z0-9])?`.
 * Account id của service account ngắn hơn (6..30 ký tự) nên có dạng riêng.
 */
export function gcpPhysicalName(projectId: string, stepName: string): string {
  const short = projectId.replace(/-/g, "").slice(0, 12);
  return stepName === "node-sa"
    ? `udp-${short}-nodes`
    : `udp-${short}-${stepName}`;
}

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

export const GCP_NETWORK_STEPS: readonly StepSpec[] = [
  {
    name: "vpc",
    kind: "vpc",
    phase: "NETWORK",
    dependsOn: [],
    build: (): GcpSpec => ({ type: "vpc" }),
  },
  {
    name: "subnet",
    kind: "subnet",
    phase: "NETWORK",
    dependsOn: ["vpc"],
    build: (ctx): GcpSpec => {
      const block = network(ctx).cidrBlock;
      return {
        type: "subnet",
        primaryCidr: subnetCidr(block, 20, 0),
        podsCidr: subnetCidr(block, 18, 1),
        servicesCidr: subnetCidr(block, 20, 1),
      };
    },
  },
  {
    name: "fw-internal",
    kind: "firewall-rule",
    phase: "NETWORK",
    dependsOn: ["vpc"],
    build: (ctx): GcpSpec => ({
      type: "firewall-rule",
      sourceRanges: [network(ctx).cidrBlock],
    }),
  },
  {
    name: "router",
    kind: "cloud-router",
    phase: "NETWORK",
    dependsOn: ["vpc"],
    build: (): GcpSpec => ({ type: "cloud-router" }),
  },
  {
    name: "nat",
    kind: "nat-gateway",
    phase: "NETWORK",
    dependsOn: ["router"],
    build: (): GcpSpec => ({ type: "nat-gateway" }),
  },
];

export const GCP_CLUSTER_STEPS: readonly StepSpec[] = [
  {
    name: "node-sa",
    kind: "service-account",
    phase: "CLUSTER",
    dependsOn: [],
    build: (): GcpSpec => ({
      type: "service-account",
      displayName: "UDP GKE nodes",
      projectRoles: ["roles/container.defaultNodeServiceAccount"],
    }),
  },
  {
    name: "cluster",
    kind: "cluster",
    phase: "CLUSTER",
    dependsOn: ["vpc", "subnet", "node-sa"],
    build: (ctx): GcpSpec => ({
      type: "cluster",
      releaseChannel: "REGULAR",
      masterCidr: "172.16.0.0/28",
      authorizedCidrs: cluster(ctx).controlPlaneCidrs,
    }),
  },
  {
    name: "nodepool",
    kind: "nodegroup",
    phase: "CLUSTER",
    dependsOn: ["cluster", "node-sa"],
    build: (ctx): GcpSpec => {
      const p = cluster(ctx);
      return {
        type: "nodegroup",
        machineType: GCP_MACHINE_TYPES[p.nodeSize],
        nodeCount: p.nodeCount,
        maxNodeCount: Math.max(p.nodeCount, p.quota.maxNodes),
      };
    },
  },
];

/** Quyền kiểm bằng `projects.testIamPermissions` (§4.3: exact) */
export const GCP_REQUIRED_PERMISSIONS: readonly string[] = [
  "compute.networks.create",
  "compute.networks.delete",
  "compute.subnetworks.create",
  "compute.subnetworks.delete",
  "compute.firewalls.create",
  "compute.firewalls.delete",
  "compute.routers.create",
  "compute.routers.update",
  "compute.routers.delete",
  "iam.serviceAccounts.create",
  "iam.serviceAccounts.delete",
  "iam.serviceAccounts.actAs",
  "resourcemanager.projects.getIamPolicy",
  "resourcemanager.projects.setIamPolicy",
  "container.clusters.create",
  "container.clusters.get",
  "container.clusters.delete",
  "container.operations.get",
];

const HOURS_PER_MONTH = 730;
const monthly = (usdPerHour: number): number =>
  Math.round(usdPerHour * HOURS_PER_MONTH * 100) / 100;

export const gcpPlan: ProviderPlan = {
  provider: "gcp",
  networkSteps: GCP_NETWORK_STEPS,
  clusterSteps: GCP_CLUSTER_STEPS,
  kindsWithoutCreateTags: [
    "vpc",
    "subnet",
    "firewall-rule",
    "cloud-router",
    "nat-gateway",
    "service-account",
    "nodegroup",
  ],
  physicalName: gcpPhysicalName,
  requiredPermissions: GCP_REQUIRED_PERMISSIONS,
  pricing: {
    asOf: "2026-09-01",
    // Phí quản lý cluster GKE Standard 0,10 USD/giờ
    controlPlaneMonthlyUsd: monthly(0.1),
    // Cloud NAT: 0,0014 USD/giờ/VM (tối thiểu 32 VM cho giá gateway) — theo mức gateway
    natGatewayMonthlyUsd: monthly(0.044),
    loadBalancerMonthlyUsd: monthly(0.025),
    nodeMonthlyUsd: {
      small: monthly(0.067),
      medium: monthly(0.134),
      large: monthly(0.268),
    },
  },
  docUrl: "https://udp.example/docs/byoc/gcp",
};

import type { ProvisionClusterParams } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import {
  AZURE_CLUSTER_STEPS,
  azurePhysicalName,
  parentNames,
  type AzureSpec,
} from "../../src/azure/plan.js";
import { cidrsOverlap } from "../../src/core/cidr.js";

/** Tên vật lý theo luật Azure, tên cha suy lại được, dải AKS không chồng VNet */

const PROJECT = "0f0f0f0f-1111-4222-8333-444455556666";
const name = (step: string) => azurePhysicalName(PROJECT, step);

describe("tên vật lý", () => {
  it("agent pool: chữ thường và số, bắt đầu bằng chữ, ≤ 12 ký tự", () => {
    expect(name("nodepool")).toMatch(/^[a-z][a-z0-9]{0,11}$/);
  });

  it("role assignment: GUID, tất định, khác nhau giữa các project", () => {
    const guid = name("identity-network");
    expect(guid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(name("identity-network")).toBe(guid);
    expect(
      azurePhysicalName(
        "1f0f0f0f-1111-4222-8333-444455556666",
        "identity-network",
      ),
    ).not.toBe(guid);
  });

  it("tên cha suy từ tên con khớp đúng tên vật lý của step cha", () => {
    expect(parentNames.clusterOfPool(name("nodepool"))).toBe(name("cluster"));
    expect(parentNames.vnetOfSubnet(name("subnet"))).toBe(name("vpc"));
    expect(
      parentNames.subnetOfRoleAssignment(name("identity-network")),
    ).toEqual({
      vnet: name("vpc"),
      subnet: name("subnet"),
    });
  });

  it("tên cấp cao ≤ 63 ký tự (giới hạn chặt nhất: cluster AKS)", () => {
    for (const step of ["vpc", "nsg", "pip", "nat", "identity", "cluster"]) {
      expect(name(step).length).toBeLessThanOrEqual(63);
    }
  });
});

describe("dải pod và service của cluster", () => {
  const clusterStep = AZURE_CLUSTER_STEPS.find((s) => s.kind === "cluster");
  const params: ProvisionClusterParams = {
    projectId: PROJECT,
    clusterName: "c",
    nodeSize: "small",
    nodeCount: 2,
    quota: {
      maxNodes: 5,
      maxNodeSize: "large",
      maxDatabases: 1,
      maxStorageGb: 10,
      maxLoadBalancers: 1,
    },
    region: "southeastasia",
    idempotencyKey: "k",
    tags: {},
    controlPlaneCidrs: ["203.0.113.0/24"],
  };
  const build = (cidrBlock: string) =>
    clusterStep?.build({
      phase: "CLUSTER",
      params,
      network: { networkId: "n", networkName: "n", cidrBlock },
    }) as Extract<AzureSpec, { type: "cluster" }>;

  it("không chồng lên VNet, DNS nằm trong dải service", () => {
    for (const block of ["10.0.0.0/16", "192.168.0.0/16", "172.20.0.0/16"]) {
      const spec = build(block);
      expect(cidrsOverlap(spec.podCidr, block)).toBe(false);
      expect(cidrsOverlap(spec.serviceCidr, block)).toBe(false);
      expect(cidrsOverlap(`${spec.dnsServiceIp}/32`, spec.serviceCidr)).toBe(
        true,
      );
    }
  });

  it("tất định: cùng khối ⇒ cùng tham số", () => {
    expect(build("10.0.0.0/16")).toEqual(build("10.0.0.0/16"));
  });

  it("khối chồng lên mọi ứng viên ⇒ ném, không dựng cluster hỏng mạng", () => {
    expect(() => build("128.0.0.0/1")).toThrow();
  });
});

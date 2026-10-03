import { CREATED_RESOURCE_KINDS } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import { azurePlan, azureTagCodec } from "../../src/azure/index.js";
import { planProblems } from "../../src/index.js";
import { runPlanContract } from "../helpers/contract.js";

/**
 * Kế hoạch AKS THẬT qua đủ bộ hợp đồng Cloud (Plan #26 AC-1). Fixture viết tay: VNet,
 * NSG, Public IP + NAT gateway, một subnet; managed identity + role assignment trên
 * subnet, cluster AKS + agent pool.
 */
const AZURE_FIXTURE = {
  expectedStepCount: 9,
  expectedResourceCount: 9,
  expectedByKind: {
    vpc: 1,
    nsg: 1,
    "elastic-ip": 1,
    "nat-gateway": 1,
    subnet: 1,
    "managed-identity": 1,
    "iam-policy": 1,
    cluster: 1,
    nodegroup: 1,
  },
} as const;

describe("kế hoạch AKS", () => {
  it("hợp lệ theo planProblems", () => {
    expect(planProblems(azurePlan)).toEqual([]);
  });

  it("fixture viết tay khớp kế hoạch (một step biến mất là đỏ)", () => {
    const steps = [...azurePlan.networkSteps, ...azurePlan.clusterSteps];
    expect(steps).toHaveLength(AZURE_FIXTURE.expectedStepCount);
    const byKind: Record<string, number> = {};
    for (const s of steps) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    expect(byKind).toEqual(AZURE_FIXTURE.expectedByKind);
  });
});

describe("tag Azure", () => {
  const PROJECT = "0f0f0f0f-1111-4222-8333-444455556666";

  it("giữ nguyên dạng chuẩn và hợp lệ cho mọi kind", () => {
    for (const kind of CREATED_RESOURCE_KINDS) {
      const tags = {
        "udp.project": PROJECT,
        "udp.key": `${PROJECT}:CLUSTER:${kind}:step`,
        "udp.owner": "chu@vi-du.test",
        "udp.managed": "true",
        "udp.ttl": "2026-12-31T23:59:59.123Z",
      };
      const raw = azureTagCodec.encode(tags);
      expect(azureTagCodec.problems(raw)).toEqual([]);
      expect(azureTagCodec.decode(raw)).toEqual(tags);
    }
  });

  it("ký tự cấm trong khoá, tiền tố dành riêng, giá trị dài, quá 50 tag ⇒ nêu ra", () => {
    expect(azureTagCodec.problems({ "a/b": "x" })).toHaveLength(1);
    expect(azureTagCodec.problems({ "Microsoft.x": "x" })).toHaveLength(1);
    expect(azureTagCodec.problems({ k: "v".repeat(257) })).toHaveLength(1);
    const many = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`k${String(i)}`, "v"]),
    );
    expect(azureTagCodec.problems(many)).toHaveLength(1);
  });
});

runPlanContract({
  label: "Azure (AKS)",
  provider: "azure",
  plan: azurePlan,
  codec: azureTagCodec,
  fixture: AZURE_FIXTURE,
});

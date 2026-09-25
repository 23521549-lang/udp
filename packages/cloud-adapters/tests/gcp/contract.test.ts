import { describe, expect, it } from "vitest";
import { gcpLabelCodec, gcpPlan } from "../../src/gcp/index.js";
import { planProblems } from "../../src/index.js";
import { runPlanContract } from "../helpers/contract.js";

/**
 * Kế hoạch GKE THẬT qua đủ bộ hợp đồng Cloud (Plan #26 AC-1). Fixture viết tay: mạng một
 * subnet có hai dải phụ (pods, services), Cloud NAT trên router, cluster private + node pool.
 */
const GCP_FIXTURE = {
  expectedStepCount: 8,
  expectedResourceCount: 8,
  expectedByKind: {
    vpc: 1,
    subnet: 1,
    "firewall-rule": 1,
    "cloud-router": 1,
    "nat-gateway": 1,
    "service-account": 1,
    cluster: 1,
    nodegroup: 1,
  },
} as const;

describe("kế hoạch GKE", () => {
  it("hợp lệ theo planProblems", () => {
    expect(planProblems(gcpPlan)).toEqual([]);
  });

  it("fixture viết tay khớp kế hoạch (một step biến mất là đỏ)", () => {
    const steps = [...gcpPlan.networkSteps, ...gcpPlan.clusterSteps];
    expect(steps).toHaveLength(GCP_FIXTURE.expectedStepCount);
    const byKind: Record<string, number> = {};
    for (const s of steps) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    expect(byKind).toEqual(GCP_FIXTURE.expectedByKind);
  });

  it("chỉ cluster mang label; mọi kind khác nhận ra bằng tên tất định", () => {
    const kinds = [...gcpPlan.networkSteps, ...gcpPlan.clusterSteps].map(
      (s) => s.kind,
    );
    expect(
      kinds.filter((k) => !gcpPlan.kindsWithoutCreateTags.includes(k)),
    ).toEqual(["cluster"]);
  });
});

runPlanContract({
  label: "GCP (GKE)",
  provider: "gcp",
  plan: gcpPlan,
  codec: gcpLabelCodec,
  fixture: GCP_FIXTURE,
});

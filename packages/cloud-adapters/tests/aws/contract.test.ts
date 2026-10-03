import { describe, expect, it } from "vitest";
import { awsPlan, awsTagCodec } from "../../src/aws/index.js";
import { planProblems } from "../../src/index.js";
import { runPlanContract } from "../helpers/contract.js";

/**
 * Kế hoạch EKS THẬT qua đủ bộ hợp đồng Cloud (Plan #26 AC-1). Fixture viết tay theo kiến
 * trúc mạng hai tầng: 10 step mạng + 6 step cluster.
 */
const AWS_FIXTURE = {
  expectedStepCount: 16,
  expectedResourceCount: 16,
  expectedByKind: {
    vpc: 1,
    subnet: 4,
    "internet-gateway": 1,
    "elastic-ip": 1,
    "nat-gateway": 1,
    "route-table": 2,
    "security-group": 1,
    "iam-role": 2,
    cluster: 1,
    "oidc-provider": 1,
    nodegroup: 1,
  },
} as const;

describe("kế hoạch EKS", () => {
  it("hợp lệ theo planProblems", () => {
    expect(planProblems(awsPlan)).toEqual([]);
  });

  it("fixture viết tay khớp kế hoạch (một step biến mất là đỏ)", () => {
    const steps = [...awsPlan.networkSteps, ...awsPlan.clusterSteps];
    expect(steps).toHaveLength(AWS_FIXTURE.expectedStepCount);
    const byKind: Record<string, number> = {};
    for (const s of steps) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    expect(byKind).toEqual(AWS_FIXTURE.expectedByKind);
  });
});

runPlanContract({
  label: "AWS (EKS)",
  provider: "aws",
  plan: awsPlan,
  codec: awsTagCodec,
  fixture: AWS_FIXTURE,
});

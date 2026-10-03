import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudAdapter } from "@udp/adapter-core";
import {
  runCloudAdapterContract,
  type CloudContractEnv,
} from "@udp/adapter-core/contract";
import {
  CLOUD_FIXTURE,
  FIXTURE_STEPS,
  InMemoryLedger,
  KINDS_WITHOUT_CREATE_TAGS,
  SimCloud,
} from "@udp/adapter-core/testing";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPlannedAdapter,
  planProblems,
  type ProviderPlan,
  type TagCodec,
} from "../src/index.js";
import { createSimGateway } from "../src/testing/index.js";

/**
 * Cổng P1: LÕI điều phối qua đủ bộ hợp đồng Cloud với một kế hoạch dựng từ đúng
 * `FIXTURE_STEPS` — để dùng được `CLOUD_FIXTURE` viết tay sẵn. Đây là phép đối chứng:
 * nếu lõi thay được adapter mô phỏng trên cùng bộ kiểm thì mọi khác biệt về sau nằm ở kế
 * hoạch và cổng của từng cloud, không ở luật điều phối.
 */

const identityCodec: TagCodec = {
  encode: (t) => ({ ...t }),
  decode: (t) => ({ ...t }),
  problems: () => [],
};

const fixturePlan: ProviderPlan = {
  provider: "aws",
  networkSteps: FIXTURE_STEPS.filter((s) => s.step === "NETWORK").map((s) => ({
    name: s.name,
    kind: s.kind,
    phase: "NETWORK" as const,
    dependsOn: s.dependsOn === undefined ? [] : [s.dependsOn],
    build: () => ({}),
  })),
  clusterSteps: FIXTURE_STEPS.filter((s) => s.step === "CLUSTER").map((s) => ({
    name: s.name,
    kind: s.kind,
    phase: "CLUSTER" as const,
    dependsOn: s.dependsOn === undefined ? [] : [s.dependsOn],
    build: () => ({}),
  })),
  kindsWithoutCreateTags: KINDS_WITHOUT_CREATE_TAGS,
  // Cùng tên với adapter mô phỏng: phép c5 tra ngược theo tên logic
  physicalName: (_projectId, stepName) => stepName,
  requiredPermissions: ["eks:CreateCluster", "ec2:CreateVpc", "iam:CreateRole"],
  pricing: {
    asOf: "2026-09-01",
    controlPlaneMonthlyUsd: 73,
    natGatewayMonthlyUsd: 32,
    loadBalancerMonthlyUsd: 18,
    nodeMonthlyUsd: { small: 15, medium: 30, large: 60 },
  },
  docUrl: "https://udp.example/docs/byoc-iam",
};

function adapterOn(cloud: SimCloud, label = "du-quyen"): CloudAdapter {
  return createPlannedAdapter({
    plan: fixturePlan,
    gatewayFor: () =>
      createSimGateway({
        cloud,
        provider: "aws",
        codec: identityCodec,
        credentialLabel: label,
      }),
    waitReady: { intervalMs: 0, timeoutMs: 1_000 },
    teardown: { waitTimeoutMs: 2_000, pollIntervalMs: 1 },
    sleep: () => Promise.resolve(),
  });
}

function envFor(): { env: CloudContractEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cloud-core-"));
  const cloud = new SimCloud({ statePath: join(dir, "cloud.json") });
  return {
    env: {
      driver: "in-process",
      ledger: () => new InMemoryLedger(),
      control: cloud,
      fixture: CLOUD_FIXTURE,
      adapterWithCredentialLabel: (label) => adapterOn(cloud, label),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Mỗi phép dựng một SimCloud trong thư mục tạm riêng; dọn hết khi xong tệp */
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

describe("kế hoạch đối chứng", () => {
  it("hợp lệ theo planProblems", () => {
    expect(planProblems(fixturePlan)).toEqual([]);
  });
});

runCloudAdapterContract(
  {
    describe: (name, fn) => {
      describe(name, () => {
        fn();
      });
    },
    it: (name, fn) => {
      it(name, fn);
    },
  },
  "lõi điều phối (kế hoạch đối chứng)",
  () => {
    const { env, cleanup } = envFor();
    cleanups.push(cleanup);
    return env;
  },
  (env) => adapterOn(env.control as SimCloud),
);

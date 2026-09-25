import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SecretBuffer,
  type CloudProvider,
  type ResolvedCredential,
  type ResourceQuota,
} from "@udp/adapter-core";
import {
  CloudAdapterRunner,
  inheritFromLedger,
  silentObserver,
  type RunPlan,
} from "@udp/adapter-core/runner";
import { InMemoryLedger, SimCloud } from "@udp/adapter-core/testing";
import { afterAll, describe, expect, it } from "vitest";
import { awsPlan, awsTagCodec } from "../src/aws/index.js";
import { azurePlan, azureTagCodec } from "../src/azure/index.js";
import { gcpLabelCodec, gcpPlan } from "../src/gcp/index.js";
import {
  createPlannedAdapter,
  type ProviderPlan,
  type TagCodec,
} from "../src/index.js";
import { createSimGateway } from "../src/testing/index.js";

/**
 * Plan #28 QĐ-3, AC-1: kế hoạch THẬT chạy pha NETWORK rồi pha CLUSTER ở HAI lần `run()`
 * tách rời — đúng cách worker chạy. Pha sau cần tài nguyên của pha trước làm cha (AWS:
 * `cluster` cần subnet); thiếu thì phải ĐỎ, không tạo tài nguyên trỏ vào cha vắng.
 */

const PROJECT = "0f0f0f0f-1111-4222-8333-444455556666";
const QUOTA: ResourceQuota = {
  maxNodes: 5,
  maxNodeSize: "large",
  maxDatabases: 1,
  maxStorageGb: 50,
  maxLoadBalancers: 2,
};
const TAGS = {
  "udp.project": PROJECT,
  "udp.owner": "chu@vi-du.test",
  "udp.managed": "true",
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function credential(provider: CloudProvider): ResolvedCredential {
  const payload = new SecretBuffer("{}");
  return {
    provider,
    mode: "BYOC",
    authKind: "AWS_ROLE",
    payload,
    expiresAt: new Date(Date.now() + 900_000),
    dispose: () => payload.dispose(),
  };
}

function world(provider: CloudProvider, plan: ProviderPlan, codec: TagCodec) {
  const dir = mkdtempSync(join(tmpdir(), `two-phase-${provider}-`));
  dirs.push(dir);
  const cloud = new SimCloud({
    statePath: join(dir, "cloud.json"),
    kindsWithoutCreateTags: plan.kindsWithoutCreateTags,
  });
  const adapter = createPlannedAdapter({
    plan,
    gatewayFor: () =>
      createSimGateway({ cloud, provider, codec, credentialLabel: "du-quyen" }),
    waitReady: { intervalMs: 0, timeoutMs: 1_000 },
    teardown: { waitTimeoutMs: 1_000, pollIntervalMs: 1 },
    sleep: () => Promise.resolve(),
  });
  const ledger = new InMemoryLedger();
  const runner = () =>
    new CloudAdapterRunner({
      ledger,
      fence: { assert: () => Promise.resolve() },
      observer: silentObserver,
      sleep: () => Promise.resolve(),
    });
  const region = "r-1";
  const networkSteps = adapter.networkSteps({
    projectId: PROJECT,
    networkName: "udp",
    cidrBlock: "10.0.0.0/16",
    region,
    quota: QUOTA,
    idempotencyKey: `${PROJECT}:NETWORK:vpc:vpc`,
    tags: TAGS,
    controlPlaneCidrs: ["203.0.113.0/24"],
  });
  const clusterSteps = adapter.clusterSteps(
    {
      projectId: PROJECT,
      clusterName: "main",
      nodeSize: "small",
      nodeCount: 2,
      quota: QUOTA,
      region,
      idempotencyKey: `${PROJECT}:CLUSTER:cluster:cluster`,
      tags: TAGS,
      controlPlaneCidrs: ["203.0.113.0/24"],
    },
    { networkId: "vpc", networkName: "udp", cidrBlock: "10.0.0.0/16" },
  );
  const planOf = (
    step: RunPlan["step"],
    steps: RunPlan["steps"],
    inherited?: RunPlan["inherited"],
  ): RunPlan => ({
    projectId: PROJECT,
    provider,
    region,
    step,
    steps,
    credential: credential(provider),
    quota: QUOTA,
    ...(inherited === undefined ? {} : { inherited }),
  });
  return { ledger, runner, networkSteps, clusterSteps, planOf };
}

const CLOUDS = [
  ["aws", awsPlan, awsTagCodec],
  ["gcp", gcpPlan, gcpLabelCodec],
  ["azure", azurePlan, azureTagCodec],
] as const;

describe.each(CLOUDS)("%s: hai pha tách rời", (provider, plan, codec) => {
  it("pha CLUSTER không mang tài nguyên pha mạng ⇒ step đầu cần cha thất bại, không SUCCESS", async () => {
    const w = world(provider, plan, codec);
    const network = await w.runner().run(w.planOf("NETWORK", w.networkSteps));
    expect(network.status).toBe("SUCCESS");
    const cluster = await w.runner().run(w.planOf("CLUSTER", w.clusterSteps));
    expect(cluster.status).not.toBe("SUCCESS");
  });

  it("mang kết quả pha mạng ⇒ SUCCESS; resume từ SỔ (hỏi lại cloud) ⇒ cùng kết cục", async () => {
    const w = world(provider, plan, codec);
    const network = await w.runner().run(w.planOf("NETWORK", w.networkSteps));
    if (network.status !== "SUCCESS") throw new Error(network.status);

    const direct = await w
      .runner()
      .run(w.planOf("CLUSTER", w.clusterSteps, network.created));
    expect(direct.status).toBe("SUCCESS");

    // Worker mới sau khi worker cũ chết giữa hai pha: chỉ còn sổ
    const fromLedger = await inheritFromLedger({
      steps: w.networkSteps,
      rows: await w.ledger.rowsOf(PROJECT),
      credential: credential(provider),
    });
    expect(Object.keys(fromLedger).sort()).toEqual(
      w.networkSteps.map((s) => s.name).sort(),
    );
    const resumed = await w
      .runner()
      .run(w.planOf("CLUSTER", w.clusterSteps, fromLedger));
    expect(resumed.status).toBe("SUCCESS");
  });

  it("pha trước chưa trọn trong sổ ⇒ kế thừa ném, không chạy pha sau trên nền thiếu", async () => {
    const w = world(provider, plan, codec);
    await expect(
      inheritFromLedger({
        steps: w.networkSteps,
        rows: await w.ledger.rowsOf(PROJECT),
        credential: credential(provider),
      }),
    ).rejects.toMatchObject({ code: "INHERITED_PHASE_INCOMPLETE" });
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SecretBuffer,
  type CloudProvider,
  type CreatedResource,
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
  return {
    adapter,
    cloud,
    ledger,
    runner,
    networkSteps,
    clusterSteps,
    planOf,
  };
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

  it("bù trừ CẢ kế hoạch sau hai pha ⇒ mọi hàng DELETED, cloud không còn tài nguyên của project", async () => {
    const w = world(provider, plan, codec);
    const network = await w.runner().run(w.planOf("NETWORK", w.networkSteps));
    if (network.status !== "SUCCESS") throw new Error(network.status);
    await w.runner().run(w.planOf("CLUSTER", w.clusterSteps, network.created));

    const outcome = await w
      .runner()
      .compensate(
        w.planOf("CLUSTER", [...w.networkSteps, ...w.clusterSteps]),
        "pha sau thất bại",
      );
    expect(outcome.status).toBe("COMPENSATED");
    const rows = await w.ledger.rowsOf(PROJECT);
    expect(rows.every((r) => r.status === "DELETED")).toBe(true);
    expect(w.cloud.listTaggedPage(PROJECT).items).toEqual([]);
  });

  it("listTaggedResources thấy cả tài nguyên Kubernetes sinh cho cluster; teardown xoá nó TRƯỚC mạng", async () => {
    const w = world(provider, plan, codec);
    const network = await w.runner().run(w.planOf("NETWORK", w.networkSteps));
    if (network.status !== "SUCCESS") throw new Error(network.status);
    await w.runner().run(w.planOf("CLUSTER", w.clusterSteps, network.created));
    const elb = await w.cloud.seedK8sManaged({
      kind: "k8s-loadbalancer",
      clusterName: plan.physicalName(PROJECT, "cluster"),
      attachedTo: network.created["vpc"]?.id ?? "",
    });

    const listed = await w.adapter.listTaggedResources(
      credential(provider),
      PROJECT,
    );
    expect(listed.status).toBe("SUCCESS");
    expect(listed.data?.find((r) => r.id === elb.id)?.managedByK8s).toBe(true);

    // Kind không gắn tag lúc tạo (GCP/Azure) không có trong danh sách theo tag: teardown
    // lấy thêm hàng sổ, tra lại bằng `lookupById` — đúng đường job TEARDOWN đi
    const seen = new Set((listed.data ?? []).map((r) => r.id));
    const fromLedger: CreatedResource[] = [];
    for (const row of await w.ledger.rowsOf(PROJECT)) {
      const step = [...w.networkSteps, ...w.clusterSteps].find(
        (s) => s.idempotencyKey === row.idempotencyKey,
      );
      if (step === undefined || row.providerId === null) continue;
      if (seen.has(row.providerId)) continue;
      const found = await step.lookupById(credential(provider), row.providerId);
      if (found.kind === "found") fromLedger.push(found.resource);
    }
    const torn = await w.adapter.teardown(credential(provider), [
      ...(listed.data ?? []),
      ...fromLedger,
    ]);
    expect(torn.data?.failed).toEqual([]);
    const deleted = torn.data?.deleted ?? [];
    expect(deleted.indexOf(elb.id)).toBeLessThan(
      deleted.indexOf(network.created["vpc"]?.id ?? ""),
    );
    expect(w.cloud.listTaggedPage(PROJECT).items).toEqual([]);
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

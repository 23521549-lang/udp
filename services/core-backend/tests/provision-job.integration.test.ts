import { randomUUID } from "node:crypto";
import {
  SecretBuffer,
  type ClusterAccess,
  type DomainAdapter,
  type ResolvedCredential,
} from "@udp/adapter-core";
import { SimulatedCrash, type RunnerObserver } from "@udp/adapter-core/runner";
import { KINDS_WITHOUT_CREATE_TAGS } from "@udp/adapter-core/testing";
import { env } from "@udp/config";
import type { DomainType } from "@udp/config/domains";
import { awsPlan } from "@udp/cloud-adapters/aws";
import { createPrismaClient } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import type { CapabilityBinding } from "@udp/shared-types";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { prisma as s1 } from "../src/core/db.js";
import type { JobKitDeps } from "../src/jobs/job-kit.js";
import { createJobWorker } from "../src/jobs/job-worker.js";
import type { ClusterRuntime } from "../src/modules/cluster/cluster-runtime.js";
import type { DomainAdapterRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import { closeFinishedCycle } from "../src/modules/provisioning/prisma-ledger.js";
import { payloadOf } from "../src/modules/provisioning/provision-plan.js";
import { requestCancel } from "../src/modules/provisioning/provisioning-job.repository.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";
import { inertProvisioning } from "./helpers/inert-deps.js";
import {
  simCloudPlatform,
  type SimCloudPlatform,
} from "./helpers/cloud-platform.js";

/**
 * Job PROVISION đầu–cuối (Plan #28 P4: AC-3, AC-4, AC-5, hủy) trên database THẬT, cloud là
 * kế hoạch AWS thật qua cổng mô phỏng, cluster là `ClusterRuntime` giả (chạy trên cluster
 * thật là nợ `I32-cluster`). Worker gọi thẳng handler — pg-boss đã có test riêng.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_provision_job_test_admin",
});

const REGION = "ap-southeast-1";
const QUOTA = {
  maxNodes: 3,
  maxNodeSize: "medium" as const,
  maxDatabases: 1,
  maxStorageGb: 50,
  maxLoadBalancers: 2,
};
const PROM_ENDPOINT = "http://prometheus.udp-system:9090";

let platform: SimCloudPlatform;
let app: ReturnType<typeof createApp>;
let world: TestWorld;
let owner: Actor;
const projects: string[] = [];

// ---------------------------------------------------------------- cluster giả

interface FakeClusters {
  runtime: ClusterRuntime;
  bootstrapped: { apiEndpoint: string; adminToken: string }[];
  failNextBootstrap(): void;
}

function fakeAccess(clusterId: string): ClusterAccess {
  return {
    mode: "direct",
    clusterId,
    getClient: () =>
      Promise.resolve({
        read: () => Promise.resolve(null),
        write: () => Promise.resolve(),
      }),
    proxyService: () => Promise.reject(new Error("không proxy trong test")),
    probe: () =>
      Promise.resolve({ status: "SUCCESS", data: { reachable: true } }),
  };
}

function fakeClusters(): FakeClusters {
  const bootstrapped: FakeClusters["bootstrapped"] = [];
  let failNext = false;
  return {
    bootstrapped,
    failNextBootstrap: () => {
      failNext = true;
    },
    runtime: {
      bootstrap: (info, adminToken) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("API server chưa trả lời"));
        }
        bootstrapped.push({
          apiEndpoint: info.apiEndpoint,
          adminToken: adminToken.token,
        });
        return Promise.resolve();
      },
      accessFor: (info) => fakeAccess(info.clusterId),
    },
  };
}

// ---------------------------------------------------------------- domain giả

interface FakeDomain {
  adapter: DomainAdapter;
  deploys: { environment: string | null; resolved: unknown }[];
  teardowns: number;
}

function fakeDomain(spec: {
  domainType: DomainType;
  toolId: string;
  scope: "cluster" | "namespace";
  provides?: CapabilityBinding[];
  requires?: { id: "metrics.query"; constraint: string }[];
  failDeploy?: boolean;
}): FakeDomain {
  const self: FakeDomain = {
    deploys: [],
    teardowns: 0,
    adapter: {
      domainType: spec.domainType,
      toolId: spec.toolId,
      version: "1.0.0",
      scope: spec.scope,
      capabilities: {
        provides: (spec.provides ?? []).map((b) => ({
          id: b.id,
          version: b.version,
        })),
        requires: spec.requires ?? [],
      },
      configSchema: z.object({}).strict(),
      deploy: (ctx) => {
        self.deploys.push({
          environment: ctx.environment?.name ?? null,
          resolved: ctx.resolved,
        });
        return Promise.resolve(
          spec.failDeploy === true
            ? { status: "FAILED", message: "chart không cài được" }
            : { status: "SUCCESS", data: spec.provides ?? [] },
        );
      },
      configure: () => Promise.resolve({ status: "SUCCESS", data: [] }),
      upgrade: () => Promise.resolve({ status: "SUCCESS", data: [] }),
      detectDrift: () =>
        Promise.resolve({ status: "SUCCESS", data: { drifted: false } }),
      onDependencyChanged: () => Promise.resolve({ status: "SUCCESS" }),
      healthcheck: () =>
        Promise.resolve({ status: "SUCCESS", data: { healthy: true } }),
      teardown: () => {
        self.teardowns += 1;
        return Promise.resolve({ status: "SUCCESS" });
      },
    },
  };
  return self;
}

function domainsWith(failDelivery = false) {
  const metrics = fakeDomain({
    domainType: "MONITORING",
    toolId: "fake-metrics",
    scope: "cluster",
    provides: [
      {
        id: "metrics.query",
        version: "2.0.0",
        providedBy: "monitoring:fake-metrics",
        endpoint: PROM_ENDPOINT,
      },
    ],
  });
  const delivery = fakeDomain({
    domainType: "PROGRESSIVE_DELIVERY",
    toolId: "fake-rollouts",
    scope: "namespace",
    requires: [{ id: "metrics.query", constraint: "^2" }],
    failDeploy: failDelivery,
  });
  const registry: DomainAdapterRegistry = {
    get: (domainType, toolId) =>
      [metrics, delivery].find(
        (d) =>
          d.adapter.domainType === domainType && d.adapter.toolId === toolId,
      )?.adapter,
    all: () => [],
  };
  return { metrics, delivery, registry };
}

// ---------------------------------------------------------------- dựng project + job

async function readyProject(): Promise<string> {
  const { projectId } = await world.newProject(owner);
  projects.push(projectId);
  await as(
    owner,
    request(app)
      .put(`${API}/projects/${projectId}/cloud`)
      .send({
        mode: "BYOC",
        provider: "AWS",
        region: REGION,
        credential: {
          authKind: "AWS_KEY",
          accessKeyId: "AKIAEXAMPLEEXAMPLE12",
          secretAccessKey: "bi-mat-cua-khach-trong-test-p4",
        },
      }),
  ).expect(200);
  await admin.domainConfig.createMany({
    data: [
      { domainType: "MONITORING", selectedTool: "fake-metrics" },
      { domainType: "PROGRESSIVE_DELIVERY", selectedTool: "fake-rollouts" },
    ].map((d) => ({
      ...d,
      projectId,
      isEnabled: true,
      domainStatus: "PENDING" as const,
      toolConfig: {},
    })),
  });
  return projectId;
}

async function seedJob(projectId: string): Promise<string> {
  const job = await admin.provisioningJob.create({
    data: {
      projectId,
      jobType: "PROVISION",
      payload: payloadOf({
        provider: "aws",
        region: REGION,
        quota: QUOTA,
        owner: owner.email,
        expiresAt: null,
        controlPlaneCidrs: ["203.0.113.0/24"],
      }),
    },
    select: { id: true },
  });
  return job.id;
}

function workerWith(
  registry: DomainAdapterRegistry,
  clusters: FakeClusters,
  over: Partial<JobKitDeps> = {},
) {
  return createJobWorker({
    prisma: s1,
    platform,
    domainRegistry: () => Promise.resolve(registry),
    clusters: clusters.runtime,
    egressFetch: () => Promise.reject(new Error("không có mạng trong test")),
    workerId: `w-${randomUUID().slice(0, 8)}`,
    lease: { leaseMs: 60_000, renewIntervalMs: 30_000, errorRetryMs: 1_000 },
    sleep: () => Promise.resolve(),
    ...over,
  });
}

const failingAt = (phase: string, stepName: string, make: () => Error) => {
  let fired = false;
  const observer: RunnerObserver = {
    onPhase(p, s) {
      if (!fired && p === phase && s === stepName) {
        fired = true;
        throw make();
      }
    },
  };
  return observer;
};

function credentialForSim(): ResolvedCredential {
  const payload = new SecretBuffer(JSON.stringify({ label: "du-quyen" }));
  return {
    provider: "aws",
    mode: "BYOC",
    authKind: "AWS_KEY",
    payload,
    expiresAt: new Date(Date.now() + 600_000),
    dispose: () => payload.dispose(),
  };
}

/** Tài nguyên THẬT trên cloud mô phỏng mang tag của project — đếm để bắt tạo trùng */
async function onCloud(projectId: string): Promise<number> {
  const adapter = platform.adapterFor("aws", REGION);
  const listed = await adapter?.listTaggedResources(
    credentialForSim(),
    projectId,
  );
  return listed?.data?.length ?? -1;
}

const snapshot = async (projectId: string, jobId: string) => {
  const [job, project, events, rows, bindings, domains] = await Promise.all([
    admin.provisioningJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { state: true, claimedBy: true, lastError: true },
    }),
    admin.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { status: true, clusterAccess: true },
    }),
    admin.deploymentEvent.findMany({
      where: { projectId },
      select: { eventType: true, deploymentId: true },
    }),
    admin.provisionedResource.findMany({
      where: { projectId },
      select: { status: true, idempotencyKey: true, kind: true },
    }),
    admin.capabilityBinding.findMany({
      where: { domainConfig: { projectId } },
      select: { capabilityId: true, endpoint: true, environmentId: true },
    }),
    admin.domainConfig.findMany({
      where: { projectId },
      select: { domainType: true, domainStatus: true },
      orderBy: { domainType: "asc" },
    }),
  ]);
  return { job, project, events, rows, bindings, domains };
};

/** Hàng sổ của kind mà cloud mô phỏng gắn tag lúc tạo — đúng tập quét theo tag nhìn thấy */
const taggable = (rows: { kind: string }[]) =>
  rows.filter(
    (r) => !(KINDS_WITHOUT_CREATE_TAGS as readonly string[]).includes(r.kind),
  ).length;

/** Lease ngắn nhưng được GIA HẠN trong lúc chạy: chết thì hết hạn sau ~2 giây */
const SHORT_LEASE = {
  leaseMs: 2_000,
  renewIntervalMs: 400,
  errorRetryMs: 400,
};
const leaseExpiry = () => new Promise((r) => setTimeout(r, 2_300));

const countOf = (events: { eventType: string }[], type: string) =>
  events.filter((e) => e.eventType === type).length;

beforeAll(async () => {
  platform = simCloudPlatform();
  app = createApp({
    metricsFor: () => new FakeMetricsProvider(),
    flagService: createFlagServiceClient({
      baseUrl: "http://127.0.0.1:9",
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
    oidcIssuer: null,
    cloud: platform,
    domainRegistry: () => Promise.resolve(domainsWith().registry),
    provisioning: inertProvisioning,
  });
  world = testWorld(app, admin);
  owner = await world.newActor("provision-owner");
});

afterAll(async () => {
  // Sổ và sự kiện deploy RESTRICT project — dọn trước khi xoá project
  await admin.provisionedResource.deleteMany({
    where: { projectId: { in: projects } },
  });
  await admin.deploymentEvent.deleteMany({
    where: { projectId: { in: projects } },
  });
  await world.cleanup();
  await admin.$disconnect();
});

/** Mỗi ô chạy một lượt provisioning đầy đủ trên database từ xa: ~20 giây, hai lượt ~40 */
describe("job PROVISION", { timeout: 120_000 }, () => {
  it("AC-3: DONE, project ACTIVE, cluster_access không token, binding trong bảng, DEPLOY_SUCCESS", async () => {
    const projectId = await readyProject();
    const jobId = await seedJob(projectId);
    const clusters = fakeClusters();
    const { metrics, delivery, registry } = domainsWith();

    await workerWith(registry, clusters).run(jobId, { final: false });

    const s = await snapshot(projectId, jobId);
    expect(s.job).toMatchObject({ state: "DONE", claimedBy: null });
    expect(s.project.status).toBe("ACTIVE");
    const access = JSON.stringify(s.project.clusterAccess);
    expect(access).toContain("apiEndpoint");
    expect(access).not.toContain("sim-token");
    expect(clusters.bootstrapped).toHaveLength(1);
    expect(clusters.bootstrapped[0]?.adminToken).toMatch(/^sim-token-/);

    expect(s.rows.length).toBeGreaterThan(0);
    expect(s.rows.every((r) => r.status === "READY")).toBe(true);
    expect(await onCloud(projectId)).toBe(taggable(s.rows));

    // Bậc 1 cung cấp metrics.query; bậc 2 (theo namespace, ba env) đọc nó TỪ BẢNG
    expect(s.domains.map((d) => d.domainStatus)).toEqual(["ACTIVE", "ACTIVE"]);
    expect(s.bindings).toEqual([
      {
        capabilityId: "metrics.query",
        endpoint: PROM_ENDPOINT,
        environmentId: null,
      },
    ]);
    expect(metrics.deploys).toHaveLength(1);
    expect(delivery.deploys.map((d) => d.environment)).toHaveLength(3);
    expect(delivery.deploys[0]?.resolved).toMatchObject({
      "metrics.query": { endpoint: PROM_ENDPOINT },
    });

    expect(countOf(s.events, "DEPLOY_START")).toBe(3);
    expect(countOf(s.events, "DEPLOY_SUCCESS")).toBe(3);
    expect(s.events.every((e) => e.deploymentId === jobId)).toBe(true);
  });

  it("AC-4: lỗi ở CLUSTER ⇒ bù trừ CẢ pha mạng, FAILED, project ERROR, DEPLOY_FAILURE", async () => {
    const projectId = await readyProject();
    const jobId = await seedJob(projectId);
    const { registry } = domainsWith();
    const worker = workerWith(registry, fakeClusters(), {
      observer: failingAt(
        "before-create",
        "cluster",
        () => new Error("InsufficientCapacity"),
      ),
    });

    await worker.run(jobId, { final: false });

    const s = await snapshot(projectId, jobId);
    expect(s.job).toMatchObject({ state: "FAILED", claimedBy: null });
    expect(JSON.stringify(s.job.lastError)).toContain("InsufficientCapacity");
    expect(s.project).toMatchObject({ status: "ERROR", clusterAccess: null });
    expect(s.rows.every((r) => r.status === "DELETED")).toBe(true);
    expect(await onCloud(projectId)).toBe(0);
    expect(countOf(s.events, "DEPLOY_FAILURE")).toBe(3);
  });

  it("chạy lại sau thất bại đã bù trừ sạch: đóng chu kỳ sổ rồi dựng lại từ đầu, DONE", async () => {
    const projectId = await readyProject();
    const failed = await seedJob(projectId);
    const { registry } = domainsWith();
    await workerWith(registry, fakeClusters(), {
      observer: failingAt(
        "before-create",
        "cluster",
        () => new Error("InsufficientCapacity"),
      ),
    }).run(failed, { final: false });
    expect((await snapshot(projectId, failed)).job.state).toBe("FAILED");

    // Đúng thứ `POST /provision` làm trong transaction tạo job
    const closed = await closeFinishedCycle(admin, projectId);
    expect(closed.length).toBeGreaterThan(0);
    const retry = await seedJob(projectId);
    await workerWith(registry, fakeClusters()).run(retry, {
      final: false,
    });

    const s = await snapshot(projectId, retry);
    expect(s.job.state).toBe("DONE");
    expect(s.project.status).toBe("ACTIVE");
    expect(await onCloud(projectId)).toBe(taggable(s.rows));
  });

  it("lỗi TẠM chưa phải lượt cuối ⇒ nhả lease và ném; lượt sau tiếp tục, không tạo trùng", async () => {
    const projectId = await readyProject();
    const jobId = await seedJob(projectId);
    const clusters = fakeClusters();
    const { registry } = domainsWith();
    const worker = workerWith(registry, clusters);

    clusters.failNextBootstrap();
    await expect(worker.run(jobId, { final: false })).rejects.toThrow(
      "API server chưa trả lời",
    );
    const mid = await snapshot(projectId, jobId);
    expect(mid.job).toMatchObject({ state: "CLUSTER_ACCESS", claimedBy: null });
    const created = await onCloud(projectId);

    await worker.run(jobId, { final: false });
    expect((await snapshot(projectId, jobId)).job.state).toBe("DONE");
    expect(await onCloud(projectId)).toBe(created);
  });

  it("AC-5: worker chết giữa pha CLUSTER ⇒ worker khác tiếp quản sau khi lease hết, kế thừa mạng từ SỔ, không trùng", async () => {
    const projectId = await readyProject();
    const jobId = await seedJob(projectId);
    const { registry } = domainsWith();
    const dying = workerWith(registry, fakeClusters(), {
      lease: SHORT_LEASE,
      observer: failingAt(
        "after-create-commit",
        "cluster",
        () => new SimulatedCrash("after-create-commit"),
      ),
    });
    await expect(dying.run(jobId, { final: false })).rejects.toThrow(
      SimulatedCrash,
    );
    expect((await snapshot(projectId, jobId)).job.state).toBe("CLUSTER");

    // Lease còn sống ⇒ worker khác KHÔNG được vào (ném để pg-boss thử lại, không bỏ job)
    const successor = workerWith(registry, fakeClusters());
    await expect(successor.run(jobId, { final: false })).rejects.toThrow(
      "đang được một worker khác giữ lease",
    );

    await leaseExpiry();
    await successor.run(jobId, { final: false });
    const s = await snapshot(projectId, jobId);
    expect(s.job.state).toBe("DONE");
    expect(await onCloud(projectId)).toBe(taggable(s.rows));
  });

  it("domain lỗi ⇒ domain ERROR, gỡ domain đã cài rồi bù trừ cloud", async () => {
    const projectId = await readyProject();
    const jobId = await seedJob(projectId);
    const { metrics, registry } = domainsWith(true);

    await workerWith(registry, fakeClusters()).run(jobId, {
      final: false,
    });

    const s = await snapshot(projectId, jobId);
    expect(s.job.state).toBe("FAILED");
    expect(JSON.stringify(s.job.lastError)).toContain("chart không cài được");
    expect(metrics.teardowns).toBe(1);
    expect(await onCloud(projectId)).toBe(0);
    expect(s.project.status).toBe("ERROR");
  });

  it("hủy giữa pha CLUSTER ⇒ bù trừ sạch, FAILED, project về DRAFT", async () => {
    const projectId = await readyProject();
    const jobId = await seedJob(projectId);
    const { registry } = domainsWith();
    const cancelOnCluster: RunnerObserver = {
      async onPhase(phase, stepName) {
        if (phase === "before-lookup" && stepName === "cluster") {
          await requestCancel(s1, jobId);
        }
      },
    };

    await workerWith(registry, fakeClusters(), {
      observer: cancelOnCluster,
    }).run(jobId, { final: false });

    const s = await snapshot(projectId, jobId);
    expect(s.job.state).toBe("FAILED");
    expect(JSON.stringify(s.job.lastError)).toContain("hủy theo yêu cầu");
    expect(s.project.status).toBe("DRAFT");
    expect(await onCloud(projectId)).toBe(0);
  });

  it("project bị xoá mềm giữa chừng ⇒ bù trừ xong KHÔNG hồi sinh project (Plan #29 QĐ-3)", async () => {
    const projectId = await readyProject();
    const jobId = await seedJob(projectId);
    const { registry } = domainsWith();
    const deleteOnCluster: RunnerObserver = {
      async onPhase(phase, stepName) {
        if (phase === "before-lookup" && stepName === "cluster") {
          await admin.project.update({
            where: { id: projectId },
            data: { status: "DELETED" },
          });
          await requestCancel(s1, jobId);
        }
      },
    };
    await workerWith(registry, fakeClusters(), {
      observer: deleteOnCluster,
    }).run(jobId, { final: false });

    const s = await snapshot(projectId, jobId);
    expect(s.job.state).toBe("FAILED");
    expect(s.project.status).toBe("DELETED");
    expect(await onCloud(projectId)).toBe(0);
  });

  it("hủy khi còn QUEUED ⇒ không chạm cloud, không sự kiện deploy lẻ, project giữ DRAFT", async () => {
    const projectId = await readyProject();
    const jobId = await seedJob(projectId);
    expect(await requestCancel(s1, jobId)).toBe(true);

    await workerWith(domainsWith().registry, fakeClusters()).run(jobId, {
      final: false,
    });

    const s = await snapshot(projectId, jobId);
    expect(s.job).toMatchObject({ state: "FAILED", claimedBy: null });
    expect(s.project.status).toBe("DRAFT");
    expect(s.events).toEqual([]);
    expect(s.rows).toEqual([]);
    expect(await requestCancel(s1, jobId)).toBe(false);
  });

  it("job bù trừ của đối soát: lượt cuối đã chết giữa chừng ⇒ dọn sạch, FAILED", async () => {
    const projectId = await readyProject();
    const jobId = await seedJob(projectId);
    const { registry } = domainsWith();
    await expect(
      workerWith(registry, fakeClusters(), {
        lease: SHORT_LEASE,
        observer: failingAt(
          "before-lookup",
          "cluster",
          () => new SimulatedCrash("before-lookup"),
        ),
      }).run(jobId, { final: true }),
    ).rejects.toThrow(SimulatedCrash);
    expect(await onCloud(projectId)).toBeGreaterThan(0);

    await leaseExpiry();
    await workerWith(registry, fakeClusters()).compensate(jobId);
    const s = await snapshot(projectId, jobId);
    expect(s.job.state).toBe("FAILED");
    expect(await onCloud(projectId)).toBe(0);
  });
});

/** Job TEARDOWN mang lại payload của lượt PROVISION (cloud, region, tag) — như `DELETE` */
async function seedTeardown(projectId: string, from: string): Promise<string> {
  const source = await admin.provisioningJob.findUniqueOrThrow({
    where: { id: from },
    select: { payload: true },
  });
  const job = await admin.provisioningJob.create({
    data: {
      projectId,
      jobType: "TEARDOWN",
      payload: source.payload ?? {},
    },
    select: { id: true },
  });
  return job.id;
}

describe("job TEARDOWN", { timeout: 120_000 }, () => {
  it("AC-1 + AC-2: gỡ domain, xoá tài nguyên Kubernetes sinh TRƯỚC mạng, cloud sạch, sổ DELETED", async () => {
    const projectId = await readyProject();
    const provisioned = await seedJob(projectId);
    const { metrics, delivery, registry } = domainsWith();
    const worker = workerWith(registry, fakeClusters());
    await worker.run(provisioned, { final: false });
    expect((await snapshot(projectId, provisioned)).job.state).toBe("DONE");

    const vpc = await admin.provisionedResource.findFirstOrThrow({
      where: { projectId, kind: "vpc" },
      select: { providerId: true },
    });
    const elb = await platform.cloud.seedK8sManaged({
      kind: "k8s-loadbalancer",
      clusterName: awsPlan.physicalName(projectId, "cluster"),
      attachedTo: vpc.providerId ?? "",
    });

    const teardown = await seedTeardown(projectId, provisioned);
    await worker.run(teardown, { final: false });

    const s = await snapshot(projectId, teardown);
    expect(s.job).toMatchObject({ state: "DONE", claimedBy: null });
    expect(s.project.clusterAccess).toBeNull();
    expect(s.rows.every((r) => r.status === "DELETED")).toBe(true);
    expect(await onCloud(projectId)).toBe(0);
    expect(platform.cloud.describeById(elb.id)).toBeNull();
    expect(metrics.teardowns).toBe(1);
    expect(delivery.teardowns).toBe(3);
  });

  it("chạy lại một TEARDOWN đã xong là không làm gì (idempotent)", async () => {
    const projectId = await readyProject();
    const provisioned = await seedJob(projectId);
    const { registry } = domainsWith();
    const worker = workerWith(registry, fakeClusters());
    await worker.run(provisioned, { final: false });
    const teardown = await seedTeardown(projectId, provisioned);
    await worker.run(teardown, { final: false });
    await worker.compensate(teardown);
    expect((await snapshot(projectId, teardown)).job.state).toBe("DONE");
  });
});

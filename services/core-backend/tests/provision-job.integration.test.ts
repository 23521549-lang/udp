import { randomUUID } from "node:crypto";
import {
  SecretBuffer,
  type ClusterAccess,
  type DomainAdapter,
  type ResolvedCredential,
} from "@udp/adapter-core";
import { SimulatedCrash, type RunnerObserver } from "@udp/adapter-core/runner";
import {
  createFakeClusterAccess,
  KINDS_WITHOUT_CREATE_TAGS,
} from "@udp/adapter-core/testing";
import { env, k8sNamespaceFor } from "@udp/config";
import type { DomainType } from "@udp/config/domains";
import { awsPlan } from "@udp/cloud-adapters/aws";
import { createPrismaClient } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import type { CapabilityBinding } from "@udp/shared-types";
import { ENVIRONMENT_ERROR_SLUGS } from "@udp/shared-types/environment-api";
import { PROVISION_ERROR_SLUGS } from "@udp/shared-types/provisioning-api";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import {
  createFlagServiceClient,
  type FlagServiceClient,
} from "../src/core/clients/flag-service.client.js";
import { prisma as s1 } from "../src/core/db.js";
import type { JobKitDeps } from "../src/jobs/job-kit.js";
import { sweepDrift } from "../src/jobs/drift-scan.job.js";
import { createJobKit, PhaseFailedError } from "../src/jobs/job-kit.js";
import { createJobWorker } from "../src/jobs/job-worker.js";
import { sweepOrphans } from "../src/jobs/orphan-scan.job.js";
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
import {
  inertProvisioning,
  noEgress,
  noExternalAuth,
  noRepoSource,
  outsidePlatform,
} from "./helpers/inert-deps.js";
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
  bootstrapped: {
    apiEndpoint: string;
    adminToken: string;
    /** Tên environment mà lần bootstrap dựng namespace cho (Plan #40) */
    environments: string[];
  }[];
  /** Namespace đã bị xoá bằng token admin (Plan #40 REMOVE) */
  removedNamespaces: string[];
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
    issuerKeys: () =>
      Promise.reject(new Error("không đọc khoá issuer trong test")),
    probe: () =>
      Promise.resolve({ status: "SUCCESS", data: { reachable: true } }),
  };
}

function fakeClusters(): FakeClusters {
  const bootstrapped: FakeClusters["bootstrapped"] = [];
  const removedNamespaces: string[] = [];
  let failNext = false;
  return {
    bootstrapped,
    removedNamespaces,
    failNextBootstrap: () => {
      failNext = true;
    },
    runtime: {
      bootstrap: (info, adminToken, input) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("API server chưa trả lời"));
        }
        bootstrapped.push({
          apiEndpoint: info.apiEndpoint,
          adminToken: adminToken.token,
          environments: input.environments.map((e) => e.name),
        });
        return Promise.resolve();
      },
      removeNamespace: (_info, _admin, namespace) => {
        removedNamespaces.push(namespace);
        return Promise.resolve();
      },
      accessFor: (info) => fakeAccess(info.clusterId),
      boundToken: (_info, adminToken, identity) =>
        Promise.resolve({
          token: `bound-${identity}-${adminToken.token}`,
          expiresAt: adminToken.expiresAt,
        }),
    },
  };
}

// ---------------------------------------------------------------- domain giả

interface FakeDomain {
  adapter: DomainAdapter;
  deploys: { environment: string | null; resolved: unknown }[];
  teardowns: number;
  /** Environment của mỗi lần gỡ (`null` = phạm vi cluster) — Plan #40 */
  teardownEnvs: (string | null)[];
  /** Môi trường mỗi lần `detectDrift` được hỏi (`null` = phạm vi cluster) */
  driftChecks: (string | null)[];
  /** Đặt để lần quét sau thấy trôi */
  drifted: boolean;
}

/** Nhật ký sự kiện CHUNG của mọi adapter giả — để khẳng định thứ tự giữa các adapter */
const events: string[] = [];

function fakeDomain(spec: {
  domainType: DomainType;
  toolId: string;
  scope: "cluster" | "namespace";
  provides?: CapabilityBinding[];
  requires?: { id: "metrics.query"; constraint: string }[];
  failDeploy?: boolean;
  /** [Plan #40] `teardown` trả FAILED — gỡ khỏi environment không xong */
  failTeardown?: boolean;
  unhealthy?: boolean;
}): FakeDomain {
  const log = (verb: string) => {
    events.push(`${spec.toolId}:${verb}`);
  };
  const self: FakeDomain = {
    deploys: [],
    teardowns: 0,
    teardownEnvs: [],
    driftChecks: [],
    drifted: false,
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
        log("deploy");
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
      detectDrift: (ctx) => {
        self.driftChecks.push(ctx.environment?.name ?? null);
        return Promise.resolve({
          status: "SUCCESS",
          data: self.drifted
            ? { drifted: true, details: "replicas 3 ≠ 1" }
            : { drifted: false },
        });
      },
      onDependencyChanged: (ctx, _config, changed) => {
        log(`notify:${changed.providedBy}:${ctx.environment?.name ?? "-"}`);
        return Promise.resolve({ status: "SUCCESS" });
      },
      healthcheck: () => {
        log("healthcheck");
        return Promise.resolve({
          status: "SUCCESS",
          data: { healthy: spec.unhealthy !== true },
        });
      },
      teardown: (ctx, reason) => {
        log(`teardown:${reason}`);
        self.teardowns += 1;
        self.teardownEnvs.push(ctx.environment?.name ?? null);
        return Promise.resolve(
          spec.failTeardown === true
            ? { status: "FAILED", message: "release không gỡ được" }
            : { status: "SUCCESS" },
        );
      },
    },
  };
  return self;
}

function domainsWith(failDelivery = false, failDeliveryTeardown = false) {
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
    failTeardown: failDeliveryTeardown,
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

function depsWith(
  registry: DomainAdapterRegistry,
  clusters: FakeClusters,
  over: Partial<JobKitDeps> = {},
): JobKitDeps {
  return {
    prisma: s1,
    platform,
    domainRegistry: () => Promise.resolve(registry),
    clusters: clusters.runtime,
    egressFetch: () => Promise.reject(new Error("không có mạng trong test")),
    workerId: `w-${randomUUID().slice(0, 8)}`,
    lease: { leaseMs: 60_000, renewIntervalMs: 30_000, errorRetryMs: 1_000 },
    sleep: () => Promise.resolve(),
    ...over,
  };
}

const workerWith = (...args: Parameters<typeof depsWith>) =>
  createJobWorker(depsWith(...args));

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
    repoSource: noRepoSource,
    egressFetch: noEgress,
    platform: outsidePlatform,
    auth: noExternalAuth,
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

describe("lịch orphan-scan và drift-scan", { timeout: 120_000 }, () => {
  it("AC-6: CREATING treo — thấy trên cloud ⇒ gắn provider_id (CREATED); cloud không còn ⇒ giữ nguyên", async () => {
    const projectId = await readyProject();
    const jobId = await seedJob(projectId);
    const { registry } = domainsWith();
    const clusters = fakeClusters();
    await workerWith(registry, clusters).run(jobId, { final: false });

    const old = new Date(Date.now() - 60 * 60_000);
    const [vpc, subnet] = await Promise.all(
      ["vpc", "subnet-public-a"].map((name) =>
        admin.provisionedResource.findFirstOrThrow({
          where: { projectId, idempotencyKey: { endsWith: `:${name}` } },
          select: { idempotencyKey: true, providerId: true },
        }),
      ),
    );
    if (vpc === undefined || subnet === undefined)
      throw new Error("thiếu hàng");
    // K3: cloud đã tạo, sổ chưa kịp ghi id
    await admin.provisionedResource.update({
      where: { idempotencyKey: vpc.idempotencyKey },
      data: { status: "CREATING", providerId: null, updatedAt: old },
    });
    // Cloud không còn gì cho hàng thứ hai
    await admin.provisionedResource.update({
      where: { idempotencyKey: subnet.idempotencyKey },
      data: { status: "CREATING", updatedAt: old },
    });
    await platform.cloud.deleteOutOfBand(subnet.providerId ?? "");

    const outcome = await sweepOrphans(
      createJobKit(depsWith(registry, clusters)),
      { only: [projectId] },
    );
    expect(outcome.resolved).toEqual([vpc.idempotencyKey]);
    expect(outcome.unresolved).toEqual([subnet.idempotencyKey]);
    const rows = await admin.provisionedResource.findMany({
      where: {
        idempotencyKey: { in: [vpc.idempotencyKey, subnet.idempotencyKey] },
      },
      select: { idempotencyKey: true, status: true, providerId: true },
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          idempotencyKey: vpc.idempotencyKey,
          status: "CREATED",
          providerId: vpc.providerId,
        },
        expect.objectContaining({
          idempotencyKey: subnet.idempotencyKey,
          status: "CREATING",
        }),
      ]),
    );
  });

  it("AC-7: ba lượt quét trên domain đang trôi ⇒ đúng MỘT lần ghi last_error; adapter theo namespace được hỏi ở mọi environment", async () => {
    const projectId = await readyProject();
    const jobId = await seedJob(projectId);
    const { metrics, delivery, registry } = domainsWith();
    const clusters = fakeClusters();
    await workerWith(registry, clusters).run(jobId, { final: false });
    const kit = createJobKit(depsWith(registry, clusters));

    metrics.drifted = true;
    const updatedAt = async () =>
      await admin.domainConfig.findFirstOrThrow({
        where: { projectId, domainType: "MONITORING" },
        select: { updatedAt: true, lastError: true },
      });
    for (let i = 0; i < 3; i += 1) {
      await sweepDrift(kit, { only: [projectId] });
    }
    const after = await updatedAt();
    expect(after.lastError).toMatchObject({
      step: "DRIFT_SCAN",
      adapterResult: "DRIFTED",
    });
    await sweepDrift(kit, { only: [projectId] });
    expect((await updatedAt()).updatedAt).toEqual(after.updatedAt);
    expect(metrics.driftChecks.every((e) => e === null)).toBe(true);
    expect(delivery.driftChecks.slice(0, 3).sort()).toEqual([
      "dev",
      "prod",
      "staging",
    ]);
  });

  it("[Plan #51] token cho Service 3: bound token của ĐÚNG identity, cùng địa chỉ và CA của cluster đã dựng", async () => {
    const projectId = await readyProject();
    const jobId = await seedJob(projectId);
    const { registry } = domainsWith();
    const clusters = fakeClusters();
    await workerWith(registry, clusters).run(jobId, { final: false });
    const issued = await createJobKit(
      depsWith(registry, clusters),
    ).projectClusterToken(projectId, "traffic");
    const [built] = clusters.bootstrapped;
    expect(issued.apiEndpoint).toBe(built?.apiEndpoint);
    expect(issued.caData.length).toBeGreaterThan(0);
    expect(issued.token).toBe(`bound-traffic-${String(built?.adminToken)}`);
  });

  it("[Plan #51] project chưa có cluster ⇒ lỗi vĩnh viễn, không token nào", async () => {
    const projectId = await readyProject();
    const { registry } = domainsWith();
    await expect(
      createJobKit(depsWith(registry, fakeClusters())).projectClusterToken(
        projectId,
        "traffic",
      ),
    ).rejects.toBeInstanceOf(PhaseFailedError);
  });
});

/** Registry cho luồng áp domain: tool Monitoring thứ hai + một domain Tracing độc lập */
function applyWorld(options: { unhealthySwitch?: boolean } = {}) {
  const base = domainsWith();
  const metricsB = fakeDomain({
    domainType: "MONITORING",
    toolId: "fake-metrics-b",
    scope: "cluster",
    unhealthy: options.unhealthySwitch === true,
    provides: [
      {
        id: "metrics.query",
        version: "2.1.0",
        providedBy: "monitoring:fake-metrics-b",
        endpoint: "http://vmselect.udp-system:8481",
      },
    ],
  });
  const tracer = fakeDomain({
    domainType: "TRACING",
    toolId: "fake-tracer",
    scope: "cluster",
  });
  const all = [base.metrics, base.delivery, metricsB, tracer];
  const registry: DomainAdapterRegistry = {
    get: (domainType, toolId) =>
      all.find(
        (d) =>
          d.adapter.domainType === domainType && d.adapter.toolId === toolId,
      )?.adapter,
    all: () => [],
  };
  return { ...base, metricsB, tracer, registry };
}

/** Project đã chạy (PROVISION DONE) với fake-metrics + fake-rollouts */
async function activeProject(registry: DomainAdapterRegistry) {
  const projectId = await readyProject();
  const provisioned = await seedJob(projectId);
  await workerWith(registry, fakeClusters()).run(provisioned, {
    final: false,
  });
  expect((await snapshot(projectId, provisioned)).job.state).toBe("DONE");
  return { projectId, provisioned };
}

async function seedApply(
  projectId: string,
  provisioned: string,
  domains: { domainType: string; toolId: string }[],
): Promise<string> {
  const source = await admin.provisioningJob.findUniqueOrThrow({
    where: { id: provisioned },
    select: { payload: true },
  });
  const job = await admin.provisioningJob.create({
    data: {
      projectId,
      jobType: "DOMAIN_APPLY",
      payload: {
        infra: source.payload ?? {},
        change: {
          kind: "apply",
          target: {
            domains: domains.map((d) => ({ ...d, config: {} })),
            preferences: [],
          },
        },
      },
    },
    select: { id: true },
  });
  return job.id;
}

/** [Plan #45] Job áp lại MỘT domain về cấu hình đang lưu — như `POST …/retry` ghi */
async function seedReapply(
  projectId: string,
  provisioned: string,
  domainType: string,
): Promise<string> {
  const source = await admin.provisioningJob.findUniqueOrThrow({
    where: { id: provisioned },
    select: { payload: true },
  });
  const job = await admin.provisioningJob.create({
    data: {
      projectId,
      jobType: "DOMAIN_APPLY",
      payload: {
        infra: source.payload ?? {},
        change: { kind: "reapply", domainType },
      },
    },
    select: { id: true },
  });
  return job.id;
}

const domainRows = (projectId: string) =>
  admin.domainConfig.findMany({
    where: { projectId },
    select: {
      domainType: true,
      selectedTool: true,
      isEnabled: true,
      domainStatus: true,
    },
    orderBy: { domainType: "asc" },
  });

describe("job DOMAIN_APPLY", { timeout: 120_000 }, () => {
  it("AC-3: đổi tool là blue/green — dựng mới, kiểm khoẻ, báo consumer ở MỌI env, RỒI mới gỡ cũ", async () => {
    const w = applyWorld();
    const { projectId, provisioned } = await activeProject(w.registry);
    const jobId = await seedApply(projectId, provisioned, [
      { domainType: "MONITORING", toolId: "fake-metrics-b" },
      { domainType: "PROGRESSIVE_DELIVERY", toolId: "fake-rollouts" },
    ]);
    events.length = 0;

    await workerWith(w.registry, fakeClusters()).run(jobId, { final: false });

    expect((await snapshot(projectId, jobId)).job.state).toBe("DONE");
    const at = (e: string) => events.indexOf(e);
    expect(at("fake-metrics-b:deploy")).toBeGreaterThanOrEqual(0);
    expect(at("fake-metrics-b:healthcheck")).toBeGreaterThan(
      at("fake-metrics-b:deploy"),
    );
    const notified = events.filter((e) =>
      e.startsWith("fake-rollouts:notify:monitoring:fake-metrics-b"),
    );
    expect(notified.map((e) => e.split(":").at(-1)).sort()).toEqual([
      "dev",
      "prod",
      "staging",
    ]);
    expect(at("fake-metrics:teardown:switch")).toBeGreaterThan(
      Math.max(...notified.map(at)),
    );

    const bindings = await admin.capabilityBinding.findMany({
      where: { domainConfig: { projectId }, capabilityId: "metrics.query" },
      select: { providedBy: true },
    });
    expect(bindings).toEqual([{ providedBy: "monitoring:fake-metrics-b" }]);
    expect(await domainRows(projectId)).toEqual(
      expect.arrayContaining([
        {
          domainType: "MONITORING",
          selectedTool: "fake-metrics-b",
          isEnabled: true,
          domainStatus: "ACTIVE",
        },
      ]),
    );
  });

  it("AC-3 nhánh hỏng: tool mới không khoẻ ⇒ gỡ cái MỚI, GIỮ cái cũ, consumer không bị chạm", async () => {
    const w = applyWorld({ unhealthySwitch: true });
    const { projectId, provisioned } = await activeProject(w.registry);
    const jobId = await seedApply(projectId, provisioned, [
      { domainType: "MONITORING", toolId: "fake-metrics-b" },
      { domainType: "PROGRESSIVE_DELIVERY", toolId: "fake-rollouts" },
    ]);
    events.length = 0;

    await workerWith(w.registry, fakeClusters()).run(jobId, { final: false });

    const s = await snapshot(projectId, jobId);
    expect(s.job.state).toBe("FAILED");
    expect(events).toContain("fake-metrics-b:teardown:switch");
    expect(events).not.toContain("fake-metrics:teardown:switch");
    expect(events.some((e) => e.includes(":notify:"))).toBe(false);
    const monitoring = (await domainRows(projectId)).find(
      (r) => r.domainType === "MONITORING",
    );
    expect(monitoring).toMatchObject({
      selectedTool: "fake-metrics",
      domainStatus: "ERROR",
    });
  });

  it("AC-2 + AC-4: bật domain mới và tắt domain cũ — tắt đi SAU, bằng lý do disable", async () => {
    const w = applyWorld();
    const { projectId, provisioned } = await activeProject(w.registry);
    const jobId = await seedApply(projectId, provisioned, [
      { domainType: "MONITORING", toolId: "fake-metrics" },
      { domainType: "TRACING", toolId: "fake-tracer" },
    ]);
    events.length = 0;

    await workerWith(w.registry, fakeClusters()).run(jobId, { final: false });

    expect((await snapshot(projectId, jobId)).job.state).toBe("DONE");
    expect(events.indexOf("fake-tracer:deploy")).toBeLessThan(
      events.indexOf("fake-rollouts:teardown:disable"),
    );
    expect(await domainRows(projectId)).toEqual(
      expect.arrayContaining([
        {
          domainType: "PROGRESSIVE_DELIVERY",
          selectedTool: "fake-rollouts",
          isEnabled: false,
          domainStatus: "PENDING",
        },
        {
          domainType: "TRACING",
          selectedTool: "fake-tracer",
          isEnabled: true,
          domainStatus: "ACTIVE",
        },
      ]),
    );
  });

  it("[Plan #45] reapply: domain ERROR áp lại đúng cấu hình đang lưu ⇒ ACTIVE, last_error xoá, không đụng domain khác", async () => {
    const w = applyWorld();
    const { projectId, provisioned } = await activeProject(w.registry);
    await admin.domainConfig.updateMany({
      where: { projectId, domainType: "MONITORING" },
      data: {
        domainStatus: "ERROR",
        lastError: { step: "DEPLOY", message: "lượt trước hỏng" },
      },
    });
    const jobId = await seedReapply(projectId, provisioned, "MONITORING");
    events.length = 0;

    await workerWith(w.registry, fakeClusters()).run(jobId, { final: false });

    expect((await snapshot(projectId, jobId)).job.state).toBe("DONE");
    expect(events).toContain("fake-metrics:deploy");
    expect(events.indexOf("fake-metrics:healthcheck")).toBeGreaterThan(
      events.indexOf("fake-metrics:deploy"),
    );
    expect(events.some((e) => e.startsWith("fake-rollouts:deploy"))).toBe(
      false,
    );
    const row = await admin.domainConfig.findFirstOrThrow({
      where: { projectId, domainType: "MONITORING" },
      select: { domainStatus: true, lastError: true },
    });
    expect(row).toEqual({ domainStatus: "ACTIVE", lastError: null });
  });

  it("[Plan #45] reapply nhánh hỏng: adapter không khoẻ ⇒ domain ERROR có bước, job FAILED", async () => {
    const w = applyWorld();
    const { projectId, provisioned } = await activeProject(w.registry);
    const sick = fakeDomain({
      domainType: "MONITORING",
      toolId: "fake-metrics",
      scope: "cluster",
      unhealthy: true,
      provides: [
        {
          id: "metrics.query",
          version: "2.0.0",
          providedBy: "monitoring:fake-metrics",
          endpoint: PROM_ENDPOINT,
        },
      ],
    });
    const registry: DomainAdapterRegistry = {
      get: (domainType, toolId) =>
        domainType === "MONITORING" && toolId === "fake-metrics"
          ? sick.adapter
          : w.registry.get(domainType, toolId),
      all: () => [],
    };
    const jobId = await seedReapply(projectId, provisioned, "MONITORING");

    await workerWith(registry, fakeClusters()).run(jobId, { final: false });

    expect((await snapshot(projectId, jobId)).job.state).toBe("FAILED");
    const row = await admin.domainConfig.findFirstOrThrow({
      where: { projectId, domainType: "MONITORING" },
      select: { domainStatus: true, lastError: true },
    });
    expect(row.domainStatus).toBe("ERROR");
    expect(row.lastError).toMatchObject({ step: "HEALTHCHECK" });
  });
});

/** App riêng cho luồng HTTP của Plan #30: registry của `applyWorld`, hàng đợi ghi id */
// ------------------------------------------------------ ENVIRONMENT_APPLY (Plan #40)

/** Hàng environment như `POST /environments` để lại (backfill là việc của S2, không chạy ở đây) */
async function addEnvironmentRow(projectId: string, name: string) {
  const project = await admin.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true },
  });
  return admin.environment.create({
    data: {
      projectId,
      name,
      rank: 9,
      k8sNamespace: k8sNamespaceFor(project.name, projectId, name),
    },
    select: { id: true, name: true, k8sNamespace: true, isProduction: true },
  });
}

async function seedEnvironmentJob(
  projectId: string,
  provisioned: string,
  action: "ADD" | "REMOVE",
  environment: Awaited<ReturnType<typeof addEnvironmentRow>>,
): Promise<string> {
  const source = await admin.provisioningJob.findUniqueOrThrow({
    where: { id: provisioned },
    select: { payload: true },
  });
  const job = await admin.provisioningJob.create({
    data: {
      projectId,
      jobType: "ENVIRONMENT_APPLY",
      payload: { infra: source.payload ?? {}, change: { action, environment } },
    },
    select: { id: true },
  });
  return job.id;
}

describe("job ENVIRONMENT_APPLY (Plan #40)", { timeout: 120_000 }, () => {
  it("ADD: bootstrap với MỌI environment; adapter theo namespace deploy CHỈ trên env mới, cluster-scoped deploy lại; DONE", async () => {
    const w = domainsWith();
    const { projectId, provisioned } = await activeProject(w.registry);
    const qa = await addEnvironmentRow(projectId, "qa");
    w.metrics.deploys.length = 0;
    w.delivery.deploys.length = 0;
    const clusters = fakeClusters();

    const jobId = await seedEnvironmentJob(projectId, provisioned, "ADD", qa);
    await workerWith(w.registry, clusters).run(jobId, { final: false });

    expect((await snapshot(projectId, jobId)).job.state).toBe("DONE");
    expect(clusters.bootstrapped.map((b) => b.environments)).toEqual([
      ["dev", "staging", "prod", "qa"],
    ]);
    expect(w.delivery.deploys.map((d) => d.environment)).toEqual(["qa"]);
    expect(w.metrics.deploys.map((d) => d.environment)).toEqual([null]);
    expect(clusters.removedNamespaces).toEqual([]);
  });

  it("REMOVE: adapter theo namespace gỡ khỏi env đã bỏ (disable), cluster-scoped deploy lại với tập còn lại, namespace bị xoá", async () => {
    const w = domainsWith();
    const { projectId, provisioned } = await activeProject(w.registry);
    const qa = await addEnvironmentRow(projectId, "qa");
    // Như route DELETE: hàng environment đi TRƯỚC, job mang bản chụp
    await admin.environment.delete({ where: { id: qa.id } });
    w.metrics.deploys.length = 0;
    events.length = 0;
    const clusters = fakeClusters();

    const jobId = await seedEnvironmentJob(
      projectId,
      provisioned,
      "REMOVE",
      qa,
    );
    await workerWith(w.registry, clusters).run(jobId, { final: false });

    expect((await snapshot(projectId, jobId)).job.state).toBe("DONE");
    expect(w.delivery.teardownEnvs).toEqual(["qa"]);
    expect(events).toContain("fake-rollouts:teardown:disable");
    expect(w.metrics.deploys.map((d) => d.environment)).toEqual([null]);
    expect(clusters.bootstrapped).toEqual([]);
    expect(clusters.removedNamespaces).toEqual([qa.k8sNamespace]);
  });

  it("REMOVE mà gỡ domain lỗi ⇒ FAILED kèm lý do, namespace GIỮ lại cho lần chạy lại", async () => {
    const w = domainsWith(false, true);
    const { projectId, provisioned } = await activeProject(w.registry);
    const qa = await addEnvironmentRow(projectId, "qa");
    await admin.environment.delete({ where: { id: qa.id } });
    const clusters = fakeClusters();

    const jobId = await seedEnvironmentJob(
      projectId,
      provisioned,
      "REMOVE",
      qa,
    );
    await workerWith(w.registry, clusters).run(jobId, { final: false });

    const { job } = await snapshot(projectId, jobId);
    expect(job.state).toBe("FAILED");
    expect(JSON.stringify(job.lastError)).toContain(
      "PROGRESSIVE_DELIVERY: release không gỡ được",
    );
    expect(clusters.removedNamespaces).toEqual([]);
  });
});

function appFor(
  registry: DomainAdapterRegistry,
  scanDrift: ((projectId: string, domainType: string) => Promise<void>) | null,
  flagService: FlagServiceClient = createFlagServiceClient({
    baseUrl: "http://127.0.0.1:9",
    secret: env.INTERNAL_SERVICE_SECRET,
  }),
) {
  const enqueued: string[] = [];
  const http = createApp({
    metricsFor: () => new FakeMetricsProvider(),
    flagService,
    oidcIssuer: null,
    cloud: platform,
    repoSource: noRepoSource,
    egressFetch: noEgress,
    platform: outsidePlatform,
    auth: noExternalAuth,
    domainRegistry: () => Promise.resolve(registry),
    provisioning: {
      egressCidrs: ["203.0.113.0/24"],
      enqueue: (jobId) => {
        enqueued.push(jobId);
        return Promise.resolve();
      },
      enqueueDeploy: null,
      withCluster: null,
      scanDrift,
      clusterToken: null,
      clusterIssuerKeys: null,
      flaggerGateBaseUrl: null,
    },
  });
  return { http, enqueued };
}

describe(
  "HTTP domain cho project đang chạy (Plan #30 P3)",
  { timeout: 120_000 },
  () => {
    const domainsUrl = (projectId: string) =>
      `${API}/projects/${projectId}/domains`;

    it("AC-1: PUT trên ACTIVE ⇒ 202 job DOMAIN_APPLY, khoá tăng, bảng giữ thứ đang chạy; khoá cũ ⇒ 409", async () => {
      const w = applyWorld();
      const { projectId } = await activeProject(w.registry);
      const { http, enqueued } = appFor(w.registry, null);
      const before = await as(
        owner,
        request(http).get(domainsUrl(projectId)),
      ).expect(200);
      const version = before.body.domainSetVersion as number;
      const body = {
        domains: [
          { domainType: "MONITORING", toolId: "fake-metrics-b", config: {} },
          {
            domainType: "PROGRESSIVE_DELIVERY",
            toolId: "fake-rollouts",
            config: {},
          },
        ],
        preferences: [],
        lastKnownDomainSetVersion: version,
      };

      const res = await as(
        owner,
        request(http).put(domainsUrl(projectId)).send(body),
      ).expect(202);
      expect(res.body.job).toMatchObject({
        jobType: "DOMAIN_APPLY",
        state: "QUEUED",
      });
      expect(res.body.domainSetVersion).toBe(version + 1);
      expect(
        (
          res.body.domains as {
            domainType: string;
            selectedTool: string | null;
          }[]
        ).find((d) => d.domainType === "MONITORING")?.selectedTool,
      ).toBe("fake-metrics");
      expect(enqueued).toEqual([res.body.job.id]);

      await as(
        owner,
        request(http).put(domainsUrl(projectId)).send(body),
      ).expect(409);

      await workerWith(w.registry, fakeClusters()).run(
        res.body.job.id as string,
        {
          final: false,
        },
      );
      const after = await as(
        owner,
        request(http).get(domainsUrl(projectId)),
      ).expect(200);
      expect(
        (
          after.body.domains as {
            domainType: string;
            selectedTool: string | null;
          }[]
        ).find((d) => d.domainType === "MONITORING")?.selectedTool,
      ).toBe("fake-metrics-b");
    });

    it("AC-6: nâng cấp — production đòi gõ tên domain (428); đúng ⇒ job, adapter_version mới; lần hai ⇒ 409", async () => {
      const w = applyWorld();
      const { projectId } = await activeProject(w.registry);
      const { http } = appFor(w.registry, null);
      await admin.domainConfig.updateMany({
        where: { projectId, domainType: "MONITORING" },
        data: { adapterVersion: "0.9.0" },
      });
      const upgradeUrl = `${domainsUrl(projectId)}/MONITORING/upgrade`;

      await as(owner, request(http).post(upgradeUrl).send({})).expect(428);
      const res = await as(
        owner,
        request(http).post(upgradeUrl).send({ confirm: "MONITORING" }),
      ).expect(202);
      await workerWith(w.registry, fakeClusters()).run(
        res.body.job.id as string,
        {
          final: false,
        },
      );
      const row = await admin.domainConfig.findFirstOrThrow({
        where: { projectId, domainType: "MONITORING" },
        select: { adapterVersion: true },
      });
      expect(row.adapterVersion).toBe("1.0.0");
      const again = await as(
        owner,
        request(http).post(upgradeUrl).send({ confirm: "MONITORING" }),
      ).expect(409);
      expect(again.body.type).toContain("domain-up-to-date");
    });

    it("AC-5: quét ngay ⇒ phán quyết mới trả về liền; triển khai không có worker ⇒ 503", async () => {
      const w = applyWorld();
      const { projectId } = await activeProject(w.registry);
      const kit = createJobKit(depsWith(w.registry, fakeClusters()));
      const { http } = appFor(w.registry, async (pid, type) => {
        await sweepDrift(kit, { only: [pid], domainType: type });
      });
      w.metrics.drifted = true;

      const res = await as(
        owner,
        request(http).post(`${domainsUrl(projectId)}/MONITORING/drift`),
      ).expect(200);
      expect(res.body.drift.verdict).toBe("DRIFTED");
      expect(w.delivery.driftChecks).toEqual([]);

      const bare = appFor(w.registry, null).http;
      await as(
        owner,
        request(bare).post(`${domainsUrl(projectId)}/MONITORING/drift`),
      ).expect(503);
    });

    it("[Plan #45] retry: production đòi gõ tên (428); đúng ⇒ 202 job reapply; job sống ⇒ 409; bản lệch hay PENDING ⇒ 409", async () => {
      const w = applyWorld();
      const { projectId } = await activeProject(w.registry);
      const { http, enqueued } = appFor(w.registry, null);
      const retryUrl = `${domainsUrl(projectId)}/MONITORING/retry`;

      await as(owner, request(http).post(retryUrl).send({})).expect(428);
      const res = await as(
        owner,
        request(http).post(retryUrl).send({ confirm: "MONITORING" }),
      ).expect(202);
      expect(res.body.job).toMatchObject({
        jobType: "DOMAIN_APPLY",
        state: "QUEUED",
      });
      expect(enqueued).toEqual([res.body.job.id]);
      const payload = await admin.provisioningJob.findUniqueOrThrow({
        where: { id: res.body.job.id as string },
        select: { payload: true },
      });
      expect(payload.payload).toMatchObject({
        change: { kind: "reapply", domainType: "MONITORING" },
      });
      await as(
        owner,
        request(http).post(retryUrl).send({ confirm: "MONITORING" }),
      ).expect(409);
      await workerWith(w.registry, fakeClusters()).run(
        res.body.job.id as string,
        { final: false },
      );

      await admin.domainConfig.updateMany({
        where: { projectId, domainType: "MONITORING" },
        data: { adapterVersion: "0.9.0" },
      });
      const stale = await as(
        owner,
        request(http).post(retryUrl).send({ confirm: "MONITORING" }),
      ).expect(409);
      expect(stale.body.type).toContain("domain-not-retryable");

      await admin.domainConfig.updateMany({
        where: { projectId, domainType: "MONITORING" },
        data: { adapterVersion: "1.0.0", domainStatus: "PENDING" },
      });
      const pending = await as(
        owner,
        request(http).post(retryUrl).send({ confirm: "MONITORING" }),
      ).expect(409);
      expect(pending.body.type).toContain("domain-not-retryable");
    });

    it("[Plan #45] versions: bản cũ ⇒ một bản nâng được kèm validator; toVersion lạ ⇒ 409; đã mới nhất ⇒ rỗng", async () => {
      const w = applyWorld();
      const { projectId } = await activeProject(w.registry);
      const { http } = appFor(w.registry, null);
      await admin.domainConfig.updateMany({
        where: { projectId, domainType: "MONITORING" },
        data: { adapterVersion: "0.9.0" },
      });
      const versionsUrl = `${domainsUrl(projectId)}/MONITORING/versions`;

      const res = await as(owner, request(http).get(versionsUrl)).expect(200);
      expect(res.body.versions).toMatchObject({
        domainType: "MONITORING",
        toolId: "fake-metrics",
        current: "0.9.0",
        available: [
          {
            version: "1.0.0",
            provides: [{ id: "metrics.query", version: "2.0.0" }],
            changes: [],
            validation: { valid: true },
          },
        ],
      });

      const upgradeUrl = `${domainsUrl(projectId)}/MONITORING/upgrade`;
      const wrong = await as(
        owner,
        request(http)
          .post(upgradeUrl)
          .send({ confirm: "MONITORING", toVersion: "2.0.0" }),
      ).expect(409);
      expect(wrong.body.type).toContain("domain-version-unavailable");

      await admin.domainConfig.updateMany({
        where: { projectId, domainType: "MONITORING" },
        data: { adapterVersion: "1.0.0" },
      });
      const fresh = await as(owner, request(http).get(versionsUrl)).expect(200);
      expect(fresh.body.versions.available).toEqual([]);
    });

    it("[Plan #45] chi tiết project mang địa chỉ cluster sau PROVISION — không caData", async () => {
      const w = applyWorld();
      const { projectId } = await activeProject(w.registry);
      const { http } = appFor(w.registry, null);
      const res = await as(
        owner,
        request(http).get(`${API}/projects/${projectId}`),
      ).expect(200);
      expect(res.body.cluster).toMatchObject({
        provider: "AWS",
        region: REGION,
      });
      expect(typeof res.body.cluster.clusterId).toBe("string");
      expect(typeof res.body.cluster.apiEndpoint).toBe("string");
      expect(JSON.stringify(res.body)).not.toContain("caData");
    });
  },
);

describe(
  "bí mật của tool đi hết vòng đời (Plan #31 P1: AC-1, AC-2)",
  { timeout: 180_000 },
  () => {
    const SENTINEL = "canhBiMatP31Vong1f0e9d8c7b6a";
    const SENTINEL_2 = "canhBiMatP31Vong2a1b2c3d4e5f";

    /** Adapter giả có trường bí mật, ghi lại bản RÕ mà nó nhận ở mỗi lời gọi */
    function secretWorld() {
      const w = applyWorld();
      const seen: string[] = [];
      const base = fakeDomain({
        domainType: "COST",
        toolId: "fake-cost",
        scope: "cluster",
      }).adapter;
      const secretive: DomainAdapter = {
        ...base,
        configSchema: z
          .object({ apiKey: z.string().min(8).describe("secret") })
          .strict(),
        deploy: (ctx, config) => {
          seen.push(`deploy:${String(config.apiKey)}`);
          return base.deploy(ctx, config);
        },
        configure: (ctx, config) => {
          seen.push(`configure:${String(config.apiKey)}`);
          return base.configure(ctx, config);
        },
      };
      const registry: DomainAdapterRegistry = {
        get: (domainType, toolId) =>
          domainType === "COST" && toolId === "fake-cost"
            ? secretive
            : w.registry.get(domainType, toolId),
        all: () => [],
      };
      return { registry, seen };
    }

    const nowhere = async (projectId: string, needle: string) => {
      const [configs, jobs, audits] = await Promise.all([
        admin.domainConfig.findMany({
          where: { projectId },
          select: { toolConfig: true },
        }),
        admin.provisioningJob.findMany({
          where: { projectId },
          select: { payload: true, lastError: true },
        }),
        admin.auditLog.findMany({
          where: { projectId },
          select: { before: true, after: true },
        }),
      ]);
      return !JSON.stringify([configs, jobs, audits]).includes(needle);
    };

    it("niêm phong khi lưu, che trên dây, giữ chỗ giữ bản cũ, adapter nhận bản rõ — cả nháp lẫn đang chạy", async () => {
      const { registry, seen } = secretWorld();
      const projectId = await readyProject();
      const { http } = appFor(registry, null);
      const url = `${API}/projects/${projectId}/domains`;
      const domainsWithCost = (apiKey: unknown) => [
        { domainType: "MONITORING", toolId: "fake-metrics", config: {} },
        {
          domainType: "PROGRESSIVE_DELIVERY",
          toolId: "fake-rollouts",
          config: {},
        },
        { domainType: "COST", toolId: "fake-cost", config: { apiKey } },
      ];
      const version = async () =>
        (await as(owner, request(http).get(url)).expect(200)).body
          .domainSetVersion as number;

      // Nháp: lưu thẳng — bảng giữ bản niêm phong, dây chỉ thấy giữ chỗ
      const saved = await as(
        owner,
        request(http)
          .put(url)
          .send({
            domains: domainsWithCost(SENTINEL),
            preferences: [],
            lastKnownDomainSetVersion: await version(),
          }),
      ).expect(200);
      expect(JSON.stringify(saved.body)).not.toContain(SENTINEL);
      expect(
        (
          saved.body.domains as { domainType: string; toolConfig: unknown }[]
        ).find((d) => d.domainType === "COST")?.toolConfig,
      ).toEqual({ apiKey: { $udpSecret: "kept" } });
      expect(await nowhere(projectId, SENTINEL)).toBe(true);

      // Gửi lại giữ chỗ ⇒ vẫn đúng bí mật cũ
      await as(
        owner,
        request(http)
          .put(url)
          .send({
            domains: domainsWithCost({ $udpSecret: "kept" }),
            preferences: [],
            lastKnownDomainSetVersion: await version(),
          }),
      ).expect(200);

      const jobId = await seedJob(projectId);
      await workerWith(registry, fakeClusters()).run(jobId, { final: false });
      expect((await snapshot(projectId, jobId)).job.state).toBe("DONE");
      expect(seen).toContain(`deploy:${SENTINEL}`);

      // Đang chạy: đổi bí mật ⇒ job, payload niêm phong, adapter cấu hình lại bằng bản rõ mới
      const applied = await as(
        owner,
        request(http)
          .put(url)
          .send({
            domains: domainsWithCost(SENTINEL_2),
            preferences: [],
            lastKnownDomainSetVersion: await version(),
          }),
      ).expect(202);
      expect(await nowhere(projectId, SENTINEL_2)).toBe(true);
      await workerWith(registry, fakeClusters()).run(
        applied.body.job.id as string,
        { final: false },
      );
      expect(seen).toContain(`configure:${SENTINEL_2}`);
      expect(await nowhere(projectId, SENTINEL_2)).toBe(true);
      expect(await nowhere(projectId, SENTINEL)).toBe(true);
    });
  },
);

describe(
  "khoá kéo image vào udp-registry-pull của mọi environment (Plan #35 P2)",
  { timeout: 180_000 },
  () => {
    const SENTINEL = "canhKhoaKeoP35abcdef0123";
    const pullRef = (namespace: string) => ({
      apiVersion: "v1",
      kind: "Secret",
      namespace,
      name: "udp-registry-pull",
    });

    /** Registry giả có `pullCredential`, và MỘT cluster ghi nhớ để đọc lại Secret */
    function registryWorld() {
      const w = applyWorld();
      const registryTool = fakeDomain({
        domainType: "CONTAINER_REGISTRY",
        toolId: "fake-registry",
        scope: "cluster",
        provides: [
          {
            id: "registry.oci",
            version: "1.0.0",
            providedBy: "container_registry:fake-registry",
            endpoint: "ghcr.io/acme",
          },
        ],
      });
      const registry: DomainAdapterRegistry = {
        get: (domainType, toolId) =>
          domainType === "CONTAINER_REGISTRY" && toolId === "fake-registry"
            ? registryTool.adapter
            : w.registry.get(domainType, toolId),
        all: () => [
          {
            key: "container_registry:fake-registry",
            adapter: registryTool.adapter,
            at: "test",
            pullCredential: () => ({
              server: "ghcr.io",
              username: "acme",
              password: SENTINEL,
            }),
          },
        ],
      };
      const cluster = createFakeClusterAccess({ clusterId: "c-pull" });
      const base = fakeClusters();
      const clusters: FakeClusters = {
        ...base,
        runtime: { ...base.runtime, accessFor: () => cluster },
      };
      return { registry, cluster, clusters };
    }

    it("bật registry ⇒ khoá gộp vào MỌI env; sửa tay ⇒ drift; tắt ⇒ về rỗng", async () => {
      const { registry, cluster, clusters } = registryWorld();
      const { projectId, provisioned } = await activeProject(registry);
      const namespaces = (
        await admin.environment.findMany({
          where: { projectId },
          select: { k8sNamespace: true },
        })
      ).map((e) => e.k8sNamespace);
      const client = await cluster.getClient("tooling");
      const dockerConfigIn = async (namespace: string) =>
        (
          await client.read<{ stringData?: Record<string, string> }>(
            "get",
            pullRef(namespace),
          )
        )?.stringData?.[".dockerconfigjson"];
      const running = [
        { domainType: "MONITORING", toolId: "fake-metrics" },
        { domainType: "PROGRESSIVE_DELIVERY", toolId: "fake-rollouts" },
      ];

      const enable = await seedApply(projectId, provisioned, [
        ...running,
        { domainType: "CONTAINER_REGISTRY", toolId: "fake-registry" },
      ]);
      await workerWith(registry, clusters).run(enable, { final: false });
      expect((await snapshot(projectId, enable)).job.state).toBe("DONE");
      for (const namespace of namespaces) {
        const config = JSON.parse(
          (await dockerConfigIn(namespace)) ?? "{}",
        ) as {
          auths: Record<string, { username: string; password: string }>;
        };
        expect(config.auths["ghcr.io"]).toMatchObject({
          username: "acme",
          password: SENTINEL,
        });
      }
      // Khoá chỉ ở Secret của cluster: không bảng, payload job hay audit nào mang nó
      const rows = await admin.provisioningJob.findMany({
        where: { projectId },
        select: { payload: true, lastError: true },
      });
      expect(JSON.stringify(rows)).not.toContain(SENTINEL);

      // Sửa tay một env ⇒ lượt quét drift gắn trôi vào domain registry
      const first = namespaces[0] ?? "";
      await client.write("patch", pullRef(first), {
        stringData: { ".dockerconfigjson": '{"auths":{}}' },
      });
      await sweepDrift(createJobKit(depsWith(registry, clusters)), {
        only: [projectId],
      });
      const drifted = await admin.domainConfig.findFirstOrThrow({
        where: { projectId, domainType: "CONTAINER_REGISTRY" },
        select: { lastError: true },
      });
      expect(drifted.lastError).toMatchObject({ adapterResult: "DRIFTED" });
      expect(JSON.stringify(drifted.lastError)).toContain(first);
      expect(JSON.stringify(drifted.lastError)).not.toContain(SENTINEL);

      // Tắt registry ⇒ khoá của tool đã tắt không sống tiếp trong cluster
      const disable = await seedApply(projectId, provisioned, running);
      await workerWith(registry, clusters).run(disable, { final: false });
      expect((await snapshot(projectId, disable)).job.state).toBe("DONE");
      for (const namespace of namespaces) {
        expect(await dockerConfigIn(namespace)).toBe('{"auths":{}}');
      }
    });
  },
);

describe(
  "HTTP environment cho project đang chạy (Plan #40)",
  { timeout: 120_000 },
  () => {
    const envUrl = (projectId: string, suffix = "") =>
      `${API}/projects/${projectId}/environments${suffix}`;
    /** S2 không chạy trong tệp này: backfill giả thành công (S2 có test riêng) */
    const backfilled = {
      ...createFlagServiceClient({
        baseUrl: "http://127.0.0.1:9",
        secret: env.INTERNAL_SERVICE_SECRET,
      }),
      backfillEnvironment: () => Promise.resolve(0),
    };

    it("POST ⇒ 201 kèm job ENVIRONMENT_APPLY ADD đã gửi hàng đợi; job khác đang chạy ⇒ 409 environment-project-busy", async () => {
      const w = domainsWith();
      const { projectId } = await activeProject(w.registry);
      const { http, enqueued } = appFor(w.registry, null, backfilled);

      const res = await as(
        owner,
        request(http).post(envUrl(projectId)).send({ name: "qa" }),
      ).expect(201);
      // Không có nhánh hủy hợp tác như PROVISION ⇒ không hiện là hủy được, và route hủy từ chối
      expect(res.body.job).toMatchObject({
        jobType: "ENVIRONMENT_APPLY",
        state: "QUEUED",
        cancellable: false,
      });
      expect(enqueued).toEqual([res.body.job.id]);
      const cancel = await as(
        owner,
        request(http).post(
          `${API}/projects/${projectId}/jobs/${res.body.job.id as string}/cancel`,
        ),
      ).expect(409);
      expect(cancel.body.type).toContain(PROVISION_ERROR_SLUGS.notCancellable);

      const busy = await as(
        owner,
        request(http).post(envUrl(projectId)).send({ name: "uat" }),
      ).expect(409);
      expect(busy.body.type).toContain(ENVIRONMENT_ERROR_SLUGS.projectBusy);
      expect(
        await admin.environment.count({ where: { projectId, name: "uat" } }),
      ).toBe(0);
    });

    it("DELETE environment sạch ⇒ 202; hàng environment xoá NGAY, job REMOVE mang bản chụp namespace", async () => {
      const w = domainsWith();
      const { projectId } = await activeProject(w.registry);
      const qa = await addEnvironmentRow(projectId, "qa");
      const { http, enqueued } = appFor(w.registry, null, backfilled);

      const res = await as(
        owner,
        request(http).delete(envUrl(projectId, `/${qa.id}`)),
      ).expect(202);
      expect(res.body.job).toMatchObject({ jobType: "ENVIRONMENT_APPLY" });
      expect(enqueued).toEqual([res.body.job.id]);
      expect(await admin.environment.count({ where: { id: qa.id } })).toBe(0);
      const job = await admin.provisioningJob.findUniqueOrThrow({
        where: { id: res.body.job.id as string },
        select: { payload: true },
      });
      expect((job.payload as { change: unknown }).change).toEqual({
        action: "REMOVE",
        environment: qa,
      });
    });

    it("retry: ENVIRONMENT_APPLY FAILED ⇒ 202 job mới cùng thay đổi; loại job khác ⇒ 409 job-not-retryable", async () => {
      const w = domainsWith();
      const { projectId, provisioned } = await activeProject(w.registry);
      const qa = await addEnvironmentRow(projectId, "qa");
      const failed = await seedEnvironmentJob(
        projectId,
        provisioned,
        "ADD",
        qa,
      );
      await admin.provisioningJob.update({
        where: { id: failed },
        data: { state: "FAILED" },
      });
      const { http, enqueued } = appFor(w.registry, null);
      const retryUrl = (jobId: string) =>
        `${API}/projects/${projectId}/jobs/${jobId}/retry`;

      const res = await as(owner, request(http).post(retryUrl(failed))).expect(
        202,
      );
      expect(res.body.job).toMatchObject({
        jobType: "ENVIRONMENT_APPLY",
        state: "QUEUED",
      });
      expect(res.body.job.id).not.toBe(failed);
      expect(enqueued).toEqual([res.body.job.id]);

      const other = await as(
        owner,
        request(http).post(retryUrl(provisioned)),
      ).expect(409);
      expect(other.body.type).toContain(PROVISION_ERROR_SLUGS.notRetryable);
    });
  },
);

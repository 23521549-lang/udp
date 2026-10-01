import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { env } from "@udp/config";
import { createPrismaClient, Prisma } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import { DOMAIN_ERROR_SLUGS } from "@udp/shared-types/domain-api";
import {
  adminOverviewResponseWire,
  adminPlatformResponseWire,
  architectureResponseWire,
  homeResponseWire,
  redMetricsResponseWire,
} from "@udp/shared-types/wire";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import {
  outsideClusterProbe,
  type PlatformProbe,
} from "../src/core/platform-probe.js";
import { createRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type ProjectEnv,
  type TestWorld,
} from "./helpers/api.js";
import {
  inertCloudPlatform,
  inertProvisioning,
  noRepoSource,
  noExternalAuth,
} from "./helpers/inert-deps.js";

/**
 * Plan #53 (AC-1, AC-2, AC-3, AC-4): sơ đồ kiến trúc, giám sát RED, trang chủ, Bảng điều khiển nền
 * tảng — qua HTTP thật, database thật, registry THẬT (cạnh của sơ đồ đến từ capability thật của 72
 * tool). Tệp này cũng là nơi sinh mẫu golden của năm route mới.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_dashboards_test",
});
const registry = createRegistry({
  root: resolve(import.meta.dirname, "../src/modules"),
});

const HOUR = 3_600_000;
const NOW = Date.now();

/** Cụm của một máy ảo A1 Always Free — tín hiệu mà Bảng điều khiển đọc qua RBAC chỉ-đọc */
const vmProbe: PlatformProbe = {
  read: () =>
    Promise.resolve({
      node: {
        state: "ok",
        name: "udp-vm",
        cpuCores: 2,
        cpuUsedCores: 0.46,
        memoryBytes: 12 * 1024 ** 3,
        memoryUsedBytes: 4_931_584_000,
      },
      postgresVolume: { state: "ok", capacityBytes: 20 * 1024 ** 3 },
      backup: {
        state: "ok",
        schedule: "30 19 * * *",
        lastScheduleAt: new Date(NOW - 5 * HOUR).toISOString(),
        lastSuccessAt: new Date(NOW - 5 * HOUR).toISOString(),
        lastFailureAt: null,
      },
      certificate: {
        state: "ok",
        name: "udp-tls",
        ready: true,
        notAfter: new Date(NOW + 54 * 24 * HOUR).toISOString(),
        issuer: "udp-letsencrypt",
      },
    }),
};

let platformProbe: PlatformProbe = vmProbe;
const metrics = new FakeMetricsProvider();
const app = createApp({
  metricsFor: () => metrics,
  flagService: createFlagServiceClient({
    baseUrl: "http://127.0.0.1:9",
    secret: env.INTERNAL_SERVICE_SECRET,
  }),
  oidcIssuer: null,
  cloud: inertCloudPlatform,
  repoSource: noRepoSource,
  platform: () => Promise.resolve(platformProbe),
  auth: noExternalAuth,
  domainRegistry: () => registry,
  provisioning: inertProvisioning,
});

let world: TestWorld;
let owner: Actor;
let viewer: Actor;
let outsider: Actor;
let platformAdmin: Actor;
let projectId: string;
let envs: Record<string, ProjectEnv>;
const created: string[] = [];

async function domain(
  domainType: string,
  selectedTool: string,
  domainStatus: "ACTIVE" | "ERROR",
  toolConfig: Record<string, unknown>,
  lastError?: Record<string, unknown>,
): Promise<string> {
  const row = await admin.domainConfig.create({
    data: {
      projectId,
      domainType: domainType as never,
      isEnabled: true,
      selectedTool,
      toolConfig: toolConfig as Prisma.InputJsonValue,
      domainStatus,
      adapterVersion: "1.0.0",
      ...(lastError === undefined
        ? {}
        : { lastError: lastError as Prisma.InputJsonValue }),
    },
    select: { id: true },
  });
  return row.id;
}

async function deployEvent(
  environment: ProjectEnv,
  eventType: "DEPLOY_PENDING" | "DEPLOY_SUCCESS" | "DEPLOY_FAILURE",
  workloadName: string,
  hoursAgo: number,
  deploymentId: string = randomUUID(),
): Promise<string> {
  await admin.deploymentEvent.create({
    data: {
      projectId,
      environmentId: environment.id,
      deploymentId,
      eventType,
      workloadName,
      imageTag: `v1.${String(Math.round(hoursAgo))}.0`,
      commitSha: randomUUID().replaceAll("-", "").slice(0, 40),
      triggeredBy: "WEBHOOK",
      occurredAt: new Date(NOW - hoursAgo * HOUR),
    },
  });
  return deploymentId;
}

beforeAll(async () => {
  world = testWorld(app, admin);
  owner = await world.newActor("dash");
  viewer = await world.newActor("dash-viewer");
  outsider = await world.newActor("dash-outsider");
  platformAdmin = await world.newActor("dash-admin");
  await admin.user.update({
    where: { id: platformAdmin.userId },
    data: { platformRole: "PLATFORM_ADMIN" },
  });
  ({ projectId, envs } = await world.newProject(owner));
  created.push(projectId);
  await world.addMember(owner, projectId, viewer, "VIEWER");
  const dev = envs.dev as ProjectEnv;
  const prod = envs.prod as ProjectEnv;

  await admin.project.update({
    where: { id: projectId },
    data: {
      status: "ACTIVE",
      expiresAt: new Date(NOW + 10 * HOUR),
      clusterAccess: {
        clusterId: "udp-dash",
        apiEndpoint: "https://ABCD.gr7.ap-southeast-1.eks.amazonaws.com",
      },
    },
  });
  await admin.cloudCredential.create({
    data: {
      projectId,
      provider: "AWS",
      mode: "BYOC",
      region: "ap-southeast-1",
      authKind: "AWS_ROLE",
      encryptedPayload: "khong-giai-duoc",
      encryptedDek: "khong-giai-duoc",
      nonce: "0".repeat(24),
      authTag: "0".repeat(24),
      fingerprint: "f".repeat(64),
      isActive: true,
      lastValidatedAt: new Date(NOW - 2 * HOUR),
      createdById: owner.userId,
    },
  });

  // Hạ tầng đã dựng: một lượt PROVISION xong, rồi một lượt áp domain HỎNG gần hơn
  const done = await admin.provisioningJob.create({
    data: { projectId, jobType: "PROVISION", state: "DONE", payload: {} },
    select: { id: true },
  });
  const resources: [string, string, string, string][] = [
    ["NETWORK", "vpc", "vpc", "READY"],
    ["NETWORK", "subnet", "private-a", "READY"],
    ["NETWORK", "nat-gateway", "nat", "READY"],
    ["CLUSTER", "cluster", "udp-dash", "READY"],
    ["CLUSTER", "nodegroup", "default", "READY"],
    ["NETWORK", "elastic-ip", "cu", "DELETED"],
  ];
  for (const [step, kind, name, status] of resources) {
    await admin.provisionedResource.create({
      data: {
        jobId: done.id,
        projectId,
        step: step as never,
        kind,
        idempotencyKey: `${projectId}:${step}:${kind}:${name}`,
        provider: "AWS",
        region: "ap-southeast-1",
        status: status as never,
      },
    });
  }
  await admin.provisioningJob.create({
    data: {
      projectId,
      jobType: "DOMAIN_APPLY",
      state: "FAILED",
      payload: {},
      lastError: { step: "DOMAINS", message: "loki: PVC chưa gắn được" },
    },
  });

  // Domain đang bật: Monitoring cần registry.oci ⇒ cạnh Monitoring → Container Registry
  await domain("CONTAINER_REGISTRY", "ghcr", "ACTIVE", {
    owner: "udp-demo",
  });
  const monitoring = await domain(
    "MONITORING",
    "prometheus-grafana",
    "ACTIVE",
    { retentionDays: 15, dashboards: true, storageGb: 20 },
    {
      step: "DRIFT_SCAN",
      message: "values đã bị sửa tay trên cluster",
      adapterResult: "DRIFTED",
      at: new Date(NOW - 3 * HOUR).toISOString(),
    },
  );
  await domain("LOGGING", "loki", "ERROR", { retentionHours: 72 });
  await admin.capabilityBinding.create({
    data: {
      domainConfigId: monitoring,
      capabilityId: "metrics.query",
      providedBy: "monitoring:prometheus-grafana",
      schemaVersion: "2.0.0",
      endpoint: "http://udp-prometheus-prometheus.udp-system:9090",
    },
  });

  // Workload: hai lần deploy của checkout-api ở dev (bản mới hơn thắng), một deploy chờ duyệt ở prod
  const first = await deployEvent(dev, "DEPLOY_SUCCESS", "checkout-api", 30);
  await deployEvent(dev, "DEPLOY_SUCCESS", "checkout-api", 2);
  await deployEvent(dev, "DEPLOY_FAILURE", "checkout-worker", 5);
  await deployEvent(prod, "DEPLOY_SUCCESS", "checkout-api", 26, first);
  await deployEvent(prod, "DEPLOY_PENDING", "checkout-api", 1);

  await admin.rolloutSession.create({
    data: {
      projectId,
      environmentId: prod.id,
      workloadName: "checkout-api",
      rolloutScope: "SERVICE_LEVEL",
      strategy: "CANARY",
      controlMode: "UDP_DRIVEN",
      status: "PAUSED",
      currentTrafficPercentage: 20,
      thresholds: { errorRate: 0.05 },
      stepPercent: 10,
      createdById: owner.userId,
    },
  });
});

afterAll(async () => {
  await admin.deploymentEvent.deleteMany({
    where: { projectId: { in: created } },
  });
  await admin.provisionedResource.deleteMany({
    where: { projectId: { in: created } },
  });
  await world.cleanup();
  await admin.$disconnect();
});

describe("sơ đồ kiến trúc (AC-1)", () => {
  const url = () => `${API}/projects/${projectId}/architecture`;

  it("người ngoài 404, VIEWER đọc được", async () => {
    await request(app).get(url()).expect(401);
    await as(outsider, request(app).get(url())).expect(404);
    await as(viewer, request(app).get(url())).expect(200);
  });

  it("ghép cloud, cluster, tài nguyên còn sống, workload gần nhất, công cụ và cạnh của resolver", async () => {
    const res = await as(owner, request(app).get(url())).expect(200);
    const a = architectureResponseWire.parse(res.body).architecture;
    expect(a.cloud).toMatchObject({
      provider: "AWS",
      region: "ap-southeast-1",
      mode: "BYOC",
    });
    expect(a.cluster?.clusterId).toBe("udp-dash");
    // Tài nguyên DELETED không lên sơ đồ
    expect(a.resources.map((r) => r.name).sort()).toEqual(
      ["default", "nat", "private-a", "udp-dash", "vpc"].sort(),
    );
    const dev = a.environments.find((e) => e.name === "dev");
    expect(dev?.workloads.map((w) => [w.name, w.lastEvent])).toEqual([
      ["checkout-api", "DEPLOY_SUCCESS"],
      ["checkout-worker", "DEPLOY_FAILURE"],
    ]);
    // Bản gần nhất (2 giờ trước) thắng bản 30 giờ trước
    expect(dev?.workloads[0]?.imageTag).toBe("v1.2.0");

    const tool = (key: string) => a.tools.find((t) => t.key === key);
    expect(tool("monitoring:prometheus-grafana")?.drift.verdict).toBe(
      "DRIFTED",
    );
    expect(tool("logging:loki")?.status).toBe("ERROR");
    expect(a.edges).toContainEqual({
      from: "monitoring:prometheus-grafana",
      to: "container_registry:ghcr",
      capabilityId: "registry.oci",
    });
    // Provider deploy ở bậc trước người tiêu thụ
    expect(tool("container_registry:ghcr")?.tier ?? -1).toBeLessThan(
      tool("monitoring:prometheus-grafana")?.tier ?? -1,
    );

    // [Plan #57] Deploy 14 ngày UTC trên MỌI env: cùng deploymentId ở dev và prod là hai lần deploy
    expect(a.deploys).toHaveLength(14);
    expect(a.deploys.at(-1)?.date).toBe(
      new Date(NOW).toISOString().slice(0, 10),
    );
    const sum = (k: "success" | "failure") =>
      a.deploys.reduce((n, d) => n + d[k], 0);
    expect([sum("success"), sum("failure")]).toEqual([3, 1]);
  });
});

describe("giám sát RED (AC-2)", () => {
  const url = (envId: string, range = "6h") =>
    `${API}/projects/${projectId}/metrics/red?envId=${envId}&range=${range}`;

  it("chuỗi theo lưới cho mỗi workload của env; đường mở Grafana là lệnh port-forward", async () => {
    const dev = envs.dev as ProjectEnv;
    const res = await as(viewer, request(app).get(url(dev.id))).expect(200);
    const m = redMetricsResponseWire.parse(res.body).metrics;
    expect(m.stepSeconds).toBe(300);
    expect(m.workloads.map((w) => w.workload)).toEqual([
      "checkout-api",
      "checkout-worker",
    ]);
    for (const w of m.workloads) {
      expect(w.requestRate).toHaveLength(m.points);
      expect(w.errorRatio).toHaveLength(m.points);
      expect(w.latencyP99Ms).toHaveLength(m.points);
    }
    expect(m.source.tool).toBe("monitoring:prometheus-grafana");
    expect(m.console).toEqual({
      kind: "portForward",
      app: "grafana",
      command:
        "kubectl -n udp-system port-forward svc/udp-prometheus-grafana 3000:80",
      localUrl: "http://localhost:3000",
    });
  });

  it("project chưa có nguồn metrics.query ⇒ 409 metricsNotEnabled; env của project khác ⇒ 404", async () => {
    const other = await world.newProject(owner);
    created.push(other.projectId);
    const res = await as(
      owner,
      request(app).get(
        `${API}/projects/${other.projectId}/metrics/red?envId=${(other.envs.dev as ProjectEnv).id}`,
      ),
    ).expect(409);
    expect(res.body.type).toContain(DOMAIN_ERROR_SLUGS.metricsNotEnabled);
    await as(
      owner,
      request(app).get(url((other.envs.dev as ProjectEnv).id)),
    ).expect(404);
  });

  it("nguồn hỏng ⇒ 503, không một chuỗi toàn 0", async () => {
    metrics.setQueryFailing(true);
    try {
      await as(
        owner,
        request(app).get(url((envs.dev as ProjectEnv).id)),
      ).expect(503);
    } finally {
      metrics.setQueryFailing(false);
    }
  });
});

describe("trang chủ (AC-3)", () => {
  it("chỉ project của mình; đủ các loại việc cần xử lý; deploy 14 ngày đủ ngày", async () => {
    const res = await as(owner, request(app).get(`${API}/home`)).expect(200);
    const home = homeResponseWire.parse(res.body).home;
    const mine = home.projects.find((p) => p.id === projectId);
    expect(mine).toMatchObject({
      status: "ACTIVE",
      myRole: "OWNER",
      cloudProvider: "AWS",
    });
    const kinds = new Set(
      home.attention
        .filter((a) => a.projectId === projectId)
        .map((a) => a.kind),
    );
    expect([...kinds].sort()).toEqual(
      [
        "DEPLOY_PENDING",
        "DOMAIN_DRIFTED",
        "DOMAIN_ERROR",
        "JOB_FAILED",
        "PROJECT_EXPIRING",
        "ROLLOUT_PAUSED",
      ].sort(),
    );
    expect(home.rollouts.some((r) => r.subject === "checkout-api")).toBe(true);
    expect(home.deploys).toHaveLength(14);
    expect(home.deploys.reduce((s, d) => s + d.success + d.failure, 0)).toBe(4);
  });

  it("người ngoài không thấy gì của project này — kể cả khi là PLATFORM_ADMIN", async () => {
    for (const actor of [outsider, platformAdmin]) {
      const res = await as(actor, request(app).get(`${API}/home`)).expect(200);
      const home = homeResponseWire.parse(res.body).home;
      expect(home.projects.some((p) => p.id === projectId)).toBe(false);
      expect(home.attention.some((a) => a.projectId === projectId)).toBe(false);
    }
    await request(app).get(`${API}/home`).expect(401);
  });
});

describe("Bảng điều khiển nền tảng (AC-4)", () => {
  it("USER 403, chưa đăng nhập 401", async () => {
    for (const path of ["/admin/overview", "/admin/platform"]) {
      await request(app).get(`${API}${path}`).expect(401);
      await as(owner, request(app).get(`${API}${path}`)).expect(403);
    }
  });

  it("overview đếm từ database; platform đọc tín hiệu của cụm qua probe", async () => {
    const res = await as(
      platformAdmin,
      request(app).get(`${API}/admin/overview`),
    ).expect(200);
    const o = adminOverviewResponseWire.parse(res.body).overview;
    expect(o.users.admins).toBeGreaterThanOrEqual(1);
    expect(o.projects.byStatus.ACTIVE).toBeGreaterThanOrEqual(1);
    expect(o.jobs.failed).toBeGreaterThanOrEqual(1);
    expect(o.tools.some((t) => t.toolId === "prometheus-grafana")).toBe(true);

    const p = await as(
      platformAdmin,
      request(app).get(`${API}/admin/platform`),
    ).expect(200);
    expect(adminPlatformResponseWire.parse(p.body).platform.node).toMatchObject(
      { state: "ok", cpuCores: 2 },
    );
  });

  it("ngoài cụm: mọi tín hiệu nói NOT_IN_CLUSTER, không đoán", async () => {
    platformProbe = outsideClusterProbe;
    try {
      const p = await as(
        platformAdmin,
        request(app).get(`${API}/admin/platform`),
      ).expect(200);
      const platform = adminPlatformResponseWire.parse(p.body).platform;
      for (const signal of [
        platform.node,
        platform.postgresVolume,
        platform.backup,
        platform.certificate,
      ]) {
        expect(signal).toEqual({
          state: "unavailable",
          reason: "NOT_IN_CLUSTER",
        });
      }
    } finally {
      platformProbe = vmProbe;
    }
  });

  it("danh sách admin theo trang: offset + total, không cắt im lặng ở 100", async () => {
    const page = await as(
      platformAdmin,
      request(app).get(`${API}/admin/users?limit=1&offset=0`),
    ).expect(200);
    expect(page.body.users).toHaveLength(1);
    expect(page.body.total).toBeGreaterThanOrEqual(4);
    const next = await as(
      platformAdmin,
      request(app).get(`${API}/admin/users?limit=1&offset=1`),
    ).expect(200);
    expect(next.body.users[0].id).not.toBe(page.body.users[0].id);
    const jobs = await as(
      platformAdmin,
      request(app).get(`${API}/admin/jobs?state=FAILED&limit=1`),
    ).expect(200);
    expect(jobs.body.total).toBeGreaterThanOrEqual(1);
  });
});

describe("nhật ký theo trang", () => {
  it("offset + total trên CÙNG bộ lọc", async () => {
    const res = await as(
      owner,
      request(app).get(`${API}/projects/${projectId}/audit?limit=1`),
    ).expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
  });
});

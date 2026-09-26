import { resolve } from "node:path";
import type { ClusterAccess } from "@udp/adapter-core";
import { env } from "@udp/config";
import { createPrismaClient, Prisma } from "@udp/db";
import { ServiceUnavailableError } from "@udp/http";
import {
  DatadogMetricsProvider,
  PrometheusMetricsProvider,
  type MetricsSource,
} from "@udp/metrics-provider";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import {
  internalMetricsProbeResponseWire,
  internalMetricsSampleResponseWire,
} from "@udp/shared-types/wire";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { createMetricsFor } from "../src/core/metrics-source.js";
import { createClusterAccessCache } from "../src/modules/cluster/cluster-access-cache.js";
import { createRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import { sealSecrets } from "../src/modules/domain/tool-secrets.js";
import { datadogConfigSchema } from "../src/modules/monitoring-adapter/datadog/index.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type ProjectEnv,
  type TestWorld,
} from "./helpers/api.js";
import { inertCloudPlatform, inertProvisioning } from "./helpers/inert-deps.js";

/**
 * Plan #31 AC-5 — `probe()` của Service 1 dùng nguồn metrics theo binding `metrics.query` CỦA
 * environment, trên registry THẬT và database thật: bí mật mở trong bộ nhớ, bản riêng của
 * environment thắng bản cluster, nhiều provider mà không chọn ⇒ 422.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_metrics_source_test_admin",
});
const registry = createRegistry({
  root: resolve(import.meta.dirname, "../src/modules"),
});

/** Nguồn mà S1 đã dựng provider cho — điều AC-5 khẳng định */
let seen: (MetricsSource | null)[] = [];
const app = createApp({
  metricsFor: (source) => {
    seen.push(source);
    return new FakeMetricsProvider();
  },
  flagService: createFlagServiceClient({
    baseUrl: "http://127.0.0.1:9",
    secret: env.INTERNAL_SERVICE_SECRET,
  }),
  oidcIssuer: null,
  cloud: inertCloudPlatform,
  domainRegistry: () => registry,
  provisioning: inertProvisioning,
});

const API_KEY = "0123456789abcdef0123456789abcdef";
const APP_KEY = "fedcba9876543210fedcba9876543210fedcba98";

let world: TestWorld;
let owner: Actor;

beforeAll(async () => {
  world = testWorld(app, admin);
  owner = await world.newActor("metrics-src");
});

beforeEach(() => {
  seen = [];
});

afterAll(async () => {
  await world.cleanup();
  await admin.$disconnect();
});

const probe = (projectId: string, environment: ProjectEnv) =>
  as(
    owner,
    request(app)
      .post(`${API}/projects/${projectId}/rollouts/probe`)
      .send({ envId: environment.id, workloadName: "checkout" }),
  );

async function domain(
  projectId: string,
  domainType: string,
  selectedTool: string,
  toolConfig: Record<string, unknown>,
): Promise<string> {
  const row = await admin.domainConfig.create({
    data: {
      projectId,
      domainType: domainType as never,
      isEnabled: true,
      selectedTool,
      toolConfig: toolConfig as Prisma.InputJsonValue,
      domainStatus: "ACTIVE",
      adapterVersion: "1.0.0",
    },
    select: { id: true },
  });
  return row.id;
}

const binding = (
  domainConfigId: string,
  providedBy: string,
  over: { environmentId?: string; endpoint?: string; version?: string } = {},
) =>
  admin.capabilityBinding.create({
    data: {
      domainConfigId,
      capabilityId: "metrics.query",
      providedBy,
      schemaVersion: over.version ?? "1.0.0",
      environmentId: over.environmentId ?? null,
      endpoint: over.endpoint ?? null,
    },
  });

async function datadogProject() {
  const { projectId, envs } = await world.newProject(owner);
  const sealed = sealSecrets(
    { schema: datadogConfigSchema, projectId, domainType: "MONITORING" },
    { site: "datadoghq.eu", apiKey: API_KEY, appKey: APP_KEY, maxHosts: 50 },
  );
  const id = await domain(projectId, "MONITORING", "datadog", sealed);
  await binding(id, "monitoring:datadog");
  return { projectId, envs };
}

describe("probe theo binding metrics.query của environment (AC-5)", () => {
  it("chưa có binding nào ⇒ nguồn null (đường PROMETHEUS_URL chung, §16)", async () => {
    const { projectId, envs } = await world.newProject(owner);
    await probe(projectId, envs.dev as ProjectEnv).expect(200);
    expect(seen).toEqual([null]);
  });

  it("Datadog ⇒ nguồn Datadog đúng site, khoá MỞ trong bộ nhớ từ bản niêm phong", async () => {
    const { projectId, envs } = await datadogProject();
    await probe(projectId, envs.dev as ProjectEnv).expect(200);
    expect(seen).toEqual([
      {
        kind: "datadog",
        site: "datadoghq.eu",
        apiKey: API_KEY,
        appKey: APP_KEY,
      },
    ]);
  });

  it("hai provider mà không chọn ⇒ 422 AMBIGUOUS_PROVIDER; có CapabilityPreference ⇒ đúng provider đã chọn", async () => {
    const { projectId, envs } = await datadogProject();
    const other = await domain(projectId, "COST", "khac", {});
    await binding(other, "cost:khac");

    const res = await probe(projectId, envs.dev as ProjectEnv).expect(422);
    expect(res.body.code).toBe("AMBIGUOUS_PROVIDER");
    expect(seen).toEqual([]);

    await admin.capabilityPreference.create({
      data: {
        projectId,
        capabilityId: "metrics.query",
        providerToolId: "monitoring:datadog",
      },
    });
    await probe(projectId, envs.dev as ProjectEnv).expect(200);
    expect(seen[0]?.kind).toBe("datadog");
  });

  it("bản riêng của environment thắng bản cluster; Prometheus trong cluster mang cờ inCluster", async () => {
    const { projectId, envs } = await world.newProject(owner);
    const dev = envs.dev as ProjectEnv;
    const id = await domain(projectId, "MONITORING", "prometheus-grafana", {
      retentionDays: 7,
      dashboards: true,
      storageGb: 20,
    });
    await binding(id, "monitoring:prometheus-grafana", {
      version: "2.0.0",
      endpoint: "http://prom-cum:9090",
    });
    await binding(id, "monitoring:prometheus-grafana", {
      version: "2.0.0",
      environmentId: dev.id,
      endpoint: "http://prom-dev:9090",
    });

    await probe(projectId, dev).expect(200);
    await probe(projectId, envs.staging as ProjectEnv).expect(200);
    expect(seen).toEqual([
      { kind: "prometheus", baseUrl: "http://prom-dev:9090", inCluster: true },
      { kind: "prometheus", baseUrl: "http://prom-cum:9090", inCluster: true },
    ]);
  });
});

describe("createMetricsFor [v4.11, Plan #39]", () => {
  const scope = { projectId: "00000000-0000-4000-8000-00000000aaaa" };
  const inCluster: MetricsSource = {
    kind: "prometheus",
    baseUrl: "http://udp-prometheus-prometheus.udp-system:9090",
    inCluster: true,
  };
  const target = { namespace: "shop-dev", workloadName: "checkout" };

  /** API server giả: ghi mọi lời proxy, trả một vector PromQL hoặc mã lỗi đang đặt */
  function fakeCluster() {
    const proxied: { target: unknown; path: string }[] = [];
    let status = 200;
    const access = {
      proxyService: (t: unknown, path: string) => {
        proxied.push({ target: t, path });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "success",
              data: { resultType: "vector", result: [{ value: [0, "0.5"] }] },
            }),
            { status },
          ),
        );
      },
    } as unknown as ClusterAccess;
    let resolves = 0;
    const clusters = createClusterAccessCache({
      resolve: () => {
        resolves += 1;
        return Promise.resolve({
          access,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
      },
    });
    return {
      clusters,
      proxied,
      resolves: () => resolves,
      respond: (s: number) => {
        status = s;
      },
    };
  }

  it("SaaS ⇒ provider của nhà cung cấp; chưa có nguồn ⇒ PROMETHEUS_URL của triển khai", () => {
    const metricsFor = createMetricsFor(null);
    expect(
      metricsFor(
        { kind: "datadog", site: "datadoghq.com", apiKey: "a", appKey: "b" },
        undefined,
        scope,
      ),
    ).toBeInstanceOf(DatadogMetricsProvider);
    expect(metricsFor(null, undefined, scope)).toBeInstanceOf(
      PrometheusMetricsProvider,
    );
  });

  it("Prometheus trong cluster mà tiến trình không có đường tới cluster ⇒ 503, KHÔNG lặng lẽ đo PROMETHEUS_URL", () => {
    expect(() => createMetricsFor(null)(inCluster, undefined, scope)).toThrow(
      ServiceUnavailableError,
    );
  });

  it("Prometheus trong cluster đi proxy của API server: đúng service/namespace/cổng, cùng đường và query; truy cập được nhớ", async () => {
    const cluster = fakeCluster();
    const provider = createMetricsFor(cluster.clusters)(
      inCluster,
      { metricBase: "http_server_requests" },
      scope,
    );
    const sample = await provider.requestCount(target, 60);
    await provider.errorCount(target, 60);

    expect(sample).toMatchObject({ value: 0.5, hasData: true });
    expect(cluster.proxied[0]?.target).toEqual({
      namespace: "udp-system",
      service: "udp-prometheus-prometheus",
      port: 9090,
      scheme: "http",
    });
    expect(cluster.proxied[0]?.path).toMatch(/^\/api\/v1\/query\?query=/);
    expect(decodeURIComponent(cluster.proxied[0]?.path ?? "")).toContain(
      "http_server_requests",
    );
    expect(cluster.resolves()).toBe(1);
    // Provider THẬT ra đúng hình dây mà route nội bộ gửi và S3 kiểm — lệch là S1 trả 500 mãi
    expect(() =>
      internalMetricsSampleResponseWire.parse({ sample }),
    ).not.toThrow();
    const probe = await provider.probe(target);
    expect(internalMetricsProbeResponseWire.parse({ probe }).probe.status).toBe(
      "SUCCESS",
    );
  });

  it("API server từ chối token (401) ⇒ mẫu không dữ liệu VÀ bỏ bản nhớ — lần đo sau dựng lại truy cập", async () => {
    const cluster = fakeCluster();
    const provider = createMetricsFor(cluster.clusters)(
      inCluster,
      undefined,
      scope,
    );
    cluster.respond(401);
    expect((await provider.errorRate(target, 60)).hasData).toBe(false);
    cluster.respond(200);
    await provider.requestCount(target, 60);
    expect(cluster.resolves()).toBe(2);
  });
});

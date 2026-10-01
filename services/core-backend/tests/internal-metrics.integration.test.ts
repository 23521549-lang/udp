import { resolve } from "node:path";
import { env, INTERNAL_SECRET_HEADER } from "@udp/config";
import { createPrismaClient, Prisma } from "@udp/db";
import type { MetricsSource } from "@udp/metrics-provider";
import {
  branchKeyOf,
  FakeMetricsProvider,
} from "@udp/metrics-provider/testing";
import {
  internalMetricsProbeResponseWire,
  internalMetricsSampleResponseWire,
  internalMetricsSourceResponseWire,
} from "@udp/shared-types/wire";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { createRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import { sealSecrets } from "../src/modules/domain/tool-secrets.js";
import { datadogConfigSchema } from "../src/modules/monitoring-adapter/datadog/index.js";
import { testWorld, type Actor, type TestWorld } from "./helpers/api.js";
import {
  noRepoSource,
  inertCloudPlatform,
  inertProvisioning,
  outsidePlatform,
  noExternalAuth,
} from "./helpers/inert-deps.js";

/**
 * Plan #39 (D-P30) — Service 1 đo metrics THAY Service 3 qua `/internal/environments/:envId/…`:
 * nguồn theo binding `metrics.query` của CHÍNH environment đó (khoá SaaS mở trong bộ nhớ S1,
 * không lên dây), cluster theo project của environment, và mọi trả lời khớp hình dây mà S3 kiểm.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_internal_metrics_test_admin",
});
const registry = createRegistry({
  root: resolve(import.meta.dirname, "../src/modules"),
});

interface Built {
  source: MetricsSource | null;
  metricBase: string | undefined;
  projectId: string;
}
let built: Built[] = [];
let fake = new FakeMetricsProvider();

const app = createApp({
  metricsFor: (source, metricQueries, scope) => {
    built.push({
      source,
      metricBase: metricQueries?.metricBase,
      projectId: scope.projectId,
    });
    return fake;
  },
  flagService: createFlagServiceClient({
    baseUrl: "http://127.0.0.1:9",
    secret: env.INTERNAL_SERVICE_SECRET,
  }),
  oidcIssuer: null,
  cloud: inertCloudPlatform,
  repoSource: noRepoSource,
  platform: outsidePlatform,
  auth: noExternalAuth,
  domainRegistry: () => registry,
  provisioning: inertProvisioning,
});

let world: TestWorld;
let owner: Actor;

beforeAll(async () => {
  world = testWorld(app, admin);
  owner = await world.newActor("int-metrics");
});

beforeEach(() => {
  built = [];
  fake = new FakeMetricsProvider({ scrapeLagSeconds: 30 });
});

afterAll(async () => {
  await world.cleanup();
  await admin.$disconnect();
});

const measure = (environmentId: string, body: unknown) =>
  request(app)
    .post(`/internal/environments/${environmentId}/metrics`)
    .set(INTERNAL_SECRET_HEADER, env.INTERNAL_SERVICE_SECRET)
    .send(body as object);

const target = {
  namespace: "shop-dev",
  workloadName: "checkout",
  flagKey: "new-checkout",
  variantKey: "on",
};

async function devEnvironment(): Promise<{ projectId: string; id: string }> {
  const { projectId, envs } = await world.newProject(owner);
  return { projectId, id: (envs.dev as { id: string }).id };
}

describe("xác thực — cổng /internal của Service 1 (§12 T12)", () => {
  it("thiếu và sai bí mật là CÙNG một 401; không đụng tới nguồn metrics", async () => {
    const { id } = await devEnvironment();
    const path = `/internal/environments/${id}/metrics-source`;
    const missing = await request(app).get(path).expect(401);
    const wrong = await request(app)
      .get(path)
      .set(INTERNAL_SECRET_HEADER, "x".repeat(40))
      .expect(401);
    // traceId là của từng request — mọi trường còn lại phải trùng
    expect({ ...wrong.body, traceId: null }).toEqual({
      ...missing.body,
      traceId: null,
    });
    expect(built).toEqual([]);
  });

  it("không nằm dưới /api/v1: POST không cần CSRF, và /api/v1/internal không tồn tại", async () => {
    const { id } = await devEnvironment();
    await measure(id, { op: "requestCount", target, windowSec: 60 }).expect(
      200,
    );
    await request(app)
      .post(`/api/v1/internal/environments/${id}/metrics`)
      .set(INTERNAL_SECRET_HEADER, env.INTERNAL_SERVICE_SECRET)
      .send({ op: "requestCount", target, windowSec: 60 })
      .expect((res) => {
        expect(res.status).not.toBe(200);
      });
  });
});

describe("phép đo theo environment", () => {
  it("mẫu đo khớp hình dây; provider dựng cho ĐÚNG project của environment, với metricBase của session", async () => {
    const { projectId, id } = await devEnvironment();
    fake.set(branchKeyOf(target), { requests: 200, errors: 4 });

    const res = await measure(id, {
      op: "errorRate",
      target,
      windowSec: 120,
      metricQueries: { metricBase: "http_server_requests" },
    }).expect(200);

    const { sample } = internalMetricsSampleResponseWire.parse(res.body);
    expect(sample).toMatchObject({
      value: 0.02,
      windowSeconds: 120,
      hasData: true,
    });
    expect(built).toEqual([
      { source: null, metricBase: "http_server_requests", projectId },
    ]);
    expect(fake.calls).toEqual([
      { kind: "errorRate", key: branchKeyOf(target), windowSec: 120 },
    ]);
  });

  it("nhánh không có dữ liệu ⇒ hasData false lên dây nguyên vẹn, không thành 0 có dữ liệu (I7)", async () => {
    const { id } = await devEnvironment();
    const res = await measure(id, {
      op: "latencyP99",
      target,
      windowSec: 60,
    }).expect(200);
    expect(res.body.sample.hasData).toBe(false);
  });

  it("custom mang nguyên truy vấn; probe trả đúng kết cục của nguồn", async () => {
    const { id } = await devEnvironment();
    const custom = await measure(id, {
      op: "custom",
      query: "sum(rate(orders_total[5m]))",
      target,
      windowSec: 300,
    }).expect(200);
    expect(custom.body.sample.query).toBe("sum(rate(orders_total[5m]))");

    fake.setReachable(false);
    const probe = await measure(id, { op: "probe", target }).expect(200);
    const parsed = internalMetricsProbeResponseWire.parse(probe.body).probe;
    expect(parsed.status).toBe("FAILED");
    expect(parsed.data?.reachable).toBe(false);
  });

  it("siêu dữ liệu nguồn: providerId, capabilityVersion, độ trễ scrape — không khoá nào", async () => {
    const { id } = await devEnvironment();
    const res = await request(app)
      .get(`/internal/environments/${id}/metrics-source`)
      .set(INTERNAL_SECRET_HEADER, env.INTERNAL_SERVICE_SECRET)
      .expect(200);
    expect(internalMetricsSourceResponseWire.parse(res.body)).toEqual({
      source: {
        providerId: "fake",
        capabilityVersion: "0.0",
        scrapeLagSeconds: 30,
      },
    });
  });

  it("nguồn SaaS: S1 mở khoá của binding trong bộ nhớ và đo — khoá không lên dây trả S3", async () => {
    const { projectId, id } = await devEnvironment();
    const apiKey = "0123456789abcdef0123456789abcdef";
    const appKey = "fedcba9876543210fedcba9876543210fedcba98";
    const config = await admin.domainConfig.create({
      data: {
        projectId,
        domainType: "MONITORING",
        isEnabled: true,
        selectedTool: "datadog",
        toolConfig: sealSecrets(
          { schema: datadogConfigSchema, projectId, domainType: "MONITORING" },
          { site: "datadoghq.eu", apiKey, appKey, maxHosts: 50 },
        ) as Prisma.InputJsonValue,
        domainStatus: "ACTIVE",
        adapterVersion: "1.0.0",
      },
      select: { id: true },
    });
    await admin.capabilityBinding.create({
      data: {
        domainConfigId: config.id,
        capabilityId: "metrics.query",
        providedBy: "monitoring:datadog",
        schemaVersion: "1.0.0",
      },
    });

    const res = await measure(id, {
      op: "requestCount",
      target,
      windowSec: 60,
    }).expect(200);
    expect(built[0]?.source).toEqual({
      kind: "datadog",
      site: "datadoghq.eu",
      apiKey,
      appKey,
    });
    expect(JSON.stringify(res.body)).not.toContain(apiKey);
  });

  it("hai environment, hai nguồn: mỗi phép đo đi nguồn của CHÍNH environment được hỏi (AC-1)", async () => {
    const { projectId, envs } = await world.newProject(owner);
    const dev = (envs.dev as { id: string }).id;
    const staging = (envs.staging as { id: string }).id;
    const config = await admin.domainConfig.create({
      data: {
        projectId,
        domainType: "MONITORING",
        isEnabled: true,
        selectedTool: "prometheus-grafana",
        toolConfig: { retentionDays: 7, dashboards: true, storageGb: 20 },
        domainStatus: "ACTIVE",
        adapterVersion: "1.0.0",
      },
      select: { id: true },
    });
    const bind = (endpoint: string, environmentId: string | null) =>
      admin.capabilityBinding.create({
        data: {
          domainConfigId: config.id,
          capabilityId: "metrics.query",
          providedBy: "monitoring:prometheus-grafana",
          schemaVersion: "2.0.0",
          environmentId,
          endpoint,
        },
      });
    await bind("http://prom-shared.monitoring:9090", null);
    await bind("http://prom-dev.monitoring:9090", dev);

    await measure(staging, { op: "errorRate", target, windowSec: 60 }).expect(
      200,
    );
    await measure(dev, { op: "errorRate", target, windowSec: 60 }).expect(200);

    const baseUrlOf = (b: Built | undefined) =>
      b?.source?.kind === "prometheus" ? b.source.baseUrl : undefined;
    expect(built.map(baseUrlOf)).toEqual([
      "http://prom-shared.monitoring:9090",
      "http://prom-dev.monitoring:9090",
    ]);
    expect(built.every((b) => b.projectId === projectId)).toBe(true);
  });
});

describe("đầu vào sai", () => {
  it("environment không tồn tại ⇒ 404; mã sai dạng ⇒ 400; thân lạ ⇒ 400 — không dựng provider", async () => {
    await measure("00000000-0000-4000-8000-000000000000", {
      op: "requestCount",
      target,
      windowSec: 60,
    }).expect(404);
    await measure("khong-phai-uuid", {
      op: "requestCount",
      target,
      windowSec: 60,
    }).expect(400);

    const { id } = await devEnvironment();
    await measure(id, { op: "drop", target, windowSec: 60 }).expect(400);
    await measure(id, {
      op: "errorRate",
      target: { ...target, extra: 1 },
      windowSec: 60,
    }).expect(400);
    await measure(id, { op: "errorRate", target, windowSec: 0 }).expect(400);
    expect(built).toEqual([]);
  });
});

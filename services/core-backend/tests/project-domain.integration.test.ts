import { resolve } from "node:path";
import { env } from "@udp/config";
import { createPrismaClient, Prisma } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import { DOMAIN_ERROR_SLUGS } from "@udp/shared-types/domain-api";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { createRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";
import {
  noRepoSource,
  inertCloudPlatform,
  inertProvisioning,
} from "./helpers/inert-deps.js";

/**
 * Domain của project qua HTTP thật trên database thật với registry THẬT của sản phẩm
 * (Plan #27 AC-3..AC-6): trạng thái đích, khoá cả tập, lỗi trường, quyền, drift.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_project_domain_test_admin",
});

const registry = createRegistry({
  root: resolve(import.meta.dirname, "../src/modules"),
});
const app = createApp({
  metricsFor: () => new FakeMetricsProvider(),
  flagService: createFlagServiceClient({
    baseUrl: "http://127.0.0.1:9",
    secret: env.INTERNAL_SERVICE_SECRET,
  }),
  oidcIssuer: null,
  cloud: inertCloudPlatform,
  repoSource: noRepoSource,
  domainRegistry: () => registry,
  provisioning: inertProvisioning,
});

let world: TestWorld;
let maintainer: Actor;
let developer: Actor;
let viewer: Actor;
let owner: Actor;
let projectId: string;

const url = (pid = projectId) => `${API}/projects/${pid}/domains`;
const DATADOG = {
  domainType: "MONITORING",
  toolId: "datadog",
  config: {
    site: "datadoghq.com",
    apiKey: "0123456789abcdef0123456789abcdef",
    appKey: "fedcba9876543210fedcba9876543210fedcba98",
  },
};
const put = (actor: Actor, body: object, pid = projectId) =>
  as(actor, request(app).put(url(pid)).send(body));
const versionOf = async (pid = projectId): Promise<number> =>
  (
    (await as(owner, request(app).get(url(pid))).expect(200)).body as {
      domainSetVersion: number;
    }
  ).domainSetVersion;

beforeAll(async () => {
  world = testWorld(app, admin);
  owner = await world.newActor("dom-owner");
  maintainer = await world.newActor("dom-maint");
  developer = await world.newActor("dom-dev");
  viewer = await world.newActor("dom-viewer");
  ({ projectId } = await world.newProject(owner));
  await world.addMember(owner, projectId, maintainer, "MAINTAINER");
  await world.addMember(owner, projectId, developer, "DEVELOPER");
  await world.addMember(owner, projectId, viewer, "VIEWER");
});

afterAll(async () => {
  await world.cleanup();
  await admin.$disconnect();
});

describe("GET /domains", () => {
  it("đủ 16 domain của catalog; chưa cấu hình thì status null, version 0", async () => {
    const res = await as(viewer, request(app).get(url())).expect(200);
    expect(res.body.domainSetVersion).toBe(0);
    expect(res.body.domains).toHaveLength(16);
    expect(res.body.domains[0]).toMatchObject({
      isEnabled: false,
      status: null,
    });
  });
});

describe("PUT /domains", () => {
  it("lưu cả tập: PENDING, config đã parse (có mặc định), version tăng, preference lưu", async () => {
    const res = await put(maintainer, {
      lastKnownDomainSetVersion: 0,
      domains: [DATADOG],
      preferences: [
        { capabilityId: "metrics.query", providerToolId: "monitoring:datadog" },
      ],
    }).expect(200);
    expect(res.body.domainSetVersion).toBe(1);
    const monitoring = res.body.domains.find(
      (d: { domainType: string }) => d.domainType === "MONITORING",
    );
    expect(monitoring).toMatchObject({
      isEnabled: true,
      selectedTool: "datadog",
      status: "PENDING",
      adapterVersion: "1.0.0",
      // Khoá là bí mật: trên dây chỉ còn giá trị giữ chỗ (Plan #31)
      toolConfig: {
        site: "datadoghq.com",
        apiKey: { $udpSecret: "kept" },
        appKey: { $udpSecret: "kept" },
        maxHosts: 50,
      },
    });
    expect(res.body.preferences).toEqual([
      { capabilityId: "metrics.query", providerToolId: "monitoring:datadog" },
    ]);
  });

  it("version cũ ⇒ 409 OPTIMISTIC_LOCK kèm bản hiện tại", async () => {
    const res = await put(maintainer, {
      lastKnownDomainSetVersion: 0,
      domains: [],
      preferences: [],
    }).expect(409);
    expect(res.body.code).toBe("OPTIMISTIC_LOCK");
    expect(res.body.current.domainSetVersion).toBe(1);
  });

  it("hai PUT đua cùng version ⇒ đúng một thắng", async () => {
    const version = await versionOf();
    const results = await Promise.all(
      [0, 1].map(() =>
        put(maintainer, {
          lastKnownDomainSetVersion: version,
          domains: [DATADOG],
          preferences: [],
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await versionOf()).toBe(version + 1);
  });

  it("vắng mặt là tắt; preference không gửi lại là bị xoá cùng lần ghi", async () => {
    const res = await put(maintainer, {
      lastKnownDomainSetVersion: await versionOf(),
      domains: [],
      preferences: [],
    }).expect(200);
    const monitoring = res.body.domains.find(
      (d: { domainType: string }) => d.domainType === "MONITORING",
    );
    expect(monitoring).toMatchObject({
      isEnabled: false,
      selectedTool: "datadog",
    });
    expect(res.body.preferences).toEqual([]);
  });

  it("config sai ⇒ 400 đúng trường; tool lạ ⇒ 422 slug", async () => {
    const version = await versionOf();
    const bad = await put(maintainer, {
      lastKnownDomainSetVersion: version,
      domains: [{ ...DATADOG, config: { ...DATADOG.config, site: "khac" } }],
      preferences: [],
    }).expect(400);
    expect(bad.body.errors[0].field).toBe("domains.0.config.site");
    const unknown = await put(maintainer, {
      lastKnownDomainSetVersion: version,
      domains: [{ ...DATADOG, toolId: "khong-co" }],
      preferences: [],
    }).expect(422);
    expect(unknown.body.type).toContain(DOMAIN_ERROR_SLUGS.unknownTool);
  });

  it("trạng thái đích thiếu capability ⇒ 422 mã catalog, không ghi gì", async () => {
    const version = await versionOf();
    const res = await put(maintainer, {
      lastKnownDomainSetVersion: version,
      domains: [
        {
          domainType: "MONITORING",
          toolId: "prometheus-grafana",
          config: { retentionDays: 7 },
        },
      ],
      preferences: [],
    }).expect(422);
    expect(res.body.code).toBe("MISSING_CAPABILITY");
    expect(await versionOf()).toBe(version);
  });

  it("quyền: DEVELOPER kiểm được nhưng không lưu; VIEWER không kiểm", async () => {
    const state = { domains: [DATADOG], preferences: [] };
    const v = await as(
      developer,
      request(app).post(`${url()}/validate`).send(state),
    ).expect(200);
    expect(v.body.validation).toMatchObject({ valid: true, errors: [] });
    await put(developer, {
      ...state,
      lastKnownDomainSetVersion: await versionOf(),
    }).expect(403);
    await as(viewer, request(app).post(`${url()}/validate`).send(state)).expect(
      403,
    );
  });

  it("project đang triển khai ⇒ 409 domains-need-apply-job; ACTIVE mà chưa triển khai xong ⇒ 409 domain-not-running; khoá không tăng", async () => {
    const { projectId: other } = await world.newProject(owner);
    const body = {
      lastKnownDomainSetVersion: 0,
      domains: [DATADOG],
      preferences: [],
    };
    await admin.project.update({
      where: { id: other },
      data: { status: "PROVISIONING" },
    });
    const busy = await put(owner, body, other).expect(409);
    expect(busy.body.type).toContain(DOMAIN_ERROR_SLUGS.needsApplyJob);

    // Plan #30: project ACTIVE đi nhánh job DOMAIN_APPLY — cần một lượt PROVISION đã xong
    await admin.project.update({
      where: { id: other },
      data: { status: "ACTIVE" },
    });
    const orphan = await put(owner, body, other).expect(409);
    expect(orphan.body.type).toContain(DOMAIN_ERROR_SLUGS.notRunning);
    expect(await versionOf(other)).toBe(0);
  });
});

describe("GET /domains/:type và /drift", () => {
  it("domain lạ ⇒ 404; domain chưa triển khai ⇒ NOT_DEPLOYED", async () => {
    await as(viewer, request(app).get(`${url()}/KHONG_CO`)).expect(404);
    await as(viewer, request(app).get(`${url()}/monitoring`)).expect(404);
    const res = await as(
      viewer,
      request(app).get(`${url()}/MONITORING/drift`),
    ).expect(200);
    expect(res.body.drift).toEqual({
      verdict: "NOT_DEPLOYED",
      message: null,
      at: null,
    });
  });

  it("đọc đúng bản ghi drift mà lượt quét để lại", async () => {
    const where = {
      projectId_domainType: { projectId, domainType: "MONITORING" },
    };
    await admin.domainConfig.update({
      where,
      data: { domainStatus: "ACTIVE", lastError: Prisma.DbNull },
    });
    const clean = await as(
      viewer,
      request(app).get(`${url()}/MONITORING/drift`),
    ).expect(200);
    expect(clean.body.drift.verdict).toBe("CLEAN");

    await admin.domainConfig.update({
      where,
      data: {
        lastError: {
          step: "DRIFT_SCAN",
          message: "configmap/monitoring-values: retention 15d ≠ 7d",
          adapterResult: "DRIFTED",
          at: "2026-09-25T00:00:00.000Z",
        },
      },
    });
    const drifted = await as(
      viewer,
      request(app).get(`${url()}/MONITORING/drift`),
    ).expect(200);
    expect(drifted.body.drift).toEqual({
      verdict: "DRIFTED",
      message: "configmap/monitoring-values: retention 15d ≠ 7d",
      at: "2026-09-25T00:00:00.000Z",
    });
    const one = await as(
      viewer,
      request(app).get(`${url()}/MONITORING`),
    ).expect(200);
    expect(one.body.domain).toMatchObject({
      domainType: "MONITORING",
      status: "ACTIVE",
    });
  });
});

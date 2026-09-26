import { env } from "@udp/config";
import type { ClusterAccess } from "@udp/adapter-core";
import { createPrismaClient } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import { DOMAIN_ERROR_SLUGS } from "@udp/shared-types/domain-api";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { WithCluster } from "../src/core/app-deps.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
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
  noDomainAdapters,
} from "./helpers/inert-deps.js";

/**
 * Plan #38 AC-4 — `GET /projects/:id/cost` qua HTTP thật, database thật; cluster là cổng giả
 * ghi lại lời gọi `proxyService` và trả dữ liệu đúng hình `/allocation` của OpenCost.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_cost_admin",
});

const calls: { target: unknown; path: string }[] = [];
let reply: () => Response = () => Response.json({ data: [] });

const fakeAccess = {
  proxyService: (target: unknown, path: string) => {
    calls.push({ target, path });
    return Promise.resolve(reply());
  },
} as unknown as ClusterAccess;

const withCluster: WithCluster = (_projectId, use) => use(fakeAccess);

const appWith = (cluster: WithCluster | null) =>
  createApp({
    metricsFor: () => new FakeMetricsProvider(),
    flagService: createFlagServiceClient({
      baseUrl: "http://127.0.0.1:9",
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
    oidcIssuer: null,
    cloud: inertCloudPlatform,
    domainRegistry: noDomainAdapters,
    provisioning: { ...inertProvisioning, withCluster: cluster },
  });

const app = appWith(withCluster);
let world: TestWorld;
let owner: Actor;
let viewer: Actor;
let projectId: string;
let envs: Record<string, ProjectEnv>;

const costUrl = (days?: number) =>
  `${API}/projects/${projectId}/cost${days === undefined ? "" : `?days=${String(days)}`}`;

beforeAll(async () => {
  world = testWorld(app, admin);
  owner = await world.newActor("cost-owner");
  viewer = await world.newActor("cost-viewer");
  ({ projectId, envs } = await world.newProject(owner));
  await world.addMember(owner, projectId, viewer, "VIEWER");
}, 120_000);

afterAll(async () => {
  await world.cleanup();
  await admin.$disconnect();
});

describe("GET /projects/:id/cost (Plan #38 AC-4)", () => {
  it("chưa bật Cost ⇒ 409 kèm slug riêng", async () => {
    const res = await as(owner, request(app).get(costUrl())).expect(409);
    expect(res.body.type).toContain(DOMAIN_ERROR_SLUGS.costNotEnabled);
  });

  it("bật OpenCost ⇒ hỏi đúng dịch vụ qua proxy, đúng cửa sổ; namespace ⇒ environment; namespace lạ bị bỏ", async () => {
    const row = await admin.domainConfig.create({
      data: {
        projectId,
        domainType: "COST",
        isEnabled: true,
        selectedTool: "opencost",
        toolConfig: {},
      },
    });
    await admin.capabilityBinding.create({
      data: {
        domainConfigId: row.id,
        capabilityId: "cost.query",
        providedBy: "cost:opencost",
        schemaVersion: "1.0.0",
        endpoint: "http://udp-opencost.udp-system:9003",
        attributes: {
          provider: "opencost",
          namespace: "udp-system",
          service: "udp-opencost",
          port: "9003",
          allocationPath: "/allocation/compute",
        },
      },
    });
    const dev = envs.dev!;
    const prod = envs.prod!;
    reply = () =>
      Response.json({
        code: 200,
        data: [
          {
            [dev.k8sNamespace]: {
              totalCost: 1.234,
              cpuCost: 1,
              ramCost: 0.2,
              pvCost: 0.034,
              networkCost: 0,
            },
            [prod.k8sNamespace]: {
              totalCost: 10.5,
              cpuCost: 6,
              ramCost: 3,
              pvCost: 1,
              networkCost: 0.5,
            },
            "kube-system": { totalCost: 99 },
          },
        ],
      });

    const res = await as(owner, request(app).get(costUrl(7))).expect(200);
    expect(calls.at(-1)).toEqual({
      target: {
        namespace: "udp-system",
        service: "udp-opencost",
        port: 9003,
        scheme: "http",
      },
      path: "/allocation/compute?window=7d&aggregate=namespace&accumulate=true",
    });
    const cost = res.body.cost as {
      provider: string;
      totalUsd: number;
      environments: { name: string; totalUsd: number; storageUsd: number }[];
    };
    expect(cost.provider).toBe("opencost");
    expect(cost.totalUsd).toBe(11.73);
    expect(
      Object.fromEntries(cost.environments.map((e) => [e.name, e.totalUsd])),
    ).toEqual({ dev: 1.23, staging: 0, prod: 10.5 });
    expect(cost.environments.find((e) => e.name === "dev")?.storageUsd).toBe(
      0.03,
    );
  });

  it("VIEWER không xem được tiền; cửa sổ ngoài 1–30 ngày ⇒ 400", async () => {
    await as(viewer, request(app).get(costUrl())).expect(403);
    await as(owner, request(app).get(costUrl(31))).expect(400);
  });

  it("bộ tính trả lỗi hay sai hình, hay tiến trình không chạm được cluster ⇒ 503", async () => {
    reply = () => new Response("hỏng", { status: 500 });
    await as(owner, request(app).get(costUrl())).expect(503);
    reply = () => Response.json({ khong: "dung hinh" });
    await as(owner, request(app).get(costUrl())).expect(503);
    await as(owner, request(appWith(null)).get(costUrl())).expect(503);
  });
});

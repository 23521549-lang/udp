import { randomUUID } from "node:crypto";
import type { ObjectRef } from "@udp/adapter-core";
import { FakeCluster } from "@udp/cluster-access/testing";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { flaggerGateToken } from "@udp/http";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import type { WithCluster } from "../src/core/app-deps.js";
import { VERSION_LABEL } from "../src/modules/cicd/workload.js";
import { DELIVERY_ANNOTATIONS } from "../src/modules/rollout/delivery/delivery.types.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";
import {
  inertCloudPlatform,
  inertProvisioning,
  noDomainAdapters,
  noRepoSource,
} from "./helpers/inert-deps.js";

/**
 * Tạo rollout SERVICE_LEVEL ở Service 1 (§8.5, §7.3) [Plan #51 AC-5] — qua HTTP thật, database thật, cụm GIẢ
 * (`FakeCluster`: merge patch, điều kiện `resourceVersion`, ghi lại mọi lời ghi). Tool của environment đến từ
 * binding `traffic.control` thật trong database.
 */

type Json = Record<string, unknown>;

const WORKLOAD = "web";
const GATE_URL = "http://pd-controller.vi-du.test";

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_rollout_service_level_test_admin",
});

let world: TestWorld;
let owner: Actor;
let fake: FakeMetricsProvider;
const clusters = new Map<string, FakeCluster>();
const withCluster: WithCluster = (projectId, use) => {
  const cluster = clusters.get(projectId);
  if (cluster === undefined) throw new Error(`không có cụm cho ${projectId}`);
  return use(cluster.access(projectId));
};

const app = createApp({
  metricsFor: () => fake,
  oidcIssuer: null,
  cloud: inertCloudPlatform,
  repoSource: noRepoSource,
  domainRegistry: noDomainAdapters,
  provisioning: {
    ...inertProvisioning,
    withCluster,
    flaggerGateBaseUrl: GATE_URL,
  },
  flagService: createFlagServiceClient({
    baseUrl: "http://127.0.0.1:9",
    secret: env.INTERNAL_SERVICE_SECRET,
  }),
});

interface World {
  projectId: string;
  envId: string;
  namespace: string;
}
let argo: World;
let flagger: World;
let bare: World;

const ref = (
  apiVersion: string,
  kind: string,
  w: World,
  name = WORKLOAD,
): ObjectRef => ({
  apiVersion,
  kind,
  namespace: w.namespace,
  name,
});
const rolloutRef = (w: World) => ref("argoproj.io/v1alpha1", "Rollout", w);
const deploymentRef = (w: World) => ref("apps/v1", "Deployment", w);
const serviceRef = (w: World, name = WORKLOAD) => ref("v1", "Service", w, name);
const canaryRef = (w: World) => ref("flagger.app/v1beta1", "Canary", w);

const template = {
  metadata: { labels: { app: WORKLOAD, [VERSION_LABEL]: "v1" } },
  spec: {
    containers: [
      {
        name: WORKLOAD,
        image: "ghcr.io/acme/web:v1",
        ports: [{ containerPort: 8080 }],
      },
    ],
  },
};

const BASE_STRATEGY = {
  canary: {
    canaryService: "web-canary",
    stableService: WORKLOAD,
    trafficRouting: {
      istio: { virtualService: { name: WORKLOAD, routes: ["primary"] } },
    },
    steps: [{ setWeight: 50 }],
  },
};

function seedCluster(w: World, tool: "argo" | "flagger"): FakeCluster {
  const cluster = new FakeCluster();
  cluster.seed(serviceRef(w), {
    apiVersion: "v1",
    kind: "Service",
    spec: {
      selector: { app: WORKLOAD },
      ports: [{ name: "http", port: 80, targetPort: 8080, nodePort: 30080 }],
    },
  });
  if (tool === "argo") {
    cluster.seed(rolloutRef(w), {
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Rollout",
      metadata: { name: WORKLOAD, namespace: w.namespace },
      spec: { replicas: 2, template, strategy: BASE_STRATEGY },
      status: { phase: "Healthy" },
    });
  } else {
    cluster.seed(deploymentRef(w), {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: WORKLOAD, namespace: w.namespace },
      spec: { replicas: 2, template },
    });
    cluster.seed(canaryRef(w), {
      apiVersion: "flagger.app/v1beta1",
      kind: "Canary",
      metadata: { name: WORKLOAD, namespace: w.namespace },
      spec: {},
      status: { phase: "Initialized" },
    });
  }
  clusters.set(w.projectId, cluster);
  return cluster;
}

async function newWorld(tool: string | null): Promise<World> {
  const project = await world.newProject(owner);
  const dev = project.envs["dev"];
  if (dev === undefined) throw new Error("thiếu env dev");
  if (tool !== null) {
    const delivery = await admin.domainConfig.create({
      data: {
        projectId: project.projectId,
        domainType: "PROGRESSIVE_DELIVERY",
        isEnabled: true,
        selectedTool: tool,
      },
      select: { id: true },
    });
    const mesh = await admin.domainConfig.create({
      data: {
        projectId: project.projectId,
        domainType: "SERVICE_MESH",
        isEnabled: true,
        selectedTool: "istio",
      },
      select: { id: true },
    });
    await admin.capabilityBinding.createMany({
      data: [
        {
          id: randomUUID(),
          domainConfigId: delivery.id,
          environmentId: null,
          capabilityId: "traffic.control",
          providedBy: `progressive_delivery:${tool}`,
          schemaVersion: "1.0.0",
        },
        {
          id: randomUUID(),
          domainConfigId: mesh.id,
          environmentId: null,
          capabilityId: "mesh.traffic-split",
          providedBy: "service_mesh:istio",
          schemaVersion: "1.0.0",
          attributes: { provider: "istio" },
        },
      ],
    });
  }
  return {
    projectId: project.projectId,
    envId: dev.id,
    namespace: dev.k8sNamespace,
  };
}

const create = (w: World, body: Json) =>
  as(
    owner,
    request(app)
      .post(`${API}/projects/${w.projectId}/rollouts`)
      .send({
        scope: "SERVICE_LEVEL",
        envId: w.envId,
        workloadName: WORKLOAD,
        imageTag: "v2",
        stepPercent: 20,
        ...body,
      }),
  );

const sessionsOf = (w: World) =>
  admin.rolloutSession.count({ where: { projectId: w.projectId } });

beforeAll(async () => {
  world = testWorld(app, admin);
  owner = await world.newActor("svc-rollout");
  argo = await newWorld("argo-rollouts");
  flagger = await newWorld("flagger");
  bare = await newWorld(null);
}, 120_000);

beforeEach(() => {
  fake = new FakeMetricsProvider();
  for (const w of [argo, flagger, bare])
    fake.setWorkload(w.namespace, WORKLOAD);
  seedCluster(argo, "argo");
  seedCluster(flagger, "flagger");
  seedCluster(bare, "argo");
});

afterEach(async () => {
  for (const w of [argo, flagger, bare]) {
    await admin.$executeRaw`UPDATE rollout_sessions SET status = 'DONE' WHERE project_id = ${w.projectId}::uuid AND status IN ('PENDING','IN_PROGRESS','PAUSED')`;
  }
});

afterAll(async () => {
  const projectIds = [argo, flagger, bare].map((w) => w.projectId);
  await admin.deploymentEvent.deleteMany({
    where: { projectId: { in: projectIds } },
  });
  await admin.capabilityBinding.deleteMany({
    where: { domainConfig: { projectId: { in: projectIds } } },
  });
  await world.cleanup();
  await admin.$disconnect();
});

describe("Argo Rollouts", () => {
  it("udp-driven CANARY: MỘT merge patch mang strategy (không analysis, pause vô hạn) + image mới; session PENDING ở 0%; DEPLOY_START", async () => {
    const res = await create(argo, { controlMode: "udp-driven" }).expect(201);
    const rollout = res.body.rollout as Json;
    expect(rollout).toMatchObject({
      scope: "SERVICE_LEVEL",
      controlMode: "udp-driven",
      strategy: "CANARY",
      status: "PENDING",
      workloadName: WORKLOAD,
      versionOld: "v1",
      versionNew: "v2",
      currentTrafficPercentage: 0,
      baselinePercentage: 0,
    });

    const cluster = clusters.get(argo.projectId) as FakeCluster;
    const live = cluster.get(rolloutRef(argo)) as {
      metadata: { annotations: Record<string, string> };
      spec: { template: typeof template; strategy: { canary: Json } };
    };
    expect(live.spec.template.spec.containers[0]?.image).toBe(
      "ghcr.io/acme/web:v2",
    );
    expect(live.spec.template.metadata.labels[VERSION_LABEL]).toBe("v2");
    expect(live.spec.strategy.canary).not.toHaveProperty("analysis");
    expect(live.spec.strategy.canary["steps"]).toEqual(
      [20, 40, 60, 80].flatMap((w) => [{ setWeight: w }, { pause: {} }]),
    );
    expect(live.metadata.annotations[DELIVERY_ANNOTATIONS.session]).toBe(
      rollout["id"],
    );
    expect(
      JSON.parse(
        live.metadata.annotations[DELIVERY_ANNOTATIONS.previousStrategy] ??
          "{}",
      ),
    ).toEqual(BASE_STRATEGY);
    // S1 ghi bằng udp-workload, đúng một lần ghi lên Rollout (§12.2)
    expect(cluster.writes.map((w) => [w.identity, w.verb, w.path])).toEqual([
      [
        "workload",
        "patch",
        `/apis/argoproj.io/v1alpha1/namespaces/${argo.namespace}/rollouts/web`,
      ],
    ]);
    const start = await admin.deploymentEvent.findFirstOrThrow({
      where: { rolloutSessionId: rollout["id"] as string },
    });
    expect(start).toMatchObject({
      eventType: "DEPLOY_START",
      deploymentId: rollout["id"],
      imageTag: "v2",
      workloadName: WORKLOAD,
      triggeredBy: "MANUAL",
    });
  });

  it("BLUE_GREEN: service preview (không chép nodePort) rồi strategy blueGreen; tool-driven CANARY không có Prometheus trong cluster ⇒ 422, không ghi gì", async () => {
    await create(argo, {
      strategy: "BLUE_GREEN",
      controlMode: "udp-driven",
    }).expect(201);
    const cluster = clusters.get(argo.projectId) as FakeCluster;
    expect(cluster.get(serviceRef(argo, "web-preview"))).toMatchObject({
      spec: {
        selector: { app: WORKLOAD },
        ports: [{ name: "http", port: 80, targetPort: 8080 }],
      },
    });
    expect(
      (cluster.get(rolloutRef(argo)) as { spec: { strategy: Json } }).spec
        .strategy,
    ).toEqual({
      blueGreen: {
        activeService: WORKLOAD,
        previewService: "web-preview",
        autoPromotionEnabled: false,
      },
    });

    seedCluster(argo, "argo");
    const before = await sessionsOf(argo);
    const res = await create(argo, { controlMode: "tool-driven" }).expect(422);
    expect(res.body.detail).toMatch(/Prometheus TRONG cluster/);
    expect(await sessionsOf(argo)).toBe(before);
    expect(clusters.get(argo.projectId)?.writes).toEqual([]);
  });

  it("ATTRIBUTE_SPLIT udp-driven (router Istio): một pod canary, dừng vô hạn, trafficMatch lưu và trả về", async () => {
    const res = await create(argo, {
      strategy: "ATTRIBUTE_SPLIT",
      controlMode: "udp-driven",
      trafficMatch: { header: "X-Beta", value: "1" },
    }).expect(201);
    expect(res.body.rollout.trafficMatch).toEqual({
      header: "X-Beta",
      value: "1",
    });
    const live = clusters.get(argo.projectId)?.get(rolloutRef(argo)) as {
      spec: { strategy: { canary: Json } };
    };
    expect(live.spec.strategy.canary["steps"]).toEqual([
      { setCanaryScale: { replicas: 1 } },
      { pause: {} },
    ]);
  });

  it("409: Rollout đang giữa một lượt; đã có rollout sống trên workload (kèm resourceId); ghi hỏng ⇒ bù trừ xoá session", async () => {
    const cluster = clusters.get(argo.projectId) as FakeCluster;
    cluster.setStatus(rolloutRef(argo), { phase: "Paused" });
    await create(argo, { controlMode: "udp-driven" }).expect(409);

    seedCluster(argo, "argo");
    const first = await create(argo, { controlMode: "udp-driven" }).expect(201);
    seedCluster(argo, "argo");
    const second = await create(argo, {
      controlMode: "udp-driven",
      imageTag: "v3",
    }).expect(409);
    expect(second.body.code).toBe("ROLLOUT_IN_PROGRESS");
    expect(second.body.resourceId).toBe(first.body.rollout.id);

    await admin.$executeRaw`UPDATE rollout_sessions SET status = 'DONE' WHERE project_id = ${argo.projectId}::uuid`;
    const racing = seedCluster(argo, "argo");
    racing.failWrite = (w) => (w.verb === "patch" ? 409 : undefined);
    const before = await sessionsOf(argo);
    const lost = await create(argo, { controlMode: "udp-driven" }).expect(409);
    expect(lost.body.code).toBe("OPTIMISTIC_LOCK");
    expect(await sessionsOf(argo)).toBe(before);
  });
});

describe("Flagger", () => {
  it("udp-driven CANARY: Canary có ba gate về Service 3 mang token của session, KHÔNG metrics; rồi patch image Deployment", async () => {
    const res = await create(flagger, { controlMode: "udp-driven" }).expect(
      201,
    );
    const id = res.body.rollout.id as string;
    const cluster = clusters.get(flagger.projectId) as FakeCluster;
    const canary = cluster.get(canaryRef(flagger)) as {
      spec: { analysis: { metrics: unknown[]; webhooks: Json[] } };
    };
    expect(canary.spec.analysis.metrics).toEqual([]);
    expect(canary.spec.analysis.webhooks).toEqual(
      ["confirm-traffic-increase", "confirm-promotion", "rollback"].map(
        (type) => ({
          name: `udp-${type}`,
          type,
          url: `${GATE_URL}/webhooks/flagger/${id}/${type}`,
          timeout: "10s",
          metadata: {
            token: flaggerGateToken(env.INTERNAL_SERVICE_SECRET, id),
          },
        }),
      ),
    );
    const deployment = cluster.get(deploymentRef(flagger)) as {
      spec: { template: typeof template };
    };
    expect(deployment.spec.template.spec.containers[0]?.image).toBe(
      "ghcr.io/acme/web:v2",
    );
    expect(
      cluster.writes.map((w) => [w.verb, w.path.split("/").at(-2)]),
    ).toEqual([
      ["apply", "canaries"],
      ["patch", "deployments"],
    ]);
  });

  it("Canary chưa khởi tạo xong ⇒ 409, không session, không ghi; BLUE_GREEN ⇒ 422 chỉ sang Argo", async () => {
    const cluster = clusters.get(flagger.projectId) as FakeCluster;
    cluster.setStatus(canaryRef(flagger), { phase: "Initializing" });
    const before = await sessionsOf(flagger);
    await create(flagger, { controlMode: "udp-driven" }).expect(409);
    expect(await sessionsOf(flagger)).toBe(before);
    expect(cluster.writes).toEqual([]);

    const bg = await create(flagger, { strategy: "BLUE_GREEN" }).expect(422);
    expect(bg.body.detail).toMatch(/Argo Rollouts/);
  });
});

describe("kiểm trước khi chạm cluster", () => {
  it("không có tool giao hàng ⇒ 422 MISSING_CAPABILITY; stepPercent lẻ, thiếu trafficMatch, cùng phiên bản ⇒ 422", async () => {
    const missing = await create(bare, {}).expect(422);
    expect(missing.body.code).toBe("MISSING_CAPABILITY");

    await create(argo, { stepPercent: 12.5 }).expect(422);
    await create(argo, {
      strategy: "ATTRIBUTE_SPLIT",
      controlMode: "udp-driven",
    }).expect(422);
    const same = await create(argo, {
      controlMode: "udp-driven",
      imageTag: "v1",
    }).expect(422);
    expect(same.body.detail).toMatch(/đúng phiên bản/);
    expect(clusters.get(argo.projectId)?.writes).toEqual([]);
  });
});

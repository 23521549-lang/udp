import type { ObjectRef } from "@udp/adapter-core";
import { FakeCluster } from "@udp/cluster-access/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ClusterAccessProvider } from "../src/cluster-access/provider.js";
import { HEADER_ROUTE } from "../src/delivery/drivers.js";
import { testController, type TestController } from "./helpers/controller.js";
import {
  admin,
  dropProject,
  executionEvents,
  newIntent,
  newProject,
  newServiceSession,
  sessionState,
} from "./helpers/fixture.js";

/**
 * Nhánh SERVICE_LEVEL của reconciler (§7.3, §8.5) [Plan #51 AC-6] — database thật, cụm GIẢ (`FakeCluster` ghi lại
 * mọi lời ghi kèm identity). "Controller" của Argo/Flagger là test: nó đổi `status` như công cụ thật đổi, và không
 * tính là lời ghi của UDP.
 */

type Json = Record<string, unknown>;

let project: Awaited<ReturnType<typeof newProject>>;
let namespace: string;

const STEPS = [20, 40, 60, 80].flatMap((w) => [
  { setWeight: w },
  { pause: {} },
]);

const ref = (apiVersion: string, kind: string, name = "web"): ObjectRef => ({
  apiVersion,
  kind,
  namespace,
  name,
});
const ROLLOUT = () => ref("argoproj.io/v1alpha1", "Rollout");
const CANARY = () => ref("flagger.app/v1beta1", "Canary");
const VS = () => ref("networking.istio.io/v1beta1", "VirtualService");

function world(): { cluster: FakeCluster; c: TestController } {
  const cluster = new FakeCluster();
  const clusters: ClusterAccessProvider = {
    get: () => Promise.resolve(cluster.access()),
    forget: () => undefined,
  };
  const c = testController("http://127.0.0.1:9", { clusters });
  c.provider.set("v2", { requests: 3_000, errors: 12, p99Ms: 250 });
  c.provider.set("v1", { requests: 27_000, errors: 81, p99Ms: 240 });
  return { cluster, c };
}

function seedRollout(cluster: FakeCluster, steps: Json[] = STEPS): void {
  cluster.seed(ROLLOUT(), {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Rollout",
    metadata: { name: "web", namespace, generation: 2 },
    spec: {
      strategy: {
        canary: {
          steps,
          canaryService: "web-canary",
          trafficRouting: {
            istio: { virtualService: { name: "web", routes: ["primary"] } },
          },
        },
      },
    },
    // Trạng thái của lượt TRƯỚC — controller chưa thấy spec mới
    status: {
      observedGeneration: "1",
      phase: "Healthy",
      stableRS: "old",
      currentPodHash: "old",
    },
  });
}

/** Controller Argo: dừng ở bậc `index` */
const argoPausedAt = (cluster: FakeCluster, index: number, weight: number) => {
  cluster.setStatus(ROLLOUT(), {
    observedGeneration: "2",
    phase: "Paused",
    currentStepIndex: index,
    pauseConditions: [{ reason: "CanaryPauseStep" }],
    currentPodHash: "new",
    stableRS: "old",
    canary: { weights: { canary: { weight } } },
  });
};

const argoDone = (cluster: FakeCluster) => {
  cluster.setStatus(ROLLOUT(), {
    observedGeneration: "2",
    phase: "Healthy",
    pauseConditions: null,
    currentStepIndex: 8,
    stableRS: "new",
    currentPodHash: "new",
  });
};

/** Qua nhịp phân tích và dwell (300 s), cửa sổ metric đã nằm trọn sau bậc */
const later = (c: TestController, seconds = 301) => {
  c.clock.advance(seconds * 1_000);
};

beforeAll(async () => {
  project = await newProject();
  const env = await admin.environment.findUniqueOrThrow({
    where: { id: project.environmentId },
    select: { k8sNamespace: true },
  });
  namespace = env.k8sNamespace;
}, 60_000);

/** Mọi ca dùng cùng workload `web`: đóng session còn sống — chỉ mục "một rollout sống mỗi workload" */
afterEach(async () => {
  await admin.$executeRaw`UPDATE rollout_sessions SET status = 'DONE' WHERE project_id = ${project.projectId}::uuid AND status IN ('PENDING','IN_PROGRESS','PAUSED')`;
});

afterAll(async () => {
  await dropProject(project.projectId);
  await admin.$disconnect();
});

describe("Argo Rollouts — udp-driven CANARY", () => {
  it("chờ controller → soi gương bậc đầu → promote ĐÚNG MỘT bậc qua rollouts/status → xong ⇒ DONE + DEPLOY_SUCCESS", async () => {
    const { cluster, c } = world();
    seedRollout(cluster);
    const id = await newServiceSession(project);

    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).status).toBe("PENDING");
    expect((await sessionState(id)).lastDecision?.reason).toMatch(
      /Chờ Argo Rollouts/,
    );

    argoPausedAt(cluster, 1, 20);
    later(c, 31);
    await c.reconciler.reconcileOne(id);
    expect(await sessionState(id)).toMatchObject({
      status: "IN_PROGRESS",
      currentTrafficPercentage: 20,
    });

    later(c);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).currentTrafficPercentage).toBe(40);
    const writes = cluster.writesBy("traffic");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(
      `/apis/argoproj.io/v1alpha1/namespaces/${namespace}/rollouts/web/status`,
    );
    expect(writes[0]?.body).toMatchObject({
      metadata: { resourceVersion: expect.any(String) },
      status: { pauseConditions: null },
    });

    // Controller CHƯA kịp chuyển bậc (đang chạy): không soi gương lùi, không promote thêm
    cluster.setStatus(ROLLOUT(), {
      phase: "Progressing",
      pauseConditions: null,
      currentStepIndex: 2,
    });
    later(c);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).currentTrafficPercentage).toBe(40);
    expect(cluster.writesBy("traffic")).toHaveLength(1);

    argoDone(cluster);
    later(c, 31);
    await c.reconciler.reconcileOne(id);
    expect(await sessionState(id)).toMatchObject({
      status: "DONE",
      currentTrafficPercentage: 100,
    });
    expect((await executionEvents(id)).map((e) => e.action)).toEqual([
      "PROMOTE",
      "PROMOTE",
      "COMPLETE",
    ]);
    const deploys = await admin.deploymentEvent.findMany({
      where: { rolloutSessionId: id },
      select: { eventType: true, deploymentId: true, imageTag: true },
    });
    expect(deploys).toEqual([
      { eventType: "DEPLOY_SUCCESS", deploymentId: id, imageTag: "v2" },
    ]);
  });

  it("vượt ngưỡng ⇒ bỏ pause TRƯỚC rồi abort; FAILED AUTO_ROLLBACK, DEPLOY_FAILURE + ROLLBACK trỏ lần deploy", async () => {
    const { cluster, c } = world();
    seedRollout(cluster);
    const id = await newServiceSession(project, {
      thresholds: { maxConsecutiveBreaches: 1 },
    });
    argoPausedAt(cluster, 1, 20);
    await c.reconciler.reconcileOne(id);
    c.provider.set("v2", { requests: 3_000, errors: 210, p99Ms: 250 });
    later(c);
    await c.reconciler.reconcileOne(id);

    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "AUTO_ROLLBACK",
      currentTrafficPercentage: 0,
    });
    expect(cluster.writesBy("traffic").map((w) => w.body)).toEqual([
      { status: { pauseConditions: null } },
      { status: { abort: true } },
    ]);
    const deploys = await admin.deploymentEvent.findMany({
      where: { rolloutSessionId: id },
      select: { eventType: true, restoresDeploymentId: true },
      orderBy: { occurredAt: "asc" },
    });
    expect(deploys).toEqual([
      { eventType: "DEPLOY_FAILURE", restoresDeploymentId: null },
      { eventType: "ROLLBACK", restoresDeploymentId: id },
    ]);
  });
});

describe("I5 — tool-driven: Service 3 không ghi gì lên cluster", () => {
  it("10 vòng trên Rollout tool-driven đang chạy: 0 lời ghi, session soi gương tới DONE", async () => {
    const { cluster, c } = world();
    seedRollout(cluster);
    const id = await newServiceSession(project, { controlMode: "TOOL_DRIVEN" });
    const plan: (() => void)[] = [
      () => undefined,
      ...[20, 40, 60, 80].flatMap((w, i) => [
        () => {
          cluster.setStatus(ROLLOUT(), {
            observedGeneration: "2",
            phase: "Progressing",
            currentStepIndex: 2 * i,
            currentPodHash: "new",
            stableRS: "old",
            canary: { weights: { canary: { weight: w } } },
          });
        },
        () => undefined,
      ]),
      () => {
        argoDone(cluster);
      },
    ];
    for (const step of plan) {
      step();
      later(c, 31);
      await c.reconciler.reconcileOne(id);
    }
    expect(plan).toHaveLength(10);
    expect(cluster.writes).toEqual([]);
    expect((await sessionState(id)).status).toBe("DONE");
  });

  it("Flagger tool-driven: 0 lời ghi; PROMOTE bị từ chối kèm lý do (Flagger không có API promote)", async () => {
    const { cluster, c } = world();
    cluster.seed(CANARY(), {
      apiVersion: "flagger.app/v1beta1",
      kind: "Canary",
      metadata: { name: "web", namespace },
      status: { phase: "Progressing", canaryWeight: 10 },
    });
    const id = await newServiceSession(project, { controlMode: "TOOL_DRIVEN" });
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).currentTrafficPercentage).toBe(10);

    await newIntent(id, "PROMOTE", project.ownerId);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).lastDecision?.reason).toMatch(
      /không có API promote/,
    );
    cluster.setStatus(CANARY(), {
      phase: "Succeeded",
      lastTransitionTime: new Date(Date.now() + 1_000).toISOString(),
    });
    later(c, 31);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).status).toBe("DONE");
    expect(cluster.writes).toEqual([]);
  });
});

describe("ý định của người dùng", () => {
  it("tool-driven Argo: PAUSE bị từ chối; PROMOTE ⇒ promote-full qua status — lời ghi DUY NHẤT", async () => {
    const { cluster, c } = world();
    seedRollout(cluster);
    const id = await newServiceSession(project, { controlMode: "TOOL_DRIVEN" });
    argoPausedAt(cluster, 1, 20);
    await c.reconciler.reconcileOne(id);

    await newIntent(id, "PAUSE", project.ownerId);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).lastDecision?.reason).toMatch(
      /quyền status/,
    );

    await newIntent(id, "PROMOTE", project.ownerId);
    await c.reconciler.reconcileOne(id);
    expect(cluster.writesBy("traffic").map((w) => w.body)).toEqual([
      { status: { promoteFull: true, pauseConditions: null } },
    ]);
    expect((await executionEvents(id)).at(-1)).toMatchObject({
      action: "PROMOTE",
      triggeredBy: "MANUAL",
    });
  });

  it("Flagger udp-driven: PROMOTE của phân tích chỉ ghi quyết định cho gate (0 lời ghi); ROLLBACK ⇒ FAILED MANUAL", async () => {
    const { cluster, c } = world();
    cluster.seed(CANARY(), {
      apiVersion: "flagger.app/v1beta1",
      kind: "Canary",
      metadata: { name: "web", namespace },
      status: { phase: "Progressing", canaryWeight: 20 },
    });
    const id = await newServiceSession(project);
    await c.reconciler.reconcileOne(id);
    later(c);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).lastDecision?.decision).toBe("PROMOTE");
    expect(cluster.writes).toEqual([]);

    await newIntent(id, "ROLLBACK", project.ownerId);
    await c.reconciler.reconcileOne(id);
    expect(await sessionState(id)).toMatchObject({
      status: "FAILED",
      failReason: "MANUAL",
    });
    expect(cluster.writes).toEqual([]);
  });
});

describe("ATTRIBUTE_SPLIT udp-driven (Argo + Istio)", () => {
  it("route header đứng TRƯỚC route của Argo; không tự quyết; PROMOTE ⇒ gỡ route rồi promote-full", async () => {
    const { cluster, c } = world();
    seedRollout(cluster, [{ setCanaryScale: { replicas: 1 } }, { pause: {} }]);
    cluster.seed(VS(), {
      apiVersion: "networking.istio.io/v1beta1",
      kind: "VirtualService",
      metadata: { name: "web", namespace },
      spec: {
        http: [{ name: "primary", route: [{ destination: { host: "web" } }] }],
      },
    });
    const id = await newServiceSession(project, {
      strategy: "ATTRIBUTE_SPLIT",
      trafficMatch: { header: "X-Beta", value: "1" },
    });
    argoPausedAt(cluster, 1, 0);
    await c.reconciler.reconcileOne(id);
    expect((await sessionState(id)).status).toBe("IN_PROGRESS");
    later(c);
    await c.reconciler.reconcileOne(id);

    const http = () =>
      (cluster.get(VS()) as { spec: { http: Json[] } }).spec.http;
    expect(http()[0]).toEqual({
      name: HEADER_ROUTE,
      match: [{ headers: { "x-beta": { exact: "1" } } }],
      route: [{ destination: { host: "web-canary" }, weight: 100 }],
    });
    expect(http()[1]).toMatchObject({ name: "primary" });
    expect((await sessionState(id)).lastDecision?.reason).toMatch(
      /không tự quyết/,
    );

    await newIntent(id, "PROMOTE", project.ownerId);
    await c.reconciler.reconcileOne(id);
    expect(http().map((r) => r["name"])).toEqual(["primary"]);
    expect(cluster.writesBy("traffic").at(-1)?.body).toEqual({
      status: { promoteFull: true, pauseConditions: null },
    });
  });
});

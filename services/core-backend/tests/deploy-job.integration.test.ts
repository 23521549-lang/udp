import { randomUUID } from "node:crypto";
import type { KubernetesClient, ObjectRef } from "@udp/adapter-core";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/core/db.js";
import type { BossJobState } from "../src/jobs/boss.js";
import {
  createDeployJob,
  pendingStartOf,
  watchDeploy,
  type DeployStart,
  type DeployWatchOptions,
} from "../src/jobs/deploy.job.js";
import { createJobKit } from "../src/jobs/job-kit.js";
import { reconcileDeploys } from "../src/jobs/reconcile.js";
import { ClusterCallFailedError } from "@udp/cluster-access";
import type { WorkloadState } from "../src/modules/cicd/workload.js";
import { testWorld, type Actor, type TestWorld } from "./helpers/api.js";
import { inertCloudPlatform, noDomainAdapters } from "./helpers/inert-deps.js";

/**
 * Plan #36 AC-4, AC-6 — job deploy trên Event Store THẬT, ghi bằng `udp_s1` (GRANT thật), với một
 * client Kubernetes giả mang đúng ngữ nghĩa mà API server áp cho `patch` của `ClusterAccess`: JSON
 * merge patch (mảng bị THAY CẢ) và điều kiện `metadata.resourceVersion` (409 khi lệch). Nhờ vậy
 * một patch làm mất trường của container là test đỏ, không phải một lời hứa trong chú thích.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_deploy_job_admin",
});

let world: TestWorld;
let owner: Actor;
let projectId: string;
let devId: string;
let namespace: string;

const OPTIONS: DeployWatchOptions = {
  pollMs: 1,
  defaultProgressDeadlineSeconds: 600,
  maxWatchSeconds: 0.02,
  sleep: () => Promise.resolve(),
};

beforeAll(async () => {
  world = testWorld(createApp(), admin);
  owner = await world.newActor("deploy-job-owner");
  const created = await world.newProject(owner);
  projectId = created.projectId;
  const dev = created.envs.dev;
  if (dev === undefined) throw new Error("thiếu env dev");
  devId = dev.id;
  namespace = dev.k8sNamespace;
}, 60_000);

afterAll(async () => {
  await admin.deploymentEvent.deleteMany({ where: { projectId } });
  await world.cleanup();
  await admin.$disconnect();
});

/** Một `DEPLOY_START` như webhook ghi — trả `deploymentId` */
async function started(
  over: { imageRef?: string | null; occurredAt?: Date } = {},
): Promise<string> {
  const deploymentId = randomUUID();
  await admin.deploymentEvent.create({
    data: {
      projectId,
      environmentId: devId,
      deploymentId,
      eventType: "DEPLOY_START",
      workloadName: "web",
      pipelineId: `run-${deploymentId.slice(0, 8)}`,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      commitTimestamp: new Date("2026-09-26T01:00:00Z"),
      imageTag: "new",
      triggeredBy: "WEBHOOK",
      ...(over.occurredAt === undefined ? {} : { occurredAt: over.occurredAt }),
      metadata:
        over.imageRef === null
          ? { provider: "github-actions" }
          : { imageRef: over.imageRef ?? "ghcr.io/acme/web:new" },
    },
  });
  return deploymentId;
}

async function startOf(deploymentId: string): Promise<DeployStart> {
  const start = await pendingStartOf(prisma, deploymentId);
  if (start === null) throw new Error("START phải còn chưa kết luận");
  return start;
}

const eventsOf = (deploymentId: string) =>
  admin.deploymentEvent.findMany({
    where: { deploymentId },
    orderBy: { occurredAt: "asc" },
  });

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** RFC 7386 — mảng và giá trị vô hướng bị THAY, `null` xoá khoá */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const out: Json = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/**
 * Workload giả: `evolve` là controller — nó thấy trạng thái sau mỗi lần đọc. `interfere` chạy
 * trước lần ghi thứ n (ai đó sửa workload giữa lúc đọc và lúc ghi).
 */
class FakeWorkload implements KubernetesClient {
  patches: Json[] = [];
  private version = 100;

  constructor(
    private readonly kind: "Deployment" | "Rollout" | null,
    public state: WorkloadState,
    private readonly evolve: (s: WorkloadState) => WorkloadState = (s) => s,
    private readonly interfere: (attempt: number) => boolean = () => false,
  ) {
    this.state.metadata = {
      ...this.state.metadata,
      generation: 1,
      resourceVersion: String(this.version),
    };
  }

  read<T>(_verb: string, ref: ObjectRef): Promise<T | null> {
    if (ref.kind !== this.kind) return Promise.resolve(null);
    this.state = this.evolve(this.state);
    return Promise.resolve(structuredClone(this.state) as T);
  }

  private attempts = 0;

  write(_verb: string, _ref: ObjectRef, body?: unknown): Promise<void> {
    this.attempts += 1;
    if (this.interfere(this.attempts)) this.bump();
    const wanted = (body as { metadata?: { resourceVersion?: string } })
      .metadata?.resourceVersion;
    if (wanted !== this.state.metadata?.resourceVersion) {
      return Promise.reject(new ClusterCallFailedError(409, "patch", "/x"));
    }
    this.patches.push(body as Json);
    // `resourceVersion` là điều kiện; `annotations` thì API server áp như mọi trường khác
    const { metadata, ...rest } = body as Json;
    const annotations = isObject(metadata)
      ? metadata["annotations"]
      : undefined;
    this.state = mergePatch(
      this.state,
      annotations === undefined ? rest : { ...rest, metadata: { annotations } },
    ) as WorkloadState;
    this.bump();
    return Promise.resolve();
  }

  private bump(): void {
    this.version += 1;
    this.state.metadata = {
      ...this.state.metadata,
      generation: (this.state.metadata?.generation ?? 0) + 1,
      resourceVersion: String(this.version),
    };
  }

  image(): string | undefined {
    return this.state.spec?.template?.spec?.containers?.find(
      (c) => c.name === "web",
    )?.image;
  }
}

const deployment = (image = "ghcr.io/acme/web:old"): WorkloadState => ({
  spec: {
    replicas: 2,
    template: {
      spec: {
        containers: [
          {
            name: "web",
            image,
            ports: [{ containerPort: 8080 }],
            env: [{ name: "OTEL_SERVICE_NAME", value: "web" }],
          },
        ],
      },
    },
  },
  status: {
    observedGeneration: 1,
    replicas: 2,
    updatedReplicas: 2,
    availableReplicas: 2,
  },
});

/** Controller khoẻ: quan sát generation mới ở lượt đọc kế tiếp, mọi bản lên */
const healthy = (s: WorkloadState): WorkloadState => ({
  ...s,
  status: {
    observedGeneration: s.metadata?.generation ?? 0,
    replicas: 2,
    updatedReplicas: 2,
    availableReplicas: 2,
  },
});

/** Controller báo quá hạn ngay khi thấy generation mới — ảnh không kéo được */
const stuckOn =
  (badImage: string) =>
  (s: WorkloadState): WorkloadState =>
    s.spec?.template?.spec?.containers?.[0]?.image === badImage
      ? {
          ...s,
          status: {
            observedGeneration: s.metadata?.generation ?? 0,
            conditions: [
              {
                type: "Progressing",
                status: "False",
                reason: "ProgressDeadlineExceeded",
              },
            ],
          },
        }
      : healthy(s);

describe("job deploy (AC-4)", () => {
  it("thành công ⇒ START + SUCCESS cùng deploymentId; commit mang sang SUCCESS; container giữ nguyên trường", async () => {
    const id = await started();
    const cluster = new FakeWorkload("Deployment", deployment(), healthy);
    expect(await watchDeploy(prisma, cluster, await startOf(id), OPTIONS)).toBe(
      "success",
    );

    const events = await eventsOf(id);
    expect(events.map((e) => e.eventType)).toEqual([
      "DEPLOY_START",
      "DEPLOY_SUCCESS",
    ]);
    // Lead time của DORA đọc commitTimestamp ở sự kiện kết luận
    expect(events[1]?.commitTimestamp?.toISOString()).toBe(
      "2026-09-26T01:00:00.000Z",
    );
    expect(events[1]?.pipelineId).toBe(events[0]?.pipelineId);

    expect(cluster.patches).toHaveLength(1);
    const container = cluster.state.spec?.template?.spec?.containers?.[0];
    expect(container).toEqual({
      name: "web",
      image: "ghcr.io/acme/web:new",
      ports: [{ containerPort: 8080 }],
      env: [{ name: "OTEL_SERVICE_NAME", value: "web" }],
    });
    expect(cluster.state.spec?.template?.spec?.imagePullSecrets).toEqual([
      { name: "udp-registry-pull" },
    ]);
    // I25: S1 không ghi chiến lược, số bản hay trạng thái
    expect(JSON.stringify(cluster.patches)).not.toMatch(
      /strategy|replicas|status|progressDeadline/,
    );
  });

  it("worker thứ hai chạy lại cùng lần deploy ⇒ vẫn MỘT SUCCESS; đã kết luận thì không còn việc", async () => {
    const id = await started();
    const start = await startOf(id);
    const cluster = new FakeWorkload("Deployment", deployment(), healthy);
    await Promise.all([
      watchDeploy(prisma, cluster, start, OPTIONS),
      watchDeploy(prisma, cluster, start, OPTIONS),
    ]);
    const types = (await eventsOf(id)).map((e) => e.eventType);
    expect(types.filter((t) => t === "DEPLOY_SUCCESS")).toHaveLength(1);
    expect(await pendingStartOf(prisma, id)).toBeNull();
  });

  it("quá hạn ⇒ hoàn tác về ảnh cũ + FAILURE + ROLLBACK trỏ về lần deploy", async () => {
    const id = await started();
    const cluster = new FakeWorkload(
      "Deployment",
      deployment(),
      stuckOn("ghcr.io/acme/web:new"),
    );
    expect(await watchDeploy(prisma, cluster, await startOf(id), OPTIONS)).toBe(
      "failure",
    );
    expect(cluster.image()).toBe("ghcr.io/acme/web:old");
    expect(cluster.patches).toHaveLength(2);

    const events = await eventsOf(id);
    expect(events.map((e) => e.eventType)).toEqual([
      "DEPLOY_START",
      "DEPLOY_FAILURE",
      "ROLLBACK",
    ]);
    expect(events[2]).toMatchObject({
      restoresDeploymentId: id,
      triggeredBy: "AUTO",
      metadata: { restoredImage: "ghcr.io/acme/web:old" },
    });
  });

  it("không bao giờ xong và không có điều kiện quá hạn ⇒ hết số nhịp thì hoàn tác", async () => {
    const id = await started();
    const cluster = new FakeWorkload("Deployment", deployment());
    expect(await watchDeploy(prisma, cluster, await startOf(id), OPTIONS)).toBe(
      "failure",
    );
    expect(cluster.image()).toBe("ghcr.io/acme/web:old");
  });

  it("workload chưa có ⇒ FAILURE, không ghi gì lên cluster, không ROLLBACK", async () => {
    const id = await started();
    const cluster = new FakeWorkload(null, deployment());
    expect(await watchDeploy(prisma, cluster, await startOf(id), OPTIONS)).toBe(
      "failure",
    );
    expect(cluster.patches).toEqual([]);
    const events = await eventsOf(id);
    expect(events.map((e) => e.eventType)).toEqual([
      "DEPLOY_START",
      "DEPLOY_FAILURE",
    ]);
    expect(JSON.stringify(events[1]?.metadata)).toContain("chưa tồn tại");
  });

  it("workload không có container cùng tên ⇒ FAILURE, không thêm container mới", async () => {
    const id = await started();
    const state = deployment();
    state.spec!.template!.spec!.containers![0]!.name = "api";
    const cluster = new FakeWorkload("Deployment", state, healthy);
    expect(await watchDeploy(prisma, cluster, await startOf(id), OPTIONS)).toBe(
      "failure",
    );
    expect(cluster.patches).toEqual([]);
  });

  it("Rollout của Argo Rollouts: không có Deployment cùng tên ⇒ tra Rollout, Healthy là xong", async () => {
    const id = await started();
    const cluster = new FakeWorkload("Rollout", deployment(), (s) => ({
      ...s,
      status: {
        observedGeneration: String(s.metadata?.generation ?? 0),
        phase: "Healthy",
      },
    }));
    expect(await watchDeploy(prisma, cluster, await startOf(id), OPTIONS)).toBe(
      "success",
    );
  });

  it("ai đó sửa workload giữa lúc đọc và ghi ⇒ 409 ⇒ đọc lại và ghi trên bản mới", async () => {
    const id = await started();
    const cluster = new FakeWorkload(
      "Deployment",
      deployment(),
      healthy,
      (attempt) => attempt === 1,
    );
    expect(await watchDeploy(prisma, cluster, await startOf(id), OPTIONS)).toBe(
      "success",
    );
    expect(cluster.patches).toHaveLength(1);
  });

  it("lượt thử lại (ảnh mới đã áp) ⇒ hoàn tác về ảnh của lần SUCCESS gần nhất cùng workload", async () => {
    // Lần trước thành công với ảnh v1
    const earlier = await started({ imageRef: "ghcr.io/acme/web:v1" });
    await watchDeploy(
      prisma,
      new FakeWorkload(
        "Deployment",
        deployment("ghcr.io/acme/web:v0"),
        healthy,
      ),
      await startOf(earlier),
      OPTIONS,
    );
    const id = await started({ imageRef: "ghcr.io/acme/web:hong" });
    const cluster = new FakeWorkload(
      "Deployment",
      deployment("ghcr.io/acme/web:hong"),
      stuckOn("ghcr.io/acme/web:hong"),
    );
    await watchDeploy(prisma, cluster, await startOf(id), OPTIONS);
    expect(cluster.image()).toBe("ghcr.io/acme/web:v1");
  });

  it("START hỏng (không có ảnh) ⇒ kết luận FAILURE ngay, không còn việc cho đối soát", async () => {
    const id = await started({ imageRef: null });
    expect(await pendingStartOf(prisma, id)).toBeNull();
    expect((await eventsOf(id)).map((e) => e.eventType)).toEqual([
      "DEPLOY_START",
      "DEPLOY_FAILURE",
    ]);
  });

  it("project chưa có cluster ⇒ lỗi vĩnh viễn, kết luận ngay dù chưa phải lượt cuối", async () => {
    const id = await started();
    const kit = createJobKit({
      prisma,
      platform: inertCloudPlatform,
      domainRegistry: noDomainAdapters,
      clusters: {} as never,
      egressFetch: fetch,
      workerId: "deploy-test",
      lease: { leaseMs: 1_000, renewIntervalMs: 500, errorRetryMs: 100 },
    });
    await createDeployJob(kit, OPTIONS).run(id, { final: false });
    const events = await eventsOf(id);
    expect(events.map((e) => e.eventType)).toEqual([
      "DEPLOY_START",
      "DEPLOY_FAILURE",
    ]);
    expect(JSON.stringify(events[1]?.metadata)).toContain("chưa có cluster");
  });

  it("[Plan #51 QĐ-10] workload đang có rollout SERVICE_LEVEL ⇒ FAILURE kèm lý do, KHÔNG patch — deploy thường không cướp canary", async () => {
    const session = await admin.rolloutSession.create({
      data: {
        projectId,
        environmentId: devId,
        workloadName: "web",
        rolloutScope: "SERVICE_LEVEL",
        strategy: "CANARY",
        controlMode: "UDP_DRIVEN",
        status: "IN_PROGRESS",
        thresholds: {},
        stepPercent: 20,
        createdById: owner.userId,
      },
      select: { id: true },
    });
    try {
      const id = await started();
      const cluster = new FakeWorkload("Deployment", deployment(), healthy);
      expect(
        await watchDeploy(prisma, cluster, await startOf(id), OPTIONS),
      ).toBe("failure");
      expect(cluster.patches).toEqual([]);
      const events = await eventsOf(id);
      expect(JSON.stringify(events[1]?.metadata)).toContain(session.id);
    } finally {
      await admin.rolloutSession.update({
        where: { id: session.id },
        data: { status: "DONE" },
      });
    }
  });

  it("[Plan #51 QĐ-10] Rollout sau session UDP: lần ghi image trả strategy về bản gốc và bỏ chú thích của session", async () => {
    const base = {
      canary: {
        stableService: "web",
        trafficRouting: { istio: { virtualService: { name: "web" } } },
        steps: [{ setWeight: 50 }],
      },
    };
    const id = await started();
    const rollout: WorkloadState = {
      ...deployment(),
      metadata: {
        annotations: {
          "udp.io/session-id": randomUUID(),
          "udp.io/control-mode": "udp-driven",
          "udp.io/strategy": "BLUE_GREEN",
          "udp.io/previous-strategy": JSON.stringify(base),
        },
      },
    };
    rollout.spec = {
      ...rollout.spec,
      strategy: {
        blueGreen: { activeService: "web", previewService: "web-preview" },
      },
    };
    const cluster = new FakeWorkload("Rollout", rollout, (s) => ({
      ...s,
      status: {
        observedGeneration: s.metadata?.generation ?? 0,
        phase: "Healthy",
      },
    }));
    expect(await watchDeploy(prisma, cluster, await startOf(id), OPTIONS)).toBe(
      "success",
    );
    expect(cluster.patches).toHaveLength(1);
    expect(cluster.state.spec?.strategy).toEqual(base);
    expect(cluster.state.metadata?.annotations).toEqual({
      "udp.io/previous-strategy": JSON.stringify(base),
    });
    expect(cluster.image()).toBe("ghcr.io/acme/web:new");
  });
});

describe("đối soát deploy (QĐ-5)", () => {
  it("START cũ mà pg-boss chưa nhận ⇒ gửi lại; pg-boss đã bỏ ⇒ FAILURE; START mới ⇒ chưa chạm", async () => {
    const old = new Date(Date.now() - 5 * 60_000);
    const neverSent = await started({ occurredAt: old });
    const gaveUp = await started({ occurredAt: old });
    const fresh = await started();
    const sent: string[] = [];
    const outcome = await reconcileDeploys(prisma, {
      deployStateOf: (id): Promise<BossJobState | null> =>
        Promise.resolve(id === gaveUp ? "failed" : null),
      enqueueDeploy: (id) => {
        sent.push(id);
        return Promise.resolve();
      },
    });
    expect(outcome.resent).toContain(neverSent);
    expect(sent).toContain(neverSent);
    expect(outcome.abandoned).toContain(gaveUp);
    expect(sent).not.toContain(fresh);
    expect((await eventsOf(gaveUp)).map((e) => e.eventType)).toEqual([
      "DEPLOY_START",
      "DEPLOY_FAILURE",
    ]);
  });
});

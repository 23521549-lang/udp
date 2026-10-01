import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import { CLOUD_ERROR_SLUGS } from "@udp/shared-types/cloud-api";
import { PROVISION_ERROR_SLUGS } from "@udp/shared-types/provisioning-api";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import type { ProvisioningRuntime } from "../src/core/app-deps.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";
import { simCloudPlatform } from "./helpers/cloud-platform.js";
import {
  noRepoSource,
  inertProvisioning,
  noDomainAdapters,
  outsidePlatform,
  noExternalAuth,
} from "./helpers/inert-deps.js";

/**
 * Provisioning qua HTTP (Plan #28 P5: AC-7, AC-8) trên database thật; cloud là kế hoạch AWS
 * thật qua cổng mô phỏng. Hàng đợi là cổng ghi lại id — worker có test riêng.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_provisioning_test_admin",
});

const enqueued: string[] = [];
const provisioning: ProvisioningRuntime = {
  egressCidrs: ["203.0.113.0/24"],
  enqueue: (jobId) => {
    enqueued.push(jobId);
    return Promise.resolve();
  },
  enqueueDeploy: null,
  withCluster: null,
  scanDrift: null,
  clusterToken: null,
  flaggerGateBaseUrl: null,
};

const appWith = (runtime: ProvisioningRuntime) =>
  createApp({
    metricsFor: () => new FakeMetricsProvider(),
    flagService: createFlagServiceClient({
      baseUrl: "http://127.0.0.1:9",
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
    oidcIssuer: null,
    cloud: simCloudPlatform(),
    repoSource: noRepoSource,
    platform: outsidePlatform,
    auth: noExternalAuth,
    domainRegistry: noDomainAdapters,
    provisioning: runtime,
  });

let app: ReturnType<typeof createApp>;
let world: TestWorld;
let owner: Actor;
let maintainer: Actor;
let viewer: Actor;
let projectId: string;

const url = (path: string, pid = projectId) => `${API}/projects/${pid}${path}`;
const putCloud = (pid = projectId) =>
  as(
    owner,
    request(app)
      .put(url("/cloud", pid))
      .send({
        mode: "BYOC",
        provider: "AWS",
        region: "ap-southeast-1",
        credential: {
          authKind: "AWS_KEY",
          accessKeyId: "AKIAEXAMPLEEXAMPLE12",
          secretAccessKey: "bi-mat-cua-khach-trong-test-p5",
        },
      }),
  );
const postProvision = (actor: Actor, body: object, key?: string) => {
  const req = request(app).post(url("/provision")).send(body);
  return as(actor, key === undefined ? req : req.set("Idempotency-Key", key));
};

beforeAll(async () => {
  app = appWith(provisioning);
  world = testWorld(app, admin);
  owner = await world.newActor("prov-owner");
  maintainer = await world.newActor("prov-maint");
  viewer = await world.newActor("prov-viewer");
  ({ projectId } = await world.newProject(owner));
  await world.addMember(owner, projectId, maintainer, "MAINTAINER");
  await world.addMember(owner, projectId, viewer, "VIEWER");
});

afterAll(async () => {
  await world.cleanup();
  await admin.$disconnect();
});

describe("GET /preview", () => {
  it("chưa có credential ⇒ 409 cloud-not-configured", async () => {
    const res = await as(owner, request(app).get(url("/preview"))).expect(409);
    expect(res.body.type).toContain(CLOUD_ERROR_SLUGS.notConfigured);
  });

  it("có credential chưa kiểm ⇒ chi phí ba mục bắt buộc, thứ tự bước, lý do chặn", async () => {
    await putCloud().expect(200);
    const res = await as(maintainer, request(app).get(url("/preview"))).expect(
      200,
    );
    const { preview } = res.body;
    expect(preview.provider).toBe("AWS");
    expect(
      (preview.cost.breakdown as { item: string }[]).map((b) => b.item),
    ).toEqual(
      expect.arrayContaining(["control-plane", "nat-gateway", "load-balancer"]),
    );
    expect(preview.steps.network[0]).toBe("vpc");
    expect(preview.steps.cluster).toContain("cluster");
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.blockers).toEqual(["cloud-not-validated"]);
  });

  it("VIEWER không xem được chi phí", async () => {
    await as(viewer, request(app).get(url("/preview"))).expect(403);
  });

  it("triển khai chưa có dải egress ⇒ lý do chặn riêng", async () => {
    const res = await as(
      owner,
      request(appWith(inertProvisioning)).get(url("/preview")),
    ).expect(200);
    expect(res.body.preview.blockers).toContain("egress-not-configured");
  });
});

describe("lượt trước còn tài nguyên mồ côi", () => {
  it("hàng ORPHAN_SUSPECTED trong sổ ⇒ lý do chặn orphans-pending", async () => {
    const { projectId: pid } = await world.newProject(owner);
    await putCloud(pid).expect(200);
    const job = await admin.provisioningJob.create({
      data: {
        projectId: pid,
        jobType: "PROVISION",
        state: "COMPENSATION_FAILED",
        payload: {},
      },
      select: { id: true },
    });
    await admin.provisionedResource.create({
      data: {
        jobId: job.id,
        projectId: pid,
        step: "NETWORK",
        kind: "vpc",
        idempotencyKey: `${pid}:NETWORK:vpc:vpc`,
        providerId: "vpc-mo-coi",
        provider: "AWS",
        region: "ap-southeast-1",
        status: "ORPHAN_SUSPECTED",
      },
    });
    const res = await as(owner, request(app).get(url("/preview", pid))).expect(
      200,
    );
    expect(res.body.preview.blockers).toContain("orphans-pending");
    await admin.provisionedResource.deleteMany({ where: { projectId: pid } });
  });
});

describe("POST /provision", () => {
  it("credential chưa kiểm ⇒ 409 provision-blocked", async () => {
    const res = await postProvision(owner, {}).expect(409);
    expect(res.body.type).toContain(PROVISION_ERROR_SLUGS.blocked);
  });

  it("MAINTAINER ⇒ 403 (tiêu tiền của khách là việc của OWNER)", async () => {
    await as(owner, request(app).post(url("/cloud/validate"))).expect(200);
    await postProvision(maintainer, {}).expect(403);
  });

  it("production thiếu hay lệch xác nhận chi phí ⇒ 428", async () => {
    await postProvision(owner, {}).expect(428);
    await postProvision(owner, { confirmedMonthlyUsd: 1 }).expect(428);
  });

  it("đúng con số + Idempotency-Key ⇒ 202 job QUEUED, gửi hàng đợi, project PROVISIONING; gửi lại ⇒ cùng job", async () => {
    const { body } = await as(owner, request(app).get(url("/preview")));
    const confirmed = body.preview.cost.monthlyUsd as number;
    const key = randomUUID();

    const first = await postProvision(
      owner,
      { confirmedMonthlyUsd: confirmed },
      key,
    ).expect(202);
    expect(first.body.job).toMatchObject({
      state: "QUEUED",
      jobType: "PROVISION",
      confirmedMonthlyUsd: confirmed,
      cancellable: true,
    });
    expect(enqueued).toEqual([first.body.job.id]);

    const replay = await postProvision(
      owner,
      { confirmedMonthlyUsd: confirmed },
      key,
    ).expect(202);
    expect(replay.body.job.id).toBe(first.body.job.id);
    expect(enqueued).toHaveLength(1);

    const project = await admin.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { status: true },
    });
    expect(project.status).toBe("PROVISIONING");
  });

  it("đã có job chạy ⇒ khoá khác cũng 409; đổi credential ⇒ 409 cloud-credential-locked", async () => {
    await postProvision(owner, { confirmedMonthlyUsd: 0 }, randomUUID()).expect(
      409,
    );
    const res = await putCloud().expect(409);
    expect(res.body.type).toContain(PROVISION_ERROR_SLUGS.credentialLocked);
  });
});

describe("jobs", () => {
  const jobId = async (): Promise<string> => {
    const res = await as(viewer, request(app).get(url("/jobs"))).expect(200);
    return res.body.jobs[0].id as string;
  };

  it("VIEWER đọc danh sách và chi tiết", async () => {
    const id = await jobId();
    const res = await as(viewer, request(app).get(url(`/jobs/${id}`))).expect(
      200,
    );
    expect(res.body.job.state).toBe("QUEUED");
    expect(res.body.resources).toEqual([]);
  });

  it("job của project khác ⇒ 404; mã không phải uuid ⇒ 400", async () => {
    const other = await world.newProject(owner);
    const id = await jobId();
    await as(
      owner,
      request(app).get(url(`/jobs/${id}`, other.projectId)),
    ).expect(404);
    await as(owner, request(app).get(url("/jobs/khong-phai-uuid"))).expect(400);
  });

  it("hủy: OWNER ⇒ 202 CANCEL_REQUESTED; lần hai ⇒ 409 job-not-cancellable", async () => {
    const id = await jobId();
    await as(viewer, request(app).post(url(`/jobs/${id}/cancel`))).expect(403);
    const res = await as(
      owner,
      request(app).post(url(`/jobs/${id}/cancel`)),
    ).expect(202);
    expect(res.body.job).toMatchObject({
      state: "CANCEL_REQUESTED",
      cancellable: false,
    });
    const again = await as(
      owner,
      request(app).post(url(`/jobs/${id}/cancel`)),
    ).expect(409);
    expect(again.body.type).toContain(PROVISION_ERROR_SLUGS.notCancellable);
  });

  it("SSE: job đã kết thúc ⇒ đúng một snapshot rồi đóng", async () => {
    const id = await jobId();
    await admin.provisioningJob.update({
      where: { id },
      data: { state: "FAILED" },
    });
    const res = await as(
      viewer,
      request(app).get(url(`/jobs/${id}/stream`)),
    ).expect(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = res.text.split("\n\n").filter((e) => e.trim() !== "");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/^event: snapshot\ndata: /);
    const data = JSON.parse(events[0]?.split("data: ")[1] ?? "{}") as {
      job: { state: string };
    };
    expect(data.job.state).toBe("FAILED");
  });
});

describe("DELETE /projects/:id (Plan #29 P3)", () => {
  const seedProvisioned = async (pid: string, state: "DONE" | "QUEUED") => {
    const job = await admin.provisioningJob.create({
      data: {
        projectId: pid,
        jobType: "PROVISION",
        state,
        payload: { marker: "payload-cua-lan-provision" },
      },
      select: { id: true },
    });
    return job.id;
  };

  it("project chưa dựng gì ⇒ 204, không job nào; xoá lần hai ⇒ 404", async () => {
    const { projectId: pid } = await world.newProject(owner);
    const before = enqueued.length;
    await as(owner, request(app).delete(url("", pid))).expect(204);
    expect(enqueued).toHaveLength(before);
    expect(
      await admin.provisioningJob.count({ where: { projectId: pid } }),
    ).toBe(0);
    await as(owner, request(app).delete(url("", pid))).expect(404);
  });

  it("còn tài nguyên sống ⇒ TEARDOWN mang payload của lượt PROVISION, gửi hàng đợi", async () => {
    const { projectId: pid } = await world.newProject(owner);
    const provisioned = await seedProvisioned(pid, "DONE");
    await admin.provisionedResource.create({
      data: {
        jobId: provisioned,
        projectId: pid,
        step: "NETWORK",
        kind: "vpc",
        idempotencyKey: `${pid}:NETWORK:vpc:vpc`,
        providerId: "vpc-con-song",
        provider: "AWS",
        region: "ap-southeast-1",
        status: "READY",
      },
    });

    await as(owner, request(app).delete(url("", pid))).expect(204);
    const teardown = await admin.provisioningJob.findFirstOrThrow({
      where: { projectId: pid, jobType: "TEARDOWN" },
      select: { id: true, state: true, payload: true },
    });
    expect(teardown).toMatchObject({
      state: "QUEUED",
      payload: { marker: "payload-cua-lan-provision" },
    });
    expect(enqueued.at(-1)).toBe(teardown.id);
    await admin.provisionedResource.deleteMany({ where: { projectId: pid } });
  });

  it("PROVISION đang chạy ⇒ yêu cầu hủy (bù trừ là teardown), không job thứ hai", async () => {
    const { projectId: pid } = await world.newProject(owner);
    const running = await seedProvisioned(pid, "QUEUED");
    await as(owner, request(app).delete(url("", pid))).expect(204);
    const jobs = await admin.provisioningJob.findMany({
      where: { projectId: pid },
      select: { id: true, state: true },
    });
    expect(jobs).toEqual([{ id: running, state: "CANCEL_REQUESTED" }]);
  });

  it("MAINTAINER ⇒ 403", async () => {
    await as(maintainer, request(app).delete(url(""))).expect(403);
  });
});

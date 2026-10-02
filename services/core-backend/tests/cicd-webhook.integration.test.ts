import { createHmac, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { resolve } from "node:path";
import { env, workloadSlugFor } from "@udp/config";
import { createPrismaClient, observeQueries, Prisma } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetTrustedDeployKeyCache } from "../src/modules/cicd/trusted-deploy.js";
import type { ClusterIssuerKeys } from "../src/core/app-deps.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { createRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import { keyIdOf } from "../src/modules/packaging/signing-keys.js";
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
  noEgress,
  noExternalAuth,
  noRepoSource,
  outsidePlatform,
} from "./helpers/inert-deps.js";
import { testSigner } from "./helpers/dsse.js";

/**
 * Plan #36 AC-3, AC-5 qua HTTP thật, adapter GitHub Actions THẬT của registry sản phẩm, database
 * thật: secret webhook (sinh, niêm phong, hiện một lần, xoay có audit), webhook (401 đồng nhất,
 * 413, 400, 422, chống trùng, chờ duyệt) và duyệt deploy chờ. Job deploy — hàng đợi giả ghi lại
 * `deploymentId`; phần cluster ở `deploy-job.integration.test.ts`. [Plan #61 QĐ-16] Cổng deploy: image của đúng
 * repository, chữ ký image (bộ ký DSSE của test, cùng hình cosign), tự bật bắt buộc.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_cicd_webhook_admin",
});

const enqueued: string[] = [];

/**
 * [Plan #61 61d-2a] Cùng một bộ phụ thuộc, chỉ khác đường ra mạng.
 *
 * Phần lớn bộ test không chạm mạng nên dùng `noEgress` — một sentinel NÉM, để một đường mã đi gọi mạng
 * ngoài ý muốn thì đỏ ngay thay vì lặng lẽ ra Internet trong CI. Riêng họ test Trusted Deploy tiêm một
 * `fetch` phục vụ JWKS của khoá sinh trong tiến trình.
 */
const appWith = (
  egressFetch: typeof fetch,
  /** [Plan #61 61d-2b-1] `null` = tiến trình không có đường ra cụm (mặc định, như phần lớn bộ test) */
  clusterIssuerKeys: ClusterIssuerKeys | null = null,
) =>
  createApp({
    metricsFor: () => new FakeMetricsProvider(),
    flagService: createFlagServiceClient({
      baseUrl: "http://127.0.0.1:9",
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
    oidcIssuer: null,
    cloud: inertCloudPlatform,
    repoSource: noRepoSource,
    platform: outsidePlatform,
    auth: noExternalAuth,
    domainRegistry: (() => {
      const loaded = createRegistry({
        root: resolve(import.meta.dirname, "../src/modules"),
      });
      return () => loaded;
    })(),
    provisioning: {
      egressCidrs: [],
      enqueue: null,
      enqueueDeploy: (deploymentId) => {
        enqueued.push(deploymentId);
        return Promise.resolve();
      },
      withCluster: null,
      scanDrift: null,
      clusterToken: null,
      clusterIssuerKeys,
      flaggerGateBaseUrl: null,
    },
    egressFetch,
  });

const app = appWith(noEgress);

let world: TestWorld;
let owner: Actor;
let maintainer: Actor;
let developer: Actor;
let viewer: Actor;
let projectId: string;
let envs: Record<string, ProjectEnv>;
let secret: string;
/** Workload và repository image của project: `<registry>/<slug>` — template sinh đúng như vậy */
let slug: string;
let image: string;
let registryConfigId: string;

const REGISTRY_REF = "ghcr.io/acme";

/** Bật GHCR cho project — như binding mà adapter GHCR ghi ([Plan #61 QĐ-6] kèm `pushAuth`) */
async function bindRegistry(): Promise<void> {
  const registry = await admin.domainConfig.create({
    data: {
      projectId,
      domainType: "CONTAINER_REGISTRY",
      isEnabled: true,
      selectedTool: "ghcr",
      toolConfig: { owner: "acme" },
    },
  });
  registryConfigId = registry.id;
  await admin.capabilityBinding.create({
    data: {
      domainConfigId: registry.id,
      capabilityId: "registry.oci",
      providedBy: "container_registry:ghcr",
      schemaVersion: "1.0.0",
      endpoint: REGISTRY_REF,
      attributes: { pushAuth: "github-token" },
    },
  });
}

async function unbindRegistry(): Promise<void> {
  await admin.capabilityBinding.deleteMany({
    where: { domainConfigId: registryConfigId },
  });
  await admin.domainConfig.delete({ where: { id: registryConfigId } });
}

const cicdUrl = (path: string) =>
  `${API}/projects/${projectId}/domains/CICD${path}`;
const hookUrl = (project = projectId, provider = "github-actions") =>
  `${API}/webhooks/cicd/${project}/${provider}`;

const body = (over: Record<string, unknown> = {}) => ({
  environment: "dev",
  status: "success",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  commitTimestamp: "2026-09-26T08:00:00+07:00",
  imageRef: `${image}:0123456`,
  workloadName: slug,
  pipelineId: `run-${String(Math.random()).slice(2, 10)}`,
  repo: "acme/web",
  ref: "refs/heads/dev",
  actor: "dev",
  ...over,
});

/** Gửi như bước "báo UDP" của template: ký ĐÚNG chuỗi byte gửi đi */
function hook(
  payload: unknown,
  opts: {
    key?: string;
    url?: string;
    raw?: string;
    /** [Plan #61 61d-2a] Token OIDC của lượt chạy — Trusted Deploy */
    bearer?: string;
    /** App có `egressFetch` phục vụ JWKS; mặc định là app chung (`noEgress`) */
    on?: typeof app;
  } = {},
) {
  const raw = opts.raw ?? JSON.stringify(payload);
  const sig = createHmac("sha256", opts.key ?? secret)
    .update(raw)
    .digest("hex");
  const req = request(opts.on ?? app)
    .post(opts.url ?? hookUrl())
    .set("content-type", "application/json")
    .set("x-hub-signature-256", `sha256=${sig}`);
  if (opts.bearer !== undefined) {
    req.set("authorization", `Bearer ${opts.bearer}`);
  }
  return req.send(raw);
}

const eventsOf = (deploymentId: string) =>
  admin.deploymentEvent.findMany({
    where: { deploymentId },
    orderBy: { occurredAt: "asc" },
  });

beforeAll(async () => {
  world = testWorld(app, admin);
  owner = await world.newActor("cicd-owner");
  maintainer = await world.newActor("cicd-maintainer");
  developer = await world.newActor("cicd-developer");
  viewer = await world.newActor("cicd-viewer");
  ({ projectId, envs } = await world.newProject(owner));
  await world.addMember(owner, projectId, maintainer, "MAINTAINER");
  await world.addMember(owner, projectId, developer, "DEVELOPER");
  await world.addMember(owner, projectId, viewer, "VIEWER");
  await admin.domainConfig.create({
    data: {
      projectId,
      domainType: "CICD",
      isEnabled: true,
      selectedTool: "github-actions",
      toolConfig: { repository: "acme/web" },
    },
  });
  const project = await admin.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true },
  });
  slug = workloadSlugFor(project.name);
  image = `${REGISTRY_REF}/${slug}`;
  await bindRegistry();
}, 120_000);

afterAll(async () => {
  await admin.deploymentEvent.deleteMany({ where: { projectId } });
  await world.cleanup();
  await admin.$disconnect();
});

describe("secret webhook (AC-5)", () => {
  it("chưa sinh ⇒ trạng thái nói vậy, và mọi webhook là 401", async () => {
    const res = await as(viewer, request(app).get(cicdUrl("/webhook"))).expect(
      200,
    );
    expect(res.body.cicd).toEqual({
      provider: "github-actions",
      webhookPath: `/api/v1/webhooks/cicd/${projectId}/github-actions`,
      // [Plan #61 61d-2a] Máy chủ là nguồn sự thật duy nhất cho địa chỉ tuyệt đối: `aud` của token phải
      // bằng đúng chuỗi này, và Portal in lại chính nó thay vì tự ghép từ `window.location.origin`
      webhookUrl: `${env.CORS_ORIGIN}/api/v1/webhooks/cicd/${projectId}/github-actions`,
      secretSet: false,
      trustedDeploy: {
        required: false,
        available: true,
        unavailableReason: null,
      },
    });
    await hook(body(), { key: "bat-ky" }).expect(401);
  });

  it("DEVELOPER không sinh được; MAINTAINER sinh ⇒ giá trị CHỈ ở response này, cột niêm phong", async () => {
    await as(developer, request(app).post(cicdUrl("/webhook-secret"))).expect(
      403,
    );
    const res = await as(
      maintainer,
      request(app).post(cicdUrl("/webhook-secret")),
    ).expect(200);
    secret = res.body.secret as string;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    const row = await admin.domainConfig.findFirstOrThrow({
      where: { projectId, domainType: "CICD" },
      select: { webhookSecret: true },
    });
    expect(JSON.stringify(row.webhookSecret)).not.toContain(secret);

    const status = await as(viewer, request(app).get(cicdUrl("/webhook")));
    expect(status.body.cicd.secretSet).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain(secret);

    const audit = await admin.auditLog.findMany({
      where: { projectId, action: { startsWith: "cicd.webhook_secret" } },
    });
    expect(audit.map((a) => a.action)).toEqual(["cicd.webhook_secret.create"]);
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("xoay ⇒ secret cũ chết ngay, audit ghi rotate", async () => {
    const old = secret;
    const res = await as(
      maintainer,
      request(app).post(cicdUrl("/webhook-secret")),
    ).expect(200);
    secret = res.body.secret as string;
    expect(secret).not.toBe(old);
    await hook(body(), { key: old }).expect(401);
    const actions = await admin.auditLog.findMany({
      where: { projectId, action: "cicd.webhook_secret.rotate" },
    });
    expect(actions).toHaveLength(1);
  });
});

describe("webhook (AC-3)", () => {
  it("chữ ký sai, project lạ, provider khác ⇒ CÙNG một 401; chữ ký sai ghi audit", async () => {
    const wrong = await hook(body(), { key: "khac" }).expect(401);
    const unknown = await hook(body(), {
      url: hookUrl("00000000-0000-4000-8000-00000000abcd"),
    }).expect(401);
    const otherTool = await hook(body(), {
      url: hookUrl(projectId, "gitlab-ci"),
    }).expect(401);
    for (const res of [unknown, otherTool]) {
      expect(res.body.detail).toBe(wrong.body.detail);
      expect(res.body.title).toBe(wrong.body.title);
    }
    const rejected = await admin.auditLog.count({
      where: { projectId, action: "cicd.webhook.rejected" },
    });
    expect(rejected).toBeGreaterThanOrEqual(1);
  });

  it("thân > 1 MiB ⇒ 413, không 500", async () => {
    const res = await hook(null, { raw: "x".repeat(1_048_577) });
    expect(res.status).toBe(413);
  });

  it("chữ ký đúng nhưng thân sai hình ⇒ 400; environment lạ ⇒ 422", async () => {
    await hook(null, { raw: '{"environment":"dev"}' }).expect(400);
    await hook(body({ environment: "khong-co" })).expect(422);
  });

  it("thành công ở env tự deploy ⇒ 202 started, DEPLOY_START + job; gửi lại ⇒ 200 duplicate, không sự kiện mới", async () => {
    const payload = body();
    const first = await hook(payload).expect(202);
    expect(first.body.status).toBe("started");
    const id = first.body.deploymentId as string;
    expect(enqueued).toContain(id);

    const events = await eventsOf(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "DEPLOY_START",
      environmentId: envs.dev?.id,
      pipelineId: payload.pipelineId,
      imageTag: "0123456",
      workloadName: slug,
      triggeredBy: "WEBHOOK",
      metadata: { imageRef: payload.imageRef, provider: "github-actions" },
    });

    const again = await hook(payload).expect(200);
    expect(again.body).toEqual({ deploymentId: id, status: "duplicate" });
    expect(await eventsOf(id)).toHaveLength(1);
  });

  /**
   * Hai lần gửi lại đến cùng lúc: lần sau phải CHỜ lần trước commit rồi mới tra trùng. Phép này
   * tất định — giữ đúng khoá `(environment, pipelineId)` ở một transaction khác, gửi webhook, chèn
   * START của "lần trước" giữa chừng rồi mới commit. Không có khoá, webhook tra trùng lúc START
   * chưa commit và tạo lần deploy thứ hai.
   */
  it("khoá (environment, pipelineId): lần gửi đến giữa lúc lần kia chưa commit ⇒ chờ, rồi thấy trùng", async () => {
    const payload = body();
    const key = `${envs.dev!.id}:${payload.pipelineId}`;
    const earlier = randomUUID();
    let pending: Promise<request.Response> | undefined;
    await admin.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        pending = hook(payload).then((r) => r);
        await new Promise((r) => setTimeout(r, 1_500));
        await tx.deploymentEvent.create({
          data: {
            projectId,
            environmentId: envs.dev!.id,
            deploymentId: earlier,
            eventType: "DEPLOY_START",
            workloadName: slug,
            pipelineId: payload.pipelineId,
            triggeredBy: "WEBHOOK",
            metadata: { imageRef: payload.imageRef },
          },
        });
      },
      { timeout: 20_000 },
    );
    const res = await pending!;
    expect(res.body).toEqual({ deploymentId: earlier, status: "duplicate" });
  });

  it("pipeline hỏng ⇒ 200 failure-recorded, DEPLOY_FAILURE, không job", async () => {
    const before = enqueued.length;
    const res = await hook(
      body({ status: "failure", imageRef: undefined }),
    ).expect(200);
    expect(res.body.status).toBe("failure-recorded");
    expect(
      (await eventsOf(res.body.deploymentId as string)).map((e) => e.eventType),
    ).toEqual(["DEPLOY_FAILURE"]);
    expect(enqueued).toHaveLength(before);
  });
});

describe("deploy chờ duyệt (AC-4, §2.2 auto_deploy)", () => {
  let pending: string;

  it("env không tự deploy ⇒ 202 pending, DEPLOY_PENDING, không job", async () => {
    await admin.environment.update({
      where: { id: envs.prod!.id },
      data: { autoDeploy: false },
    });
    const before = enqueued.length;
    const res = await hook(body({ environment: "prod" })).expect(202);
    expect(res.body.status).toBe("pending");
    pending = res.body.deploymentId as string;
    expect(enqueued).toHaveLength(before);
    expect((await eventsOf(pending)).map((e) => e.eventType)).toEqual([
      "DEPLOY_PENDING",
    ]);
  });

  it("DEVELOPER không duyệt được; MAINTAINER duyệt ⇒ START thủ công + job + audit", async () => {
    const url = `${API}/projects/${projectId}/deployments/${pending}/approve`;
    await as(developer, request(app).post(url)).expect(403);
    const res = await as(maintainer, request(app).post(url)).expect(202);
    expect(res.body).toEqual({ deploymentId: pending, status: "started" });
    expect(enqueued).toContain(pending);

    const events = await eventsOf(pending);
    expect(events.map((e) => [e.eventType, e.triggeredBy])).toEqual([
      ["DEPLOY_PENDING", "WEBHOOK"],
      ["DEPLOY_START", "MANUAL"],
    ]);
    expect(events[1]?.metadata).toMatchObject({
      imageRef: `${image}:0123456`,
    });
    expect(
      await admin.auditLog.count({
        where: { projectId, action: "deployment.approve", targetId: pending },
      }),
    ).toBe(1);

    const twice = await as(maintainer, request(app).post(url)).expect(200);
    expect(twice.body.status).toBe("duplicate");
  });

  it("id lạ ⇒ 404; id sai hình ⇒ 400", async () => {
    await as(
      maintainer,
      request(app).post(
        `${API}/projects/${projectId}/deployments/00000000-0000-4000-8000-000000000000/approve`,
      ),
    ).expect(404);
    await as(
      maintainer,
      request(app).post(
        `${API}/projects/${projectId}/deployments/khong-phai-uuid/approve`,
      ),
    ).expect(400);
  });
});

/**
 * [Plan #61 QĐ-13] Lượt rebase theo lịch: UDP quyết, không phải pipeline — chỉ deploy khi production đang chạy ĐÚNG
 * commit đó với digest khác; không bao giờ đè một lần rollback có chủ đích hay một lần deploy chưa xong.
 */
describe("lượt rebase theo lịch (Plan #61 QĐ-13)", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
  const OLD = `sha256:${"1".repeat(64)}`;
  const NEW = `sha256:${"2".repeat(64)}`;
  const imageOf = (commit: string, digest: string) =>
    `${image}:${commit}@${digest}`;
  const rebase = (imageRef: string) =>
    body({
      environment: "prod",
      ref: "refs/heads/main",
      commitSha: COMMIT,
      imageRef,
      kind: "rebase",
    });

  /**
   * Lần deploy production đã XONG với ảnh này — START rồi SUCCESS, sau mọi sự kiện đã có và trước sự kiện webhook kế
   * tiếp.
   *
   * KHÔNG đặt `occurredAt`: từ migration `deploy_event_time_from_database`, cột đó do DATABASE điền bằng
   * `clock_timestamp()`, đúng con đường mà webhook của production đi. Hai lệnh ghi rời nhau nên mốc tăng dần.
   *
   * Hai bản trước đều sai và đều để lại test chập chờn hay đỏ hẳn, giữ lại đây để không ai làm lại: bản 61c lấy
   * `Date.now() - 2000` / `- 1000` (đồng hồ MÁY, biên chỉ ~400 ms so với sự kiện webhook); bản 61d-1 lấy
   * `clock_timestamp()` của database trong khi sự kiện webhook vẫn mang đồng hồ máy, mà máy dev chạy nhanh hơn
   * Supabase 1,5 giây, nên sự kiện MỚI của test xếp TRƯỚC sự kiện cũ của app và `latestDeployment` chọn sai.
   */
  async function deployed(imageRef: string): Promise<string> {
    const deploymentId = randomUUID();
    const base = {
      projectId,
      environmentId: envs.prod!.id,
      deploymentId,
      workloadName: slug,
      triggeredBy: "WEBHOOK" as const,
    };
    await admin.deploymentEvent.create({
      data: { ...base, eventType: "DEPLOY_START", metadata: { imageRef } },
    });
    await admin.deploymentEvent.create({
      data: { ...base, eventType: "DEPLOY_SUCCESS", metadata: {} },
    });
    return deploymentId;
  }

  beforeAll(async () => {
    await admin.environment.update({
      where: { id: envs.prod!.id },
      data: { autoDeploy: true },
    });
    await admin.deploymentEvent.deleteMany({
      where: { environmentId: envs.prod!.id },
    });
  });

  it("production chưa deploy lần nào ⇒ 200 skipped NOT_DEPLOYED, không ghi sự kiện, không job", async () => {
    const before = enqueued.length;
    const res = await hook(rebase(imageOf(COMMIT, NEW))).expect(200);
    expect(res.body).toEqual({
      deploymentId: null,
      status: "skipped",
      reason: "NOT_DEPLOYED",
    });
    expect(enqueued).toHaveLength(before);
    expect(
      await admin.deploymentEvent.count({
        where: { environmentId: envs.prod!.id },
      }),
    ).toBe(0);
  });

  it("production chạy cùng commit, digest cũ ⇒ 202 started, metadata kind rebase; danh sách ghi cờ rebase", async () => {
    await deployed(imageOf(COMMIT, OLD));
    const res = await hook(rebase(imageOf(COMMIT, NEW))).expect(202);
    expect(res.body.status).toBe("started");
    const id = res.body.deploymentId as string;
    expect(enqueued).toContain(id);
    const [start] = await eventsOf(id);
    expect(start).toMatchObject({
      eventType: "DEPLOY_START",
      imageTag: COMMIT,
      metadata: { imageRef: imageOf(COMMIT, NEW), kind: "rebase" },
    });
    const list = await as(
      viewer,
      request(app).get(
        `${API}/projects/${projectId}/deployments?envId=${envs.prod!.id}`,
      ),
    ).expect(200);
    const rows = list.body.deployments as {
      deploymentId: string;
      rebase: boolean;
    }[];
    expect(rows.find((d) => d.deploymentId === id)?.rebase).toBe(true);
    expect(
      rows.filter((d) => d.deploymentId !== id).every((d) => !d.rebase),
    ).toBe(true);
  });

  it("lần deploy mới nhất chưa xong ⇒ skipped NOT_SETTLED; xong với ĐÚNG image ⇒ 200 unchanged, không ghi gì", async () => {
    const pendingRun = await hook(rebase(imageOf(COMMIT, NEW))).expect(200);
    expect(pendingRun.body).toMatchObject({
      status: "skipped",
      reason: "NOT_SETTLED",
    });
    const current = await deployed(imageOf(COMMIT, NEW));
    const count = await admin.deploymentEvent.count({
      where: { environmentId: envs.prod!.id },
    });
    const res = await hook(rebase(imageOf(COMMIT, NEW))).expect(200);
    expect(res.body).toEqual({ deploymentId: current, status: "unchanged" });
    expect(
      await admin.deploymentEvent.count({
        where: { environmentId: envs.prod!.id },
      }),
    ).toBe(count);
  });

  it("production chạy commit KHÁC (vừa rollback có chủ đích) ⇒ skipped OTHER_IMAGE: rebase không đè rollback", async () => {
    const rolledBack = await deployed(imageOf(OTHER, OLD));
    const res = await hook(rebase(imageOf(COMMIT, NEW))).expect(200);
    expect(res.body).toEqual({
      deploymentId: rolledBack,
      status: "skipped",
      reason: "OTHER_IMAGE",
    });
  });

  it("rebase vào environment không phải production ⇒ 422; rebase hỏng hay thiếu image ⇒ 400", async () => {
    await hook({ ...rebase(imageOf(COMMIT, NEW)), environment: "dev" }).expect(
      422,
    );
    await hook({ ...rebase(imageOf(COMMIT, NEW)), status: "failure" }).expect(
      400,
    );
    const noImage: Record<string, unknown> = rebase(imageOf(COMMIT, NEW));
    delete noImage.imageRef;
    await hook(noImage).expect(400);
  });
});

describe("template pipeline", () => {
  it("chưa có registry.oci ⇒ 409; có ⇒ template của tool đang bật, đúng registry, VIEWER không xem", async () => {
    await unbindRegistry();
    await as(developer, request(app).get(cicdUrl("/pipeline-template"))).expect(
      409,
    );
    await bindRegistry();

    await as(viewer, request(app).get(cicdUrl("/pipeline-template"))).expect(
      403,
    );
    const res = await as(
      developer,
      request(app).get(cicdUrl("/pipeline-template")),
    ).expect(200);
    expect(res.body.provider).toBe("github-actions");
    const content = res.body.content as string;
    expect(content).toContain("ghcr.io/acme/");
    expect(content).toContain("X-Hub-Signature-256");
    expect(content).toContain("udp-driven");
  });
});

describe("cổng deploy (Plan #61 QĐ-16)", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const signer = testSigner();
  const digestOf = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
  /** Giây UTC như `date -u +%Y-%m-%dT%H:%M:%SZ` của bước ký */
  const utc = (at: Date) => at.toISOString().replace(/\.\d+Z$/, "Z");
  const signedBody = (
    digest: string,
    over: { ref?: string; issuedAt?: Date; signature?: unknown } = {},
  ) =>
    body({
      commitSha: COMMIT,
      imageRef: `${image}:${COMMIT}@${digest}`,
      signature:
        over.signature ??
        signer.bundle(digest, {
          "dev.udp.project": slug,
          "dev.udp.commit": COMMIT,
          "dev.udp.ref": over.ref ?? "dev",
          "dev.udp.run": "run-1",
          "dev.udp.issued-at": utc(over.issuedAt ?? new Date()),
        }),
    });
  const KMS =
    "awskms:///arn:aws:kms:ap-southeast-1:123456789012:key/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  const buildUrl = (path = "") => `${API}/projects/${projectId}/build${path}`;
  const signingOf = async () =>
    (
      (
        await admin.project.findUniqueOrThrow({
          where: { id: projectId },
          select: { buildSettings: true },
        })
      ).buildSettings as { signing: { enforce: boolean; keys: unknown[] } }
    ).signing;
  const verdictOf = async (deploymentId: string) => {
    const list = await as(
      viewer,
      request(app).get(
        `${API}/projects/${projectId}/deployments?envId=${envs.dev!.id}`,
      ),
    ).expect(200);
    return (
      list.body.deployments as { deploymentId: string; signature: unknown }[]
    ).find((d) => d.deploymentId === deploymentId)?.signature;
  };
  /** Lần deploy vừa nhận là lần đang chạy (job deploy xong) */
  const settle = (deploymentId: string) =>
    admin.deploymentEvent.create({
      data: {
        projectId,
        environmentId: envs.dev!.id,
        deploymentId,
        eventType: "DEPLOY_SUCCESS",
        workloadName: slug,
        triggeredBy: "WEBHOOK",
      },
    });

  it("image ngoài repository của project ⇒ 422 + nhật ký foreign-image, không sự kiện; báo hỏng không image vẫn ghi", async () => {
    for (const imageRef of [
      "docker.io/evil/web:1",
      `${image}-evil:1`,
      `${image}/sub:1`,
    ]) {
      const run = body({ imageRef });
      await hook(run).expect(422);
      expect(
        await admin.deploymentEvent.count({
          where: { projectId, pipelineId: run.pipelineId },
        }),
      ).toBe(0);
    }
    const audit = await admin.auditLog.findFirst({
      where: { projectId, action: "cicd.webhook.foreign-image" },
      orderBy: { occurredAt: "desc" },
    });
    expect(audit).toMatchObject({
      actorType: "SYSTEM",
      after: { provider: "github-actions", repository: image },
    });
    await hook(body({ status: "failure", imageRef: undefined })).expect(200);
  });

  it("project chưa có khoá: chữ ký bị bỏ qua, deploy như cũ, danh sách ghi chưa kiểm", async () => {
    const res = await hook(signedBody(digestOf(1))).expect(202);
    expect(await verdictOf(res.body.deploymentId as string)).toBeNull();
  });

  it("có khoá, chưa bắt buộc: thiếu chữ ký vẫn deploy; chữ ký hợp lệ đầu tiên ⇒ VERIFIED và tự bật bắt buộc, nhật ký SYSTEM", async () => {
    await as(
      maintainer,
      request(app)
        .put(buildUrl())
        .send({
          signing: { keys: [{ publicKey: signer.publicKey, kms: KMS }] },
        }),
    ).expect(200);
    expect(await signingOf()).toMatchObject({
      enforce: false,
      keys: [{ id: keyIdOf(signer.publicKey), kms: KMS }],
    });

    const unsigned = await hook(body()).expect(202);
    expect(await verdictOf(unsigned.body.deploymentId as string)).toBeNull();

    const before = enqueued.length;
    const res = await hook(signedBody(digestOf(2))).expect(202);
    const id = res.body.deploymentId as string;
    expect(enqueued).toHaveLength(before + 1);
    const [start] = await eventsOf(id);
    expect(start?.metadata).toMatchObject({
      signature: { keyId: keyIdOf(signer.publicKey) },
    });
    expect(await verdictOf(id)).toBe("VERIFIED");
    expect((await signingOf()).enforce).toBe(true);
    expect(
      await admin.auditLog.findFirst({
        where: { projectId, action: "project.build.signing-enforced" },
      }),
    ).toMatchObject({ actorType: "SYSTEM", after: { deploymentId: id } });
    await settle(id);
  });

  it("đã bắt buộc: thiếu, sai khoá, sai nhánh, cũ hơn bản đang chạy ⇒ 422 với mã, DEPLOY_FAILURE, không job", async () => {
    const other = testSigner();
    const cases: [string, Record<string, unknown>][] = [
      ["SIGNATURE_MISSING", body()],
      [
        "SIGNATURE_INVALID",
        signedBody(digestOf(3), {
          signature: other.bundle(digestOf(3), {
            "dev.udp.project": slug,
            "dev.udp.commit": COMMIT,
            "dev.udp.ref": "dev",
            "dev.udp.run": "run-1",
            "dev.udp.issued-at": utc(new Date()),
          }),
        }),
      ],
      // Image của nhánh main không được vào environment `dev` (và ngược lại)
      ["SIGNATURE_MISMATCH", signedBody(digestOf(4), { ref: "main" })],
      [
        "SIGNATURE_STALE",
        signedBody(digestOf(5), { issuedAt: new Date(Date.now() - 3_600_000) }),
      ],
    ];
    for (const [code, run] of cases) {
      const before = enqueued.length;
      const res = await hook(run).expect(422);
      expect(res.body.detail).toContain(code);
      expect(enqueued).toHaveLength(before);
      const [event] = await admin.deploymentEvent.findMany({
        where: { projectId, pipelineId: run.pipelineId as string },
      });
      expect(event).toMatchObject({
        eventType: "DEPLOY_FAILURE",
        metadata: { signature: { code } },
      });
      expect(await verdictOf(event!.deploymentId)).toBe(code);
    }
  });

  it("lưu cài đặt build không tắt được bắt buộc; tắt là thao tác riêng của MAINTAINER, có nhật ký; gỡ hết khoá ⇒ không bật lại được", async () => {
    await as(
      maintainer,
      request(app)
        .put(buildUrl())
        .send({
          signing: {
            keys: [{ publicKey: signer.publicKey, kms: KMS }],
            compat: false,
            enforce: false,
          },
        }),
    ).expect(200);
    expect(await signingOf()).toMatchObject({ enforce: true, compat: false });

    await as(
      developer,
      request(app).put(buildUrl("/signing-enforce")).send({ enforce: false }),
    ).expect(403);
    const off = await as(
      maintainer,
      request(app).put(buildUrl("/signing-enforce")).send({ enforce: false }),
    ).expect(200);
    expect(off.body.settings.signing.enforce).toBe(false);
    expect(
      await admin.auditLog.findFirst({
        where: { projectId, action: "project.build.signing-unenforced" },
      }),
    ).toMatchObject({ after: { enforce: false } });
    await hook(body()).expect(202);

    await as(
      maintainer,
      request(app)
        .put(buildUrl())
        .send({ signing: { keys: [] } }),
    ).expect(200);
    await as(
      maintainer,
      request(app).put(buildUrl("/signing-enforce")).send({ enforce: true }),
    ).expect(409);
  });
});

/**
 * [Plan #61, sửa trong 61d-1] Mốc giờ của chuỗi sự kiện deploy do DATABASE cấp.
 *
 * `deployment_events` có HAI writer ở HAI tiến trình: Service 1 (webhook, duyệt deploy, rollout, job) và Service 3
 * (`ROLLBACK` của pd-controller). Hai quyết định đọc thứ tự `occurred_at`: `latestDeployment` (QĐ-13, lượt vá image
 * nền không được đè một lần rollback có chủ đích) và `currentIssuedAt` (QĐ-16/AC-10, chữ ký không được cũ hơn bản
 * đang chạy). Nếu mỗi tiến trình ghi theo đồng hồ của chính nó thì cả hai kết luận sai được — đo 02/10/2026: Prisma
 * sinh `@default(now())` ở MÁY, và máy dev chạy nhanh hơn Supabase 1,5 giây.
 *
 * Ba phép khẳng định dưới đây bắt ba cách làm hỏng KHÁC nhau và cả ba đều TẤT ĐỊNH — không phép nào dựa vào độ lệch
 * đồng hồ hay độ trễ mạng của máy đang chạy test, vì đó đúng là thứ không được phép quyết định kết quả:
 *   (1) DEFAULT của cột, đọc từ catalog — bắt việc lùi migration;
 *   (2) câu INSERT thật KHÔNG mang cột `occurred_at` — bắt việc trả `schema.prisma` về `@default(now())`. Đây là hồi
 *       quy dễ xảy ra nhất và là hồi quy mà mọi phép so GIÁ TRỊ đều bỏ lọt khi hai đồng hồ tình cờ trùng nhau: chỉ
 *       HÌNH DẠNG câu lệnh phân biệt được "client sinh" với "database sinh";
 *   (3) hai sự kiện trong CÙNG một transaction có mốc tăng dần và nằm SAU lúc transaction mở — bắt việc đổi DEFAULT
 *       về `CURRENT_TIMESTAMP`. So sánh làm Ở SQL: cột là `TIMESTAMPTZ(6)` còn Prisma trả `Date` của JS chỉ có mili
 *       giây, nên so ở JS là ném đi đúng độ phân giải vừa mua về.
 */
describe("mốc giờ của sự kiện deploy (Plan #61, sửa trong 61d-1)", () => {
  const newEvent = (eventType: "DEPLOY_START" | "DEPLOY_SUCCESS") => ({
    projectId,
    environmentId: envs.prod!.id,
    deploymentId: randomUUID(),
    eventType,
    workloadName: slug,
    triggeredBy: "WEBHOOK" as const,
  });

  it("Prisma không gửi occurred_at; database điền bằng clock_timestamp() nên mỗi câu lệnh một mốc", async () => {
    // (1) DEFAULT ở database. Bắt việc lùi migration.
    const [column] = await admin.$queryRaw<{ column_default: string | null }[]>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'deployment_events' AND column_name = 'occurred_at'`;
    expect(column?.column_default).toContain("clock_timestamp()");

    // (2) Câu INSERT thật không mang cột đó. Bắt việc trả schema về `@default(now())` — hồi quy dễ xảy ra
    // nhất (một lần `prisma db pull` là đủ) và là hồi quy mà MỌI phép so giá trị đều bỏ lọt khi hai đồng hồ
    // tình cờ trùng nhau. Chỉ hình dạng câu lệnh phân biệt được "client sinh" với "database sinh".
    const statements: string[] = [];
    const stopWatching = observeQueries(admin, (o) => statements.push(o.query));
    try {
      await admin.deploymentEvent.create({
        data: newEvent("DEPLOY_START"),
        select: { id: true },
      });
    } finally {
      stopWatching();
    }
    const insert = statements.find(
      (q) => q.includes("INSERT INTO") && q.includes("deployment_events"),
    );
    expect(insert).toBeDefined();
    expect(insert).not.toContain("occurred_at");

    // (3) Hai sự kiện trong CÙNG một transaction nhận mốc TĂNG DẦN, và mốc nằm SAU lúc transaction bắt đầu.
    // Bắt việc đổi DEFAULT về `CURRENT_TIMESTAMP` (= `transaction_timestamp()`), đã đo thấy nó cho hai sự
    // kiện cùng một mốc. So sánh phải làm Ở SQL: cột là `TIMESTAMPTZ(6)` còn Prisma trả `Date` của JS chỉ
    // có mili giây, nên so ở JS là ném đi đúng độ phân giải vừa mua về — trên một Postgres cục bộ, hai
    // lệnh ghi cách nhau dưới 1 ms sẽ cắt về cùng một mili giây và phép so ở JS đỏ tất định.
    const verdict = await admin.$transaction(async (tx) => {
      // `::text` vì Prisma không giải tuần tự được cột kiểu `void` mà `pg_sleep` trả về
      await tx.$queryRaw`SELECT pg_sleep(0.01)::text AS nghi`;
      const first = await tx.deploymentEvent.create({
        data: newEvent("DEPLOY_START"),
        select: { id: true },
      });
      const second = await tx.deploymentEvent.create({
        data: newEvent("DEPLOY_SUCCESS"),
        select: { id: true },
      });
      const at = (id: string) =>
        Prisma.sql`(SELECT occurred_at FROM deployment_events WHERE id = ${id}::uuid)`;
      const [row] = await tx.$queryRaw<
        { tangDan: boolean; sauLucMoTransaction: boolean }[]
      >`SELECT ${at(second.id)} > ${at(first.id)} AS "tangDan",
               ${at(first.id)} > transaction_timestamp() + interval '5 milliseconds' AS "sauLucMoTransaction"`;
      return row!;
    });

    expect(verdict.tangDan).toBe(true);
    expect(verdict.sauLucMoTransaction).toBe(true);
  });
});

/**
 * [Plan #61 QĐ-17, 61d-2a] Trusted Deploy qua HTTP THẬT và database thật — phép khẳng định của **I41**.
 *
 * Bộ test tất định ở `tests/trusted-deploy.test.ts` đã soi lõi xác minh. Ở đây kiểm thứ chỉ đo được khi
 * có cả transaction, cả bảng, và cả thứ tự của đường webhook:
 *
 *  - **retry khác replay.** Một lượt gửi lại với thân GIỐNG HỆT từng byte là chuyện bình thường của CI
 *    (phản hồi mất trên đường về sau khi server đã commit), và nó phải trả lại kết quả cũ chứ không làm
 *    bước báo đỏ trong khi deploy đã chạy thật. Một lượt gửi lại với thân KHÁC là replay và phải bị chặn.
 *    Chỉ `body_digest` phân biệt được hai ca đó: phép chống trùng sẵn có tính cả `environment_id`, nên
 *    cùng `pipeline_id` mà đổi `environment` sang production sẽ lọt.
 *  - **token tiêu đúng một lần**, và chỉ khi một `deployment_events` được commit.
 *  - **chế độ bắt buộc tự bật** ở token hợp lệ đầu tiên, nhật ký SYSTEM ghi đúng một lần.
 *  - **thứ tự tầng**: HMAC sai + Bearer hợp lệ ⇒ 401 ĐỒNG NHẤT của §8.3 và KHÔNG một lời gọi mạng nào —
 *    webhook không được thành oracle dò project, và không được làm việc đắt tiền trên dữ liệu chưa xác thực.
 */
describe("Trusted Deploy qua HTTP thật (Plan #61 QĐ-17, I41)", () => {
  const ISS = "https://token.actions.githubusercontent.com";
  const JWKS_URI = `${ISS}/.well-known/jwks`;

  let signingKey: CryptoKey;
  let calls: string[];
  let tdApp: typeof app;

  const audience = () =>
    `${env.CORS_ORIGIN}${API}/webhooks/cicd/${projectId}/github-actions`;

  /** Token của một lượt chạy GitHub Actions: mọi claim đúng trừ những gì ô test cố ý đổi */
  async function runToken(
    over: { jti?: string; ref?: string; aud?: string } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({
      repository: "acme/web",
      ref: over.ref ?? "refs/heads/dev",
      jti: over.jti ?? `jti-${randomUUID()}`,
      iat: now,
      exp: now + 300,
    })
      .setProtectedHeader({ alg: "RS256", kid: "k-test" })
      .setIssuer(ISS)
      .setAudience(over.aud ?? audience())
      .sign(signingKey);
  }

  const usesOf = () => admin.webhookTokenUse.count({ where: { projectId } });
  const eventsOfPipeline = (pipelineId: string) =>
    admin.deploymentEvent.count({ where: { projectId, pipelineId } });
  const oidcRequired = async (): Promise<boolean> =>
    (
      await admin.domainConfig.findFirstOrThrow({
        where: { projectId, domainType: "CICD" },
        select: { oidcRequired: true },
      })
    ).oidcRequired;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      alg: "RS256",
      kid: "k-test",
    };
    calls = [];
    tdApp = appWith(((input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url !== JWKS_URI) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch);
  });

  beforeEach(async () => {
    calls = [];
    await admin.webhookTokenUse.deleteMany({ where: { projectId } });
    await admin.deploymentEvent.deleteMany({ where: { projectId } });
    await admin.domainConfig.updateMany({
      where: { projectId, domainType: "CICD" },
      data: { oidcRequired: false },
    });
  });

  it("token hợp lệ ⇒ deploy, một hàng token, nhãn VERIFIED, và chế độ bắt buộc TỰ BẬT", async () => {
    const payload = body();
    const res = await hook(payload, {
      bearer: await runToken(),
      on: tdApp,
    }).expect(202);

    expect(res.body.status).toBe("started");
    expect(await usesOf()).toBe(1);
    expect(await oidcRequired()).toBe(true);

    const list = await as(
      viewer,
      request(tdApp).get(
        `${API}/projects/${projectId}/deployments?envId=${envs.dev!.id}`,
      ),
    ).expect(200);
    const row = (
      list.body.deployments as {
        deploymentId: string;
        trustedDeploy: unknown;
      }[]
    ).find((d) => d.deploymentId === res.body.deploymentId);
    expect(row?.trustedDeploy).toBe("VERIFIED");

    // Nhật ký SYSTEM ghi ĐÚNG một lần, không một hàng mỗi webhook
    expect(
      await admin.auditLog.count({
        where: { projectId, action: "cicd.trusted-deploy.required" },
      }),
    ).toBe(1);
  });

  it("gửi lại CÙNG token với thân y nguyên ⇒ 200 duplicate, vẫn đúng MỘT sự kiện và MỘT hàng token", async () => {
    const payload = body();
    const token = await runToken();
    const first = await hook(payload, { bearer: token, on: tdApp }).expect(202);
    const again = await hook(payload, { bearer: token, on: tdApp }).expect(200);

    expect(again.body).toEqual({
      deploymentId: first.body.deploymentId,
      status: "duplicate",
    });
    expect(await usesOf()).toBe(1);
    expect(await eventsOfPipeline(payload.pipelineId)).toBe(1);
  });

  it("gửi lại CÙNG token với thân ĐỔI sang production ⇒ 401, không sự kiện mới, có nhật ký từ chối", async () => {
    const token = await runToken();
    await hook(body(), { bearer: token, on: tdApp }).expect(202);
    const before = await admin.deploymentEvent.count({ where: { projectId } });

    // Cùng token, cùng pipelineId, nhưng ĐỔI environment: phép chống trùng theo pipeline KHÔNG bắt được
    // ca này vì nó tính cả environment — chỉ `body_digest` chặn.
    const replay = body({ environment: "prod", ref: "refs/heads/main" });
    await hook(replay, { bearer: token, on: tdApp }).expect(401);

    expect(await admin.deploymentEvent.count({ where: { projectId } })).toBe(
      before,
    );
    expect(
      await admin.auditLog.count({
        where: { projectId, action: "cicd.webhook.rejected" },
      }),
    ).toBeGreaterThan(0);
  });

  it("đã bắt buộc mà lời báo KHÔNG mang token ⇒ 401, không sự kiện nào", async () => {
    await hook(body(), { bearer: await runToken(), on: tdApp }).expect(202);
    expect(await oidcRequired()).toBe(true);

    const before = await admin.deploymentEvent.count({ where: { projectId } });
    await hook(body(), { on: tdApp }).expect(401);
    expect(await admin.deploymentEvent.count({ where: { projectId } })).toBe(
      before,
    );
  });

  it("token sai ⇒ LUÔN từ chối, kể cả khi chế độ bắt buộc còn TẮT", async () => {
    expect(await oidcRequired()).toBe(false);
    await hook(body(), {
      bearer: await runToken({ aud: "https://khac.test/hook" }),
      on: tdApp,
    }).expect(401);
    expect(await usesOf()).toBe(0);
  });

  it("nhánh lấy từ CLAIM: token của nhánh phụ không deploy được production", async () => {
    await hook(body({ environment: "prod", ref: "refs/heads/main" }), {
      bearer: await runToken({ ref: "refs/heads/feature-x" }),
      on: tdApp,
    }).expect(401);
    expect(await usesOf()).toBe(0);
  });

  it("HMAC sai + Bearer hợp lệ ⇒ 401 ĐỒNG NHẤT của §8.3 và KHÔNG một lời gọi mạng nào", async () => {
    const res = await hook(body(), {
      key: "bi-mat-sai",
      bearer: await runToken(),
      on: tdApp,
    }).expect(401);

    // Thân 401 không mang mã phân biệt lý do — webhook không thành oracle dò project
    expect(JSON.stringify(res.body)).not.toMatch(/TOKEN_/);
    // Và không làm việc đắt tiền trên dữ liệu chưa xác thực
    expect(calls).toEqual([]);
  });
});

/**
 * [Plan #61 QĐ-17, 61d-2a] Bật/tắt Trusted Deploy bằng tay — route riêng, và bốn tính chất của nó.
 *
 * Vì sao phải đi qua HTTP thật chứ không gọi thẳng service: ba trong bốn tính chất chỉ tồn tại ở tầng
 * route và chỉ đường này đo được - bậc quyền MAINTAINER, thân `strict` (một Portal cũ gửi thêm trường
 * phải đỏ ngay chứ không được ghi im lặng), và chuỗi dây mà Portal đọc. Route này cũng là chỗ DUY NHẤT
 * sinh mẫu golden cho `PUT /projects/{id}/domains/CICD/oidc-required`, nên thiếu nó thì `wire-golden`
 * đỏ ở phép kiểm "mọi route sendJson có mẫu".
 *
 * Tính chất thứ tư nằm ở tầng service nhưng chỉ thấy được khi có cả database: **tắt KHÔNG có tiền điều
 * kiện**. Một project đã bật, rồi đổi sang CI mà UDP chưa kiểm được token, vẫn phải tự mở được van. Nếu
 * phép tắt cũng đòi `available` thì project tắc hẳn và chỉ sửa được bằng SQL tay.
 */
describe("bật/tắt Trusted Deploy bằng tay (Plan #61 QĐ-17)", () => {
  const url = () => cicdUrl("/oidc-required");

  const requiredOf = async (): Promise<boolean> =>
    (
      await admin.domainConfig.findFirstOrThrow({
        where: { projectId, domainType: "CICD" },
        select: { oidcRequired: true },
      })
    ).oidcRequired;

  const auditOf = (action: string) =>
    admin.auditLog.count({ where: { projectId, action } });

  const put = (actor: Actor, required: unknown) =>
    as(actor, request(app).put(url()).send({ required }));

  beforeEach(async () => {
    await admin.domainConfig.updateMany({
      where: { projectId, domainType: "CICD" },
      data: {
        selectedTool: "github-actions",
        toolConfig: { repository: "acme/web" },
        oidcRequired: false,
      },
    });
    await admin.auditLog.deleteMany({
      where: { projectId, action: { startsWith: "cicd.trusted-deploy." } },
    });
  });

  it("VIEWER và DEVELOPER không bật được; MAINTAINER bật ⇒ dây nói đúng trạng thái mới, nhật ký một hàng", async () => {
    await put(viewer, true).expect(403);
    await put(developer, true).expect(403);

    const res = await put(maintainer, true).expect(200);
    expect(res.body.cicd.trustedDeploy).toEqual({
      required: true,
      available: true,
      unavailableReason: null,
    });
    // Route trả về TRẠNG THÁI ĐẦY ĐỦ chứ không chỉ cờ vừa đổi: Portal vẽ lại cả mục bằng một response
    expect(res.body.cicd.webhookUrl).toBe(
      `${env.CORS_ORIGIN}${API}/webhooks/cicd/${projectId}/github-actions`,
    );
    expect(res.body.cicd.provider).toBe("github-actions");
    expect(res.body.cicd.webhookPath).toBe(
      `${API}/webhooks/cicd/${projectId}/github-actions`,
    );
    expect(await requiredOf()).toBe(true);
    expect(await auditOf("cicd.trusted-deploy.required")).toBe(1);
  });

  it("bật khi đã bật ⇒ 200 và KHÔNG thêm nhật ký - phép ghi là idempotent", async () => {
    await put(maintainer, true).expect(200);
    const again = await put(maintainer, true).expect(200);

    expect(again.body.cicd.trustedDeploy.required).toBe(true);
    expect(await auditOf("cicd.trusted-deploy.required")).toBe(1);
  });

  it("tắt ⇒ nhật ký ghi hàng unrequired mang cả trước và sau", async () => {
    await put(maintainer, true).expect(200);
    const off = await put(maintainer, false).expect(200);

    expect(off.body.cicd.trustedDeploy.required).toBe(false);
    expect(
      await admin.auditLog.findFirst({
        where: { projectId, action: "cicd.trusted-deploy.unrequired" },
      }),
    ).toMatchObject({ before: { required: true }, after: { required: false } });
  });

  it("CI trong cụm mà project CHƯA có cụm ⇒ không BẬT được (409), nhưng vẫn TẮT được", async () => {
    // [Plan #61 61d-2b-1] Jenkins giờ kiểm được — nhưng khoá kiểm nằm ở cụm của project, mà project trong
    // bộ test này chưa provision cụm nào, nên lý do đúng là `CLUSTER_NOT_READY`
    await admin.domainConfig.updateMany({
      where: { projectId, domainType: "CICD" },
      data: { selectedTool: "jenkins" },
    });
    const seen = await as(viewer, request(app).get(cicdUrl("/webhook"))).expect(
      200,
    );
    expect(seen.body.cicd.trustedDeploy).toEqual({
      required: false,
      available: false,
      unavailableReason: "CLUSTER_NOT_READY",
    });

    await put(maintainer, true).expect(409);
    expect(await requiredOf()).toBe(false);

    // Van xả: cờ còn bật trong khi provider đã thành thứ UDP chưa kiểm được (một lượt bootstrap lại cụm,
    // hay một hàng chữa tay) thì đường TẮT vẫn phải đi được, không đòi `available`
    await admin.domainConfig.updateMany({
      where: { projectId, domainType: "CICD" },
      data: { oidcRequired: true },
    });
    await put(maintainer, false).expect(200);
    expect(await requiredOf()).toBe(false);
  });

  it("đổi CI ⇒ trigger ở DATABASE đưa cờ về false, không chờ một đường mã nào nhớ làm việc đó", async () => {
    await put(maintainer, true).expect(200);

    await admin.domainConfig.updateMany({
      where: { projectId, domainType: "CICD" },
      data: {
        selectedTool: "gitlab-ci",
        toolConfig: {
          gitlabUrl: "https://gitlab.com",
          projectPath: "acme/web",
        },
      },
    });

    expect(await requiredOf()).toBe(false);
  });

  it("thân phải ĐÚNG hình: thiếu trường, thêm trường, hay sai kiểu ⇒ 400", async () => {
    await as(maintainer, request(app).put(url()).send({})).expect(400);
    await as(
      maintainer,
      request(app).put(url()).send({ required: true, extra: 1 }),
    ).expect(400);
    await put(maintainer, "true").expect(400);
    expect(await requiredOf()).toBe(false);
  });
});

/**
 * [Plan #61 61d-2b-1] Trusted Deploy của ba CI chạy TRONG CỤM, qua HTTP thật và database thật (I42).
 *
 * `tests/trusted-deploy.test.ts` đã soi lõi xác minh bằng 12 ô tất định. Ở đây kiểm thứ chỉ thấy được khi
 * có cả đường webhook, cả transaction và cả bảng: token của pod build đi hết đường và tiêu đúng một lần;
 * một `sub` khác bị chặn VÀ hàng audit nói ra chủ thể nhận được; và một tiến trình không có đường ra cụm
 * trả 503 chứ không lặng lẽ deploy.
 */
describe("Trusted Deploy của CI trong cụm qua HTTP thật (I42)", () => {
  const CLUSTER_ISS = "https://oidc.eks.ap-southeast-1.amazonaws.com/id/UDP";
  const SUBJECT = "system:serviceaccount:udp-build:udp-builder";

  let saKey: CryptoKey;
  let saJwk: Record<string, unknown>;
  /** Số lượt UDP đọc khoá của cụm — oracle cho cache */
  let reads: number;
  let clusterApp: typeof app;
  /** App có đúng cấu hình trên, nhưng KHÔNG có đường ra cụm */
  let noClusterApp: typeof app;

  const jenkinsUrl = () => hookUrl(projectId, "jenkins");

  async function saToken(
    over: { sub?: string; jti?: string; aud?: string } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({
      sub: over.sub ?? SUBJECT,
      "kubernetes.io": { namespace: "udp-build" },
      jti: over.jti ?? `jti-${randomUUID()}`,
      iat: now,
      exp: now + 600,
    })
      .setProtectedHeader({ alg: "RS256", kid: "k-cum" })
      .setIssuer(CLUSTER_ISS)
      .setAudience(over.aud ?? `${env.CORS_ORIGIN}${jenkinsUrl()}`)
      .sign(saKey);
  }

  /** Gửi như bước báo của Jenkins: header chữ ký của nó là `X-UDP-Signature` */
  function jenkinsHook(
    payload: unknown,
    opts: { bearer?: string; on?: typeof app } = {},
  ) {
    const raw = JSON.stringify(payload);
    const sig = createHmac("sha256", secret).update(raw).digest("hex");
    const req = request(opts.on ?? clusterApp)
      .post(jenkinsUrl())
      .set("content-type", "application/json")
      .set("x-udp-signature", `sha256=${sig}`);
    if (opts.bearer !== undefined) {
      req.set("authorization", `Bearer ${opts.bearer}`);
    }
    return req.send(raw);
  }

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    saKey = pair.privateKey;
    saJwk = {
      ...(await exportJWK(pair.publicKey)),
      alg: "RS256",
      kid: "k-cum",
    };
    clusterApp = appWith(noEgress, () => {
      reads += 1;
      return Promise.resolve({
        issuer: CLUSTER_ISS,
        algorithms: ["RS256"],
        jwks: { keys: [saJwk] },
      });
    });
    noClusterApp = appWith(noEgress, null);
  });

  beforeEach(async () => {
    reads = 0;
    resetTrustedDeployKeyCache();
    await admin.webhookTokenUse.deleteMany({ where: { projectId } });
    await admin.deploymentEvent.deleteMany({ where: { projectId } });
    await admin.auditLog.deleteMany({
      where: { projectId, action: "cicd.webhook.rejected" },
    });
    await admin.domainConfig.updateMany({
      where: { projectId, domainType: "CICD" },
      data: { selectedTool: "jenkins", oidcRequired: false },
    });
  });

  afterAll(async () => {
    await admin.domainConfig.updateMany({
      where: { projectId, domainType: "CICD" },
      data: {
        selectedTool: "github-actions",
        toolConfig: { repository: "acme/web" },
        oidcRequired: false,
      },
    });
  });

  it("token của pod build ⇒ deploy, một hàng token, chế độ bắt buộc TỰ BẬT", async () => {
    const payload = body();
    const res = await jenkinsHook(payload, { bearer: await saToken() }).expect(
      202,
    );

    expect(res.body.status).toBe("started");
    expect(await admin.webhookTokenUse.count({ where: { projectId } })).toBe(1);
    const row = await admin.domainConfig.findFirstOrThrow({
      where: { projectId, domainType: "CICD" },
      select: { oidcRequired: true },
    });
    expect(row.oidcRequired).toBe(true);
    // Issuer lưu trong hàng token là chuỗi của CỤM, không một chuỗi ghim trong mã
    const use = await admin.webhookTokenUse.findFirstOrThrow({
      where: { projectId },
      select: { issuer: true, tokenId: true },
    });
    expect(use.issuer).toBe(CLUSTER_ISS);
    expect(use.tokenId).toMatch(/^jti-/);
  });

  it("gửi lại CÙNG token với thân y nguyên ⇒ 200 duplicate, vẫn một sự kiện và một hàng token", async () => {
    const payload = body();
    const token = await saToken();
    const first = await jenkinsHook(payload, { bearer: token }).expect(202);
    const again = await jenkinsHook(payload, { bearer: token }).expect(200);

    expect(again.body).toEqual({
      deploymentId: first.body.deploymentId,
      status: "duplicate",
    });
    expect(await admin.webhookTokenUse.count({ where: { projectId } })).toBe(1);
    // Khoá của cụm đọc đúng MỘT lần cho hai lời báo
    expect(reads).toBe(1);
  });

  it("`sub` của một ServiceAccount KHÁC ⇒ 401, và audit nói ra chủ thể nhận được", async () => {
    await jenkinsHook(body(), {
      bearer: await saToken({ sub: "system:serviceaccount:default:app" }),
    }).expect(401);

    expect(await admin.deploymentEvent.count({ where: { projectId } })).toBe(0);
    const audit = await admin.auditLog.findFirstOrThrow({
      where: { projectId, action: "cicd.webhook.rejected" },
      orderBy: { occurredAt: "desc" },
      select: { after: true },
    });
    const detail = JSON.stringify(audit.after);
    expect(detail).toContain("TOKEN_CLAIM_MISMATCH");
    expect(detail).toContain("system:serviceaccount:default:app");
    // Và tuyệt đối không chứa chính token
    expect(detail).not.toContain("eyJ");
  });

  it("tiến trình không có đường ra cụm ⇒ 503, không sự kiện nào, không hàng token nào", async () => {
    await jenkinsHook(body(), {
      bearer: await saToken(),
      on: noClusterApp,
    }).expect(503);

    expect(await admin.deploymentEvent.count({ where: { projectId } })).toBe(0);
    expect(await admin.webhookTokenUse.count({ where: { projectId } })).toBe(0);
  });

  it("HMAC sai + Bearer hợp lệ ⇒ 401 đồng nhất và KHÔNG một lượt đọc cụm nào", async () => {
    const raw = JSON.stringify(body());
    const sig = createHmac("sha256", "bi-mat-sai").update(raw).digest("hex");
    const res = await request(clusterApp)
      .post(jenkinsUrl())
      .set("content-type", "application/json")
      .set("x-udp-signature", `sha256=${sig}`)
      .set("authorization", `Bearer ${await saToken()}`)
      .send(raw)
      .expect(401);

    expect(JSON.stringify(res.body)).not.toMatch(/TOKEN_/);
    // Webhook không được làm việc đắt tiền (credential cloud, token quản trị) trên dữ liệu chưa xác thực
    expect(reads).toBe(0);
  });
});

import { randomUUID } from "node:crypto";
import {
  ACTOR_HEADER,
  CLIENT_IP_HEADER,
  env,
  STALE_FLAG_THRESHOLDS,
} from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import { hourFloor } from "@udp/shared-types";
import {
  seedEvalStats,
  startFlagService,
  type RunningService,
} from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
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
  noEgress,
  noExternalAuth,
  noRepoSource,
  outsidePlatform,
} from "./helpers/inert-deps.js";

/**
 * Luồng 4 ở Service 1 qua HTTP thật, Service 2 là tiến trình thật (§8.4) [v4.5].
 *
 * Bốn điều plan này hứa, mỗi điều một nhóm ca: SỞ HỮU (không chạm được flag hay
 * env của project khác — và S2 không hề bị gọi), QUYỀN theo environment (§2.2),
 * XÁC NHẬN hai bước, lỗi nghiệp vụ của S2 tới Portal nguyên vẹn (lỗi cấu hình thì
 * KHÔNG), và audit do S2 ghi mang đúng người làm — không phải người Portal khai.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_flag_test_admin",
});

const UA = "portal-flag-test";

let s2: RunningService | undefined;
let app: ReturnType<typeof createApp>;
let world: TestWorld;
let owner: Actor;
let developer: Actor;
/** [v4.9] Cleanup Center đọc bằng VIEWER, archive hàng loạt ghi bằng MAINTAINER */
let viewer: Actor;
let maintainer: Actor;
let projectId: string;
let envs: Record<string, ProjectEnv>;
/** Project mà `developer` KHÔNG thuộc về */
let other: { projectId: string; envs: Record<string, ProjectEnv> };
/** Số lời gọi S1 → S2 — kiểm sở hữu phải chặn TRƯỚC khi gọi */
let s2Calls = 0;

const flagsUrl = (pid = projectId) => `${API}/projects/${pid}/flags`;
const envIn = (bag: Record<string, ProjectEnv>, name: string): ProjectEnv => {
  const found = bag[name];
  if (found === undefined) throw new Error(`thiếu env ${name}`);
  return found;
};
const envOf = (name: string) => envIn(envs, name);

/** App phụ dùng S2 THẬT nhưng `fetch` giả — cho hai ca lô archive dừng giữa đường */
let appWith: (fetchImpl: typeof fetch) => ReturnType<typeof createApp>;

beforeAll(async () => {
  const started = await startFlagService();
  s2 = started;
  appWith = (fetchImpl) =>
    createApp({
      metricsFor: () => new FakeMetricsProvider(),
      oidcIssuer: null,
      cloud: inertCloudPlatform,
      repoSource: noRepoSource,
      egressFetch: noEgress,
      platform: outsidePlatform,
      auth: noExternalAuth,
      domainRegistry: noDomainAdapters,
      provisioning: inertProvisioning,
      flagService: createFlagServiceClient({
        baseUrl: started.baseUrl,
        secret: env.INTERNAL_SERVICE_SECRET,
        fetch: fetchImpl,
      }),
    });
  app = appWith((input, init) => {
    s2Calls += 1;
    return fetch(input, init);
  });
  world = testWorld(app, admin);
  owner = await world.newActor("flag-owner");
  developer = await world.newActor("flag-dev");
  viewer = await world.newActor("flag-viewer");
  maintainer = await world.newActor("flag-maint");
  ({ projectId, envs } = await world.newProject(owner));
  other = await world.newProject(owner);
  await world.addMember(owner, projectId, developer, "DEVELOPER");
  await world.addMember(owner, projectId, viewer, "VIEWER");
  await world.addMember(owner, projectId, maintainer, "MAINTAINER");
}, 120_000);

afterAll(async () => {
  await s2?.stop();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  await world?.cleanup();
  await admin.$disconnect();
});

interface CreatedFlag {
  id: string;
  key: string;
  updatedAt: string;
  variants: { id: string; key: string }[];
  envs: { configId: string; environment: { name: string } }[];
}

async function newFlag(
  actor: Actor = developer,
  pid = projectId,
): Promise<CreatedFlag> {
  const key = `f-${randomUUID().slice(0, 8)}`;
  const res = await as(
    actor,
    request(app).post(flagsUrl(pid)).send({ key, flagType: "BOOLEAN" }),
  ).expect(201);
  return res.body.flag as CreatedFlag;
}

const configOf = (flag: CreatedFlag, envName: string): string => {
  const found = flag.envs.find((e) => e.environment.name === envName);
  if (found === undefined) throw new Error(`flag không có env ${envName}`);
  return found.configId;
};

const auditsOf = (targetId: string, action?: string) =>
  admin.auditLog.findMany({
    where: { targetId, ...(action === undefined ? {} : { action }) },
    select: {
      action: true,
      actorUserId: true,
      ipAddress: true,
      userAgent: true,
    },
    orderBy: { occurredAt: "asc" },
  });

const stateOf = (configId: string) =>
  admin.flagEnvConfig.findUniqueOrThrow({
    where: { id: configId },
    select: { isEnabled: true, defaultVariantId: true },
  });

const patchEnv = (
  actor: Actor,
  flagId: string,
  envId: string,
  body: object,
  pid = projectId,
) =>
  as(
    actor,
    request(app)
      .patch(`${flagsUrl(pid)}/${flagId}/envs/${envId}`)
      .send(body),
  );

describe("tạo và đọc flag", () => {
  it("DEVELOPER tạo ⇒ 201 cùng hình với GET; audit do S2 ghi mang người làm, IP, UA", async () => {
    const key = `f-${randomUUID().slice(0, 8)}`;
    const res = await as(
      developer,
      request(app)
        .post(flagsUrl())
        .set("User-Agent", UA)
        .send({ key, flagType: "BOOLEAN" }),
    ).expect(201);
    const flag = res.body.flag as CreatedFlag;
    const detail = await as(
      developer,
      request(app).get(`${flagsUrl()}/${flag.id}`),
    ).expect(200);
    expect(res.body.flag).toEqual(detail.body.flag);

    const audits = await auditsOf(flag.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "flag.create",
      actorUserId: developer.userId,
      userAgent: UA,
    });
    expect(audits[0]?.ipAddress).not.toBeNull();
  });

  it("header nội bộ do Portal tự gửi bị bỏ qua — audit mang người đã đăng nhập, không phải người được khai", async () => {
    const key = `f-${randomUUID().slice(0, 8)}`;
    const res = await as(
      developer,
      request(app)
        .post(flagsUrl())
        .set(ACTOR_HEADER, owner.userId)
        .set(CLIENT_IP_HEADER, "198.51.100.9")
        .send({ key, flagType: "BOOLEAN" }),
    ).expect(201);
    const [row] = await auditsOf(res.body.flag.id as string);
    expect(row?.actorUserId).toBe(developer.userId);
    expect(row?.ipAddress).not.toBe("198.51.100.9");
  });

  it("trùng key ⇒ 409 DUPLICATE_RESOURCE của S2 tới Portal nguyên vẹn", async () => {
    const flag = await newFlag();
    const res = await as(
      developer,
      request(app)
        .post(flagsUrl())
        .send({ key: flag.key, flagType: "BOOLEAN" }),
    ).expect(409);
    expect(res.body.code).toBe("DUPLICATE_RESOURCE");
  });

  it("danh sách lọc theo env/search; chi tiết có variant và trạng thái ở MỌI env", async () => {
    const flag = await newFlag();
    const listed = await as(
      developer,
      request(app)
        .get(flagsUrl())
        .query({ envId: envOf("dev").id, search: flag.key }),
    ).expect(200);
    expect(listed.body.flags).toHaveLength(1);
    expect(listed.body.flags[0]).toMatchObject({
      key: flag.key,
      env: { isEnabled: false, ruleCount: 0 },
    });
    expect(flag.variants.map((v) => v.key)).toEqual(["off", "on"]);
    expect(flag.envs.map((e) => e.environment.name)).toEqual([
      "dev",
      "staging",
      "prod",
    ]);
  });

  it("[Plan #41] total đếm theo CÙNG bộ lọc, không theo trang; isEnabled chỉ flag bật ở env đó; thiếu envId ⇒ 400", async () => {
    const fresh = await world.newProject(owner);
    const pid = fresh.projectId;
    const dev = envIn(fresh.envs, "dev").id;
    const created = [
      await newFlag(owner, pid),
      await newFlag(owner, pid),
      await newFlag(owner, pid),
    ];
    await patchEnv(
      owner,
      created[0]?.id ?? "",
      dev,
      { isEnabled: true },
      pid,
    ).expect(200);
    const list = (query: Record<string, string | number>) =>
      as(owner, request(app).get(flagsUrl(pid)).query(query));

    const page = await list({ envId: dev, limit: 1 }).expect(200);
    expect(page.body.flags).toHaveLength(1);
    expect(page.body.total).toBe(3);

    const enabled = await list({ envId: dev, isEnabled: "true" }).expect(200);
    expect(enabled.body.total).toBe(1);
    expect(enabled.body.flags[0].id).toBe(created[0]?.id);
    const disabled = await list({ envId: dev, isEnabled: "false" }).expect(200);
    expect(disabled.body.total).toBe(2);

    await list({ isEnabled: "true" }).expect(400);
  });

  it("PATCH không đổi trường nào ⇒ 400 — không có lần ghi rỗng nào tới S2", async () => {
    const flag = await newFlag();
    const before = s2Calls;
    await as(
      developer,
      request(app)
        .patch(`${flagsUrl()}/${flag.id}`)
        .send({ lastKnownUpdatedAt: flag.updatedAt }),
    ).expect(400);
    expect(s2Calls).toBe(before);
  });
});

describe("sở hữu — không chạm được thứ của project khác, và S2 không bị gọi (D2)", () => {
  it("flag của project khác, env của project khác ⇒ 404 ở mọi route; S2 nhận 0 lời gọi, flag kia không đổi", async () => {
    const mine = await newFlag();
    const theirs = await newFlag(owner, other.projectId);
    const theirEnv = envIn(other.envs, "dev").id;
    const before = s2Calls;

    const calls: request.Test[] = [
      request(app).get(`${flagsUrl()}/${theirs.id}`),
      request(app).get(flagsUrl()).query({ envId: theirEnv }),
      request(app)
        .patch(`${flagsUrl()}/${theirs.id}`)
        .send({ lastKnownUpdatedAt: theirs.updatedAt, description: "x" }),
      request(app)
        .patch(`${flagsUrl()}/${theirs.id}/envs/${envOf("dev").id}`)
        .send({ isEnabled: true }),
      request(app)
        .patch(`${flagsUrl()}/${mine.id}/envs/${theirEnv}`)
        .send({ isEnabled: true }),
      request(app).get(`${flagsUrl()}/${mine.id}/envs/${theirEnv}/rules`),
      request(app)
        .post(`${flagsUrl()}/${theirs.id}/evaluate`)
        .send({ envId: envOf("dev").id, context: {} }),
      request(app)
        .post(`${flagsUrl()}/${mine.id}/evaluate`)
        .send({ envId: theirEnv, context: {} }),
      request(app)
        .put(`${flagsUrl()}/${mine.id}/envs/${theirEnv}/rules`)
        .send({ lastKnownUpdatedAt: new Date().toISOString(), rules: [] }),
    ];
    for (const call of calls) {
      await as(developer, call).expect(404);
    }
    // Và trực tiếp trên URL của project kia: developer không phải thành viên
    await patchEnv(
      developer,
      theirs.id,
      theirEnv,
      { isEnabled: true },
      other.projectId,
    ).expect(404);

    expect(s2Calls).toBe(before);
    expect(await stateOf(configOf(theirs, "dev"))).toMatchObject({
      isEnabled: false,
    });
  });
});

describe("quyền và xác nhận hai bước (§2.2, §8.4)", () => {
  it("dev: DEVELOPER bật được; response là trạng thái env; audit flag.env.update đúng env-config", async () => {
    const flag = await newFlag();
    const configId = configOf(flag, "dev");
    const res = await patchEnv(developer, flag.id, envOf("dev").id, {
      isEnabled: true,
    }).expect(200);
    expect(res.body.env).toMatchObject({ configId, isEnabled: true });
    const audits = await auditsOf(configId, "flag.env.update");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(developer.userId);
  });

  it("prod: DEVELOPER ⇒ 403; MAINTAINER thiếu/sai xác nhận ⇒ 428 và KHÔNG đổi gì; đúng key ⇒ 200; TẮT không cần xác nhận", async () => {
    const flag = await newFlag();
    const prod = envOf("prod").id;
    const configId = configOf(flag, "prod");
    const on = flag.variants.find((v) => v.key === "on")?.id;

    await patchEnv(developer, flag.id, prod, { isEnabled: true }).expect(403);
    await patchEnv(developer, flag.id, prod, { defaultVariantId: on }).expect(
      403,
    );
    const missing = await patchEnv(owner, flag.id, prod, {
      isEnabled: true,
    }).expect(428);
    expect(missing.body.code).toBe("CONFIRMATION_REQUIRED");
    await patchEnv(owner, flag.id, prod, {
      isEnabled: true,
      confirmFlagKey: "sai-key",
    }).expect(428);
    expect(await stateOf(configId)).toMatchObject({ isEnabled: false });
    expect(await auditsOf(configId, "flag.env.update")).toHaveLength(0);

    await patchEnv(owner, flag.id, prod, {
      isEnabled: true,
      confirmFlagKey: flag.key,
    }).expect(200);
    // Luật nhìn REQUEST, không nhìn trạng thái S1 đọc ngoài khoá: bật lại vẫn hỏi
    await patchEnv(owner, flag.id, prod, { isEnabled: true }).expect(428);
    await patchEnv(owner, flag.id, prod, { defaultVariantId: on }).expect(428);
    await patchEnv(owner, flag.id, prod, { isEnabled: false }).expect(200);
    expect(await stateOf(configId)).toMatchObject({ isEnabled: false });
  });

  it("sửa flag: DEVELOPER sửa mô tả được, đổi vòng đời/stickiness ⇒ 403; MAINTAINER đổi vòng đời cần xác nhận", async () => {
    const flag = await newFlag();
    const stamp = async () =>
      (await as(developer, request(app).get(`${flagsUrl()}/${flag.id}`))).body
        .flag.updatedAt as string;
    const patch = async (actor: Actor, body: object) =>
      as(
        actor,
        request(app)
          .patch(`${flagsUrl()}/${flag.id}`)
          .send({ lastKnownUpdatedAt: await stamp(), ...body }),
      );
    const lifecycle = async () =>
      (
        await admin.featureFlag.findUniqueOrThrow({
          where: { id: flag.id },
          select: { lifecycleStatus: true },
        })
      ).lifecycleStatus;

    const described = await patch(developer, { description: "mới" });
    expect(described.status).toBe(200);
    expect(described.body.flag.description).toBe("mới");
    // Vòng đời KHÔNG đổi ⇒ không phải thao tác toàn cục ⇒ DEVELOPER được
    expect(
      (await patch(developer, { lifecycleStatus: "DRAFT", description: "b" }))
        .status,
    ).toBe(200);
    expect((await patch(developer, { lifecycleStatus: "ACTIVE" })).status).toBe(
      403,
    );
    expect(
      (await patch(developer, { stickinessAttribute: "userId" })).status,
    ).toBe(403);

    const unconfirmed = await patch(owner, { lifecycleStatus: "ACTIVE" });
    expect(unconfirmed.status).toBe(428);
    expect(await lifecycle()).toBe("DRAFT");
    expect(
      (
        await patch(owner, {
          lifecycleStatus: "ACTIVE",
          confirmFlagKey: flag.key,
        })
      ).status,
    ).toBe(200);

    // Máy trạng thái §6.7 ở S2: về DRAFT ⇒ 422 không mã, chuyển nguyên vẹn
    const back = await patch(owner, {
      lifecycleStatus: "DRAFT",
      confirmFlagKey: flag.key,
    });
    expect(back.status).toBe(422);
    expect(back.body.detail).toMatch(/ACTIVE → DRAFT/);
    expect(back.body.detail).not.toMatch(/internal/);
    expect(await lifecycle()).toBe("ACTIVE");
  });

  it("mốc cũ ⇒ 409 OPTIMISTIC_LOCK kèm `current.updatedAt` là mốc ISO thật để Portal lưu lại", async () => {
    const flag = await newFlag();
    const res = await as(
      developer,
      request(app)
        .patch(`${flagsUrl()}/${flag.id}`)
        .send({
          lastKnownUpdatedAt: new Date(0).toISOString(),
          description: "x",
        }),
    ).expect(409);
    expect(res.body.code).toBe("OPTIMISTIC_LOCK");
    expect(res.body.current.updatedAt).toBe(flag.updatedAt);
  });
});

describe("rule theo environment", () => {
  it("GET cho id + mốc; PUT giữ id và KHÔNG trả bucketSalt; mốc cũ ⇒ 409 mà `current` cũng không có salt", async () => {
    const flag = await newFlag();
    const off = flag.variants.find((v) => v.key === "off")?.id;
    const on = flag.variants.find((v) => v.key === "on")?.id;
    const rulesUrl = `${flagsUrl()}/${flag.id}/envs/${envOf("dev").id}/rules`;

    const empty = await as(developer, request(app).get(rulesUrl)).expect(200);
    expect(empty.body.rules).toEqual([]);

    const put = await as(
      developer,
      request(app)
        .put(rulesUrl)
        .send({
          lastKnownUpdatedAt: empty.body.updatedAt,
          rules: [
            {
              ruleType: "ALL",
              condition: {},
              priority: 0,
              serve: {
                kind: "distribution",
                weights: [
                  { variantId: on, weight: 10_000 },
                  { variantId: off, weight: 90_000 },
                ],
              },
            },
          ],
        }),
    ).expect(200);
    expect(put.body.rules).toHaveLength(1);
    expect(JSON.stringify(put.body)).not.toMatch(/salt/i);

    const stale = await as(
      developer,
      request(app)
        .put(rulesUrl)
        .send({ lastKnownUpdatedAt: empty.body.updatedAt, rules: [] }),
    ).expect(409);
    expect(stale.body.code).toBe("OPTIMISTIC_LOCK");
    expect(stale.body.current.rules).toHaveLength(1);
    expect(JSON.stringify(stale.body)).not.toMatch(/salt/i);

    const again = await as(developer, request(app).get(rulesUrl)).expect(200);
    expect(again.body).toEqual(put.body);
  });

  it("serve trỏ variant của flag KHÁC ⇒ 422 ORPHAN_RULE của S2 tới Portal nguyên vẹn", async () => {
    const flag = await newFlag();
    const foreign = (await newFlag()).variants[0]?.id;
    const rulesUrl = `${flagsUrl()}/${flag.id}/envs/${envOf("dev").id}/rules`;
    const current = await as(developer, request(app).get(rulesUrl)).expect(200);
    const res = await as(
      developer,
      request(app)
        .put(rulesUrl)
        .send({
          lastKnownUpdatedAt: current.body.updatedAt,
          rules: [
            {
              ruleType: "ALL",
              condition: {},
              priority: 0,
              serve: { kind: "variant", variantId: foreign },
            },
          ],
        }),
    ).expect(422);
    expect(res.body.code).toBe("ORPHAN_RULE");
  });

  it("sửa rule ở prod: DEVELOPER ⇒ 403", async () => {
    const flag = await newFlag();
    const rulesUrl = `${flagsUrl()}/${flag.id}/envs/${envOf("prod").id}/rules`;
    const current = await as(developer, request(app).get(rulesUrl)).expect(200);
    await as(
      developer,
      request(app)
        .put(rulesUrl)
        .send({ lastKnownUpdatedAt: current.body.updatedAt, rules: [] }),
    ).expect(403);
  });
});

describe("[v4.6] Flag Evaluation Tester (§10.12)", () => {
  it("DRAFT thử được và được đánh dấu; bật ở dev ⇒ DEFAULT; context vượt trần ⇒ 400 trước khi gọi S2", async () => {
    const flag = await newFlag();
    const url = `${flagsUrl()}/${flag.id}/evaluate`;
    const evaluate = (context: object) =>
      as(
        developer,
        request(app)
          .post(url)
          .send({ envId: envOf("dev").id, context }),
      );

    const drafted = await evaluate({ targetingKey: "u1" }).expect(200);
    expect(drafted.body).toMatchObject({
      evaluation: { reason: "DISABLED" },
      draft: true,
      configVersion: expect.any(Number) as number,
    });

    await patchEnv(developer, flag.id, envOf("dev").id, {
      isEnabled: true,
    }).expect(200);
    const enabled = await evaluate({ targetingKey: "u1" }).expect(200);
    expect(enabled.body.evaluation).toMatchObject({
      reason: "DEFAULT",
      variant: "on",
    });

    const before = s2Calls;
    const wide = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`a${String(i)}`, i]),
    );
    await evaluate(wide).expect(400);
    expect(s2Calls).toBe(before);
  });
});

// ------------------------------------------------- [v4.9] vòng đời và telemetry

const DAY = 86_400_000;

const stampOf = async (flagId: string): Promise<string> =>
  (
    await admin.featureFlag.findUniqueOrThrow({
      where: { id: flagId },
      select: { updatedAt: true },
    })
  ).updatedAt.toISOString();

const patchFlag = async (
  actor: Actor,
  flagId: string,
  body: object,
): Promise<request.Response> =>
  as(
    actor,
    request(app)
      .patch(`${flagsUrl()}/${flagId}`)
      .send({ lastKnownUpdatedAt: await stampOf(flagId), ...body }),
  );

/** Flag ACTIVE của project chính — qua đường thật, có xác nhận hai bước */
async function activeFlag(): Promise<CreatedFlag> {
  const flag = await newFlag();
  const res = await patchFlag(owner, flag.id, {
    lifecycleStatus: "ACTIVE",
    confirmFlagKey: flag.key,
  });
  expect(res.status).toBe(200);
  return flag;
}

/** Một lượt đánh giá trong cửa sổ chốt archive, ở environment `dev` */
const seedRecent = (flagId: string, count = 3): Promise<void> =>
  seedEvalStats(admin, [
    {
      flagId,
      environmentId: envOf("dev").id,
      variantKey: "on",
      evalCount: count,
      bucketHour: hourFloor(new Date(Date.now() - DAY)),
    },
  ]);

const lifecycleOf = async (flagId: string): Promise<string> =>
  (
    await admin.featureFlag.findUniqueOrThrow({
      where: { id: flagId },
      select: { lifecycleStatus: true },
    })
  ).lifecycleStatus;

describe("[v4.9] Cleanup Center và stats qua Service 1", () => {
  it("GET /flags/stale đăng ký TRƯỚC /flags/:flagId: VIEWER ⇒ 200, không phải 400 uuid (AC-1.9)", async () => {
    const res = await as(
      viewer,
      request(app).get(`${flagsUrl()}/stale`),
    ).expect(200);
    expect(res.body).toMatchObject({
      counts: { UNUSED: expect.any(Number) as number },
      total: expect.any(Number) as number,
      telemetry: { observedDays: expect.any(Number) as number },
    });
    expect(Array.isArray(res.body.items)).toBe(true);
    // Tham số sai vẫn là 400 của chính route stale, không phải của route động
    await as(
      viewer,
      request(app).get(`${flagsUrl()}/stale`).query({ category: "KHONG-CO" }),
    ).expect(400);
  });

  it("GET /flags/:flagId/stats: VIEWER ⇒ 200, mỗi environment mang TÊN", async () => {
    const flag = await activeFlag();
    await seedRecent(flag.id, 7);
    const res = await as(
      viewer,
      request(app)
        .get(`${flagsUrl()}/${flag.id}/stats`)
        .query({ days: 7, envId: envOf("dev").id }),
    ).expect(200);

    expect(res.body.totals.evalCount).toBe(7);
    expect(res.body.byEnv).toHaveLength(1);
    expect(res.body.byEnv[0].environment).toEqual({
      id: envOf("dev").id,
      name: "dev",
      isProduction: false,
    });
    expect(res.body.byEnv[0].environmentId).toBeUndefined();
    expect(res.body.archive).toMatchObject({
      allowed: false,
      blockedBy: "RECENT_EVALUATIONS",
      evalCount7d: 7,
    });
  });

  it("tz sai ⇒ 400 ở S1, KHÔNG gọi S2; flag/env của project khác ⇒ 404", async () => {
    const flag = await activeFlag();
    const theirs = await newFlag(owner, other.projectId);
    const before = s2Calls;

    await as(
      viewer,
      request(app)
        .get(`${flagsUrl()}/${flag.id}/stats`)
        .query({ tz: "Mars/Base" }),
    ).expect(400);
    await as(
      viewer,
      request(app).get(`${flagsUrl()}/stale`).query({ limit: 0 }),
    ).expect(400);
    await as(
      viewer,
      request(app).get(`${flagsUrl()}/${theirs.id}/stats`),
    ).expect(404);
    await as(
      viewer,
      request(app)
        .get(`${flagsUrl()}/${flag.id}/stats`)
        .query({ envId: envIn(other.envs, "dev").id }),
    ).expect(404);
    expect(s2Calls).toBe(before);
  });

  it("include=stats: thiếu envId ⇒ 400; có envId ⇒ mỗi hàng kèm evalCount7d và daily14", async () => {
    const flag = await activeFlag();
    await seedRecent(flag.id, 5);
    await as(
      viewer,
      request(app).get(flagsUrl()).query({ include: "stats" }),
    ).expect(400);

    const res = await as(
      viewer,
      request(app)
        .get(flagsUrl())
        .query({ include: "stats", envId: envOf("dev").id, search: flag.key }),
    ).expect(200);
    expect(res.body.flags).toHaveLength(1);
    expect(res.body.flags[0].stats).toEqual({
      evalCount7d: 5,
      daily14: expect.any(Array) as number[],
    });
    expect(res.body.flags[0].stats.daily14).toHaveLength(14);

    // Không hỏi stats thì không có trường đó, và không có lời gọi tổng hợp nào
    const plain = await as(
      viewer,
      request(app)
        .get(flagsUrl())
        .query({ envId: envOf("dev").id }),
    ).expect(200);
    expect(plain.body.flags[0].stats).toBeUndefined();
  });

  it("archive một flag: DEVELOPER ⇒ 403; thiếu xác nhận ⇒ 428; còn lượt ⇒ 409 nguyên mã, KHÔNG có `current` (AC-1.1)", async () => {
    const flag = await activeFlag();
    await seedRecent(flag.id);

    expect(
      (await patchFlag(developer, flag.id, { lifecycleStatus: "ARCHIVED" }))
        .status,
    ).toBe(403);
    const unconfirmed = await patchFlag(maintainer, flag.id, {
      lifecycleStatus: "ARCHIVED",
    });
    expect(unconfirmed.status).toBe(428);
    expect(unconfirmed.body.code).toBe("CONFIRMATION_REQUIRED");

    const blocked = await patchFlag(maintainer, flag.id, {
      lifecycleStatus: "ARCHIVED",
      confirmFlagKey: flag.key,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("FLAG_RECENTLY_EVALUATED");
    expect(blocked.body.detail).toMatch(/lượt đánh giá/);
    // V10: `current` là trường độc quyền của OPTIMISTIC_LOCK
    expect(blocked.body.current).toBeUndefined();
    expect(await lifecycleOf(flag.id)).toBe("ACTIVE");

    // Không còn lượt nào trong cửa sổ ⇒ archive được
    const free = await activeFlag();
    expect(
      (
        await patchFlag(maintainer, free.id, {
          lifecycleStatus: "ARCHIVED",
          confirmFlagKey: free.key,
        })
      ).status,
    ).toBe(200);
  });

  it("permanent: DEVELOPER sửa được, không cần xác nhận, và flag rời danh sách stale (AC-1.11)", async () => {
    const flag = await activeFlag();
    await admin.featureFlag.update({
      where: { id: flag.id },
      data: { activatedAt: new Date(Date.now() - 60 * DAY) },
    });
    // Project phải có telemetry để xét UNUSED
    await seedEvalStats(admin, [
      {
        flagId: flag.id,
        environmentId: envOf("dev").id,
        variantKey: "on",
        evalCount: 1,
        bucketHour: hourFloor(new Date(Date.now() - 50 * DAY)),
      },
    ]);
    const staleKeys = async (): Promise<string[]> =>
      (
        (await as(viewer, request(app).get(`${flagsUrl()}/stale`)).expect(200))
          .body.items as { flag: { id: string } }[]
      ).map((item) => item.flag.id);
    expect(await staleKeys()).toContain(flag.id);

    const res = await patchFlag(developer, flag.id, { permanent: true });
    expect(res.status).toBe(200);
    expect(res.body.flag.permanent).toBe(true);
    expect(await staleKeys()).not.toContain(flag.id);
  });
});

describe("[v4.9] POST /flags/bulk-archive (V16)", () => {
  const bulkUrl = () => `${flagsUrl()}/bulk-archive`;
  const projectNameOf = async (): Promise<string> =>
    (
      await admin.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { name: true },
      })
    ).name;

  const target = async (flagId: string) => ({
    flagId,
    lastKnownUpdatedAt: await stampOf(flagId),
  });

  it("400 trước 428: quá 20 flag, id trùng, hay sai kiểu ⇒ 400 và S2 không bị gọi", async () => {
    const before = s2Calls;
    const many = Array.from(
      { length: STALE_FLAG_THRESHOLDS.bulkArchiveMax + 1 },
      () => ({
        flagId: randomUUID(),
        lastKnownUpdatedAt: new Date().toISOString(),
      }),
    );
    await as(
      maintainer,
      request(app)
        .post(bulkUrl())
        .send({ flags: many, confirmProjectName: await projectNameOf() }),
    ).expect(400);

    const dup = {
      flagId: randomUUID(),
      lastKnownUpdatedAt: new Date().toISOString(),
    };
    await as(
      maintainer,
      request(app)
        .post(bulkUrl())
        .send({ flags: [dup, dup], confirmProjectName: await projectNameOf() }),
    ).expect(400);

    await as(
      maintainer,
      request(app)
        .post(bulkUrl())
        .send({ flags: [dup], confirmProjectName: 42 }),
    ).expect(400);
    expect(s2Calls).toBe(before);
  });

  it("thiếu hay sai confirmProjectName ⇒ 428 và 0 lời gọi S2 (AC-1.12, F9/F10)", async () => {
    const flag = await activeFlag();
    const before = s2Calls;
    const name = await projectNameOf();

    const missing = await as(
      maintainer,
      request(app)
        .post(bulkUrl())
        .send({ flags: [await target(flag.id)] }),
    ).expect(428);
    expect(missing.body.code).toBe("CONFIRMATION_REQUIRED");
    expect(missing.body.detail).toContain(name);

    // Sai đúng MỘT ký tự
    await as(
      maintainer,
      request(app)
        .post(bulkUrl())
        .send({
          flags: [await target(flag.id)],
          confirmProjectName: `${name}x`,
        }),
    ).expect(428);
    expect(s2Calls).toBe(before);
    expect(await lifecycleOf(flag.id)).toBe("ACTIVE");
  });

  it("confirmProjectName so sau trim + NFC: khoảng trắng hai đầu và NFD vẫn khớp (F9, X-1)", async () => {
    const flag = await activeFlag();
    const name = await projectNameOf();
    const res = await as(
      maintainer,
      request(app)
        .post(bulkUrl())
        .send({
          flags: [await target(flag.id)],
          confirmProjectName: `  ${name.normalize("NFD")}  `,
        }),
    ).expect(200);
    expect(res.body.results[0].ok).toBe(true);
    expect(await lifecycleOf(flag.id)).toBe("ARCHIVED");
  });

  it("quyền: DEVELOPER ⇒ 403; VIEWER ⇒ 403", async () => {
    const flag = await activeFlag();
    const body = {
      flags: [await target(flag.id)],
      confirmProjectName: await projectNameOf(),
    };
    await as(developer, request(app).post(bulkUrl()).send(body)).expect(403);
    await as(viewer, request(app).post(bulkUrl()).send(body)).expect(403);
  });

  it("một flag ngoài project ⇒ 404 CẢ request, TRƯỚC mọi lần ghi", async () => {
    const mine = await activeFlag();
    const theirs = await newFlag(owner, other.projectId);
    await as(
      maintainer,
      request(app)
        .post(bulkUrl())
        .send({
          flags: [await target(mine.id), await target(theirs.id)],
          confirmProjectName: await projectNameOf(),
        }),
    ).expect(404);
    expect(await lifecycleOf(mine.id)).toBe("ACTIVE");
    expect(await lifecycleOf(theirs.id)).toBe("DRAFT");
  });

  it("lô 3 flag, flag giữa còn lượt ⇒ 200 với 2 ok và 1 problem nguyên vẹn (AC-1.12, R31)", async () => {
    const first = await activeFlag();
    const blocked = await activeFlag();
    const last = await activeFlag();
    await seedRecent(blocked.id, 12);

    const res = await as(
      maintainer,
      request(app)
        .post(bulkUrl())
        .send({
          flags: [
            await target(first.id),
            await target(blocked.id),
            await target(last.id),
          ],
          confirmProjectName: await projectNameOf(),
        }),
    ).expect(200);

    const results = res.body.results as {
      flagId: string;
      ok: boolean;
      problem?: { status: number; code: string; detail?: string };
      flag?: { lifecycleStatus: string };
    }[];
    expect(results.map((row) => row.flagId)).toEqual([
      first.id,
      blocked.id,
      last.id,
    ]);
    expect(results[0]?.flag?.lifecycleStatus).toBe("ARCHIVED");
    expect(results[2]?.flag?.lifecycleStatus).toBe("ARCHIVED");
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.problem).toMatchObject({
      status: 409,
      code: "FLAG_RECENTLY_EVALUATED",
    });
    expect(results[1]?.problem?.detail).toMatch(/lượt đánh giá/);
    // Lỗi của một flag KHÔNG dừng các flag sau
    expect(await lifecycleOf(blocked.id)).toBe("ACTIVE");
    expect(await lifecycleOf(last.id)).toBe("ARCHIVED");

    // Mỗi flag thành công có đúng một hàng audit flag.archive
    for (const flag of [first, last]) {
      expect(await auditsOf(flag.id, "flag.archive")).toHaveLength(1);
    }
  });

  it("S2 trả 503 ở flag thứ 3 ⇒ 503 nêu số đã áp dụng, 2 flag đầu đã archive", async () => {
    const flags = [await activeFlag(), await activeFlag(), await activeFlag()];
    let patches = 0;
    const flaky = appWith((input, init) => {
      if (
        init?.method === "PATCH" &&
        String(input).includes("/internal/flags/")
      ) {
        patches += 1;
        if (patches === 3) {
          return Promise.resolve(Response.json({}, { status: 503 }));
        }
      }
      return fetch(input, init);
    });

    const body = {
      flags: await Promise.all(flags.map((flag) => target(flag.id))),
      confirmProjectName: await projectNameOf(),
    };
    const res = await as(
      maintainer,
      request(flaky).post(bulkUrl()).send(body),
    ).expect(503);
    expect(res.body.code).toBe("PROVIDER_UNAVAILABLE");
    expect(res.body.detail).toContain("2/3");

    expect(await lifecycleOf(flags[0]!.id)).toBe("ARCHIVED");
    expect(await lifecycleOf(flags[1]!.id)).toBe("ARCHIVED");
    expect(await lifecycleOf(flags[2]!.id)).toBe("ACTIVE");
  });

  it("S2 trả 403 ⇒ 500 (lỗi hợp đồng, không phải lỗi của người dùng)", async () => {
    const flag = await activeFlag();
    const forbidden = appWith((input, init) =>
      init?.method === "PATCH" && String(input).includes("/internal/flags/")
        ? Promise.resolve(Response.json({}, { status: 403 }))
        : fetch(input, init),
    );
    const res = await as(
      maintainer,
      request(forbidden)
        .post(bulkUrl())
        .send({
          flags: [await target(flag.id)],
          confirmProjectName: await projectNameOf(),
        }),
    );
    expect(res.status).toBe(500);
    expect(await lifecycleOf(flag.id)).toBe("ACTIVE");
  });
});

describe("lỗi cấu hình giữa hai service KHÔNG tới Portal như lỗi của người dùng", () => {
  it("S1 cầm sai bí mật nội bộ ⇒ S2 trả 401 ⇒ S1 trả 500 (không 401 — Portal sẽ đăng xuất người dùng)", async () => {
    const misconfigured = createApp({
      metricsFor: () => new FakeMetricsProvider(),
      oidcIssuer: null,
      cloud: inertCloudPlatform,
      repoSource: noRepoSource,
      egressFetch: noEgress,
      platform: outsidePlatform,
      auth: noExternalAuth,
      domainRegistry: noDomainAdapters,
      provisioning: inertProvisioning,
      flagService: createFlagServiceClient({
        baseUrl: s2?.baseUrl ?? "",
        secret: "x".repeat(40),
      }),
    });
    const res = await as(
      developer,
      request(misconfigured)
        .post(flagsUrl())
        .send({ key: `f-${randomUUID().slice(0, 8)}`, flagType: "BOOLEAN" }),
    );
    expect(res.status).toBe(500);
  });
});

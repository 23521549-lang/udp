import { randomUUID } from "node:crypto";
import { ACTOR_HEADER, CLIENT_IP_HEADER, env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import { startFlagService, type RunningService } from "@udp/test-support";
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

beforeAll(async () => {
  const started = await startFlagService();
  s2 = started;
  app = createApp({
    metricsFor: () => new FakeMetricsProvider(),
    flagService: createFlagServiceClient({
      baseUrl: started.baseUrl,
      secret: env.INTERNAL_SERVICE_SECRET,
      fetch: (input, init) => {
        s2Calls += 1;
        return fetch(input, init);
      },
    }),
  });
  world = testWorld(app, admin);
  owner = await world.newActor("flag-owner");
  developer = await world.newActor("flag-dev");
  ({ projectId, envs } = await world.newProject(owner));
  other = await world.newProject(owner);
  await world.addMember(owner, projectId, developer, "DEVELOPER");
}, 90_000);

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

describe("lỗi cấu hình giữa hai service KHÔNG tới Portal như lỗi của người dùng", () => {
  it("S1 cầm sai bí mật nội bộ ⇒ S2 trả 401 ⇒ S1 trả 500 (không 401 — Portal sẽ đăng xuất người dùng)", async () => {
    const misconfigured = createApp({
      metricsFor: () => new FakeMetricsProvider(),
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

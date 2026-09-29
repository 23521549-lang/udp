import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
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
import {
  noRepoSource,
  inertCloudPlatform,
  inertProvisioning,
  noDomainAdapters,
  outsidePlatform,
} from "./helpers/inert-deps.js";

/**
 * [Plan #44] Hai route cuối của Luồng 4 ở Service 1, Service 2 là tiến trình thật:
 * `PUT …/flags/:flagId/variants` (AC-3) và `POST …/flags/:flagId/promote` (AC-4).
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_variants_promote_admin",
});

let s2: RunningService | undefined;
let app: ReturnType<typeof createApp>;
let world: TestWorld;
let owner: Actor;
let developer: Actor;
let maintainer: Actor;
let projectId: string;
let envs: Record<string, ProjectEnv>;

beforeAll(async () => {
  s2 = await startFlagService();
  app = createApp({
    metricsFor: () => new FakeMetricsProvider(),
    oidcIssuer: null,
    cloud: inertCloudPlatform,
    repoSource: noRepoSource,
    platform: outsidePlatform,
    domainRegistry: noDomainAdapters,
    provisioning: inertProvisioning,
    flagService: createFlagServiceClient({
      baseUrl: s2.baseUrl,
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
  });
  world = testWorld(app, admin);
  owner = await world.newActor("vp-owner");
  developer = await world.newActor("vp-dev");
  maintainer = await world.newActor("vp-maint");
  ({ projectId, envs } = await world.newProject(owner));
  await world.addMember(owner, projectId, developer, "DEVELOPER");
  await world.addMember(owner, projectId, maintainer, "MAINTAINER");
}, 120_000);

afterAll(async () => {
  await s2?.stop();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  await world?.cleanup();
  await admin.$disconnect();
});

// ------------------------------------------------------------- helper

const flagsUrl = `${API}/projects/`;
const url = (flagId: string, rest = ""): string =>
  `${flagsUrl}${projectId}/flags/${flagId}${rest}`;
const envId = (name: string): string => {
  const found = envs[name];
  if (found === undefined) throw new Error(`thiếu env ${name}`);
  return found.id;
};

interface Variant {
  id: string;
  key: string;
  value: unknown;
}
interface FlagBody {
  id: string;
  key: string;
  updatedAt: string;
  defaultVariantId: string | null;
  variants: Variant[];
}

async function colorFlag(): Promise<FlagBody> {
  const res = await as(
    developer,
    request(app)
      .post(`${flagsUrl}${projectId}/flags`)
      .send({
        key: `vp-${randomUUID().slice(0, 8)}`,
        flagType: "STRING",
        variants: [
          { key: "blue", value: "#00f" },
          { key: "green", value: "#0f0" },
        ],
        defaultVariantKey: "green",
      }),
  ).expect(201);
  return res.body.flag as FlagBody;
}

async function activate(flag: FlagBody): Promise<FlagBody> {
  const res = await as(
    maintainer,
    request(app).patch(url(flag.id)).send({
      lastKnownUpdatedAt: flag.updatedAt,
      lifecycleStatus: "ACTIVE",
      confirmFlagKey: flag.key,
    }),
  ).expect(200);
  return res.body.flag as FlagBody;
}

const byKey = (variants: readonly Variant[], key: string): Variant => {
  const found = variants.find((v) => v.key === key);
  if (found === undefined) throw new Error(`thiếu variant ${key}`);
  return found;
};

interface Rules {
  updatedAt: string;
  rules: { id: string; ruleType: string; serve: unknown }[];
}

const rulesOf = async (flagId: string, env: string): Promise<Rules> =>
  (
    await as(
      developer,
      request(app).get(url(flagId, `/envs/${envId(env)}/rules`)),
    ).expect(200)
  ).body as Rules;

async function setRules(
  flagId: string,
  env: string,
  rules: object[],
  actor: Actor = developer,
): Promise<Rules> {
  const current = await rulesOf(flagId, env);
  return (
    await as(
      actor,
      request(app)
        .put(url(flagId, `/envs/${envId(env)}/rules`))
        .send({ lastKnownUpdatedAt: current.updatedAt, rules }),
    ).expect(200)
  ).body as Rules;
}

const vn = { all: [{ attribute: "country", operator: "eq", value: "VN" }] };

const saltOf = async (ruleId: string): Promise<string> =>
  (
    await admin.flagTargetingRule.findUniqueOrThrow({
      where: { id: ruleId },
      select: { bucketSalt: true },
    })
  ).bucketSalt;

const versionOf = async (env: string): Promise<number> =>
  (
    await admin.environment.findUniqueOrThrow({
      where: { id: envId(env) },
      select: { configVersion: true },
    })
  ).configVersion;

// ------------------------------------------------------------- PUT variants (AC-3)

describe("PUT /flags/:flagId/variants", () => {
  it("flag DRAFT: DEVELOPER sửa được; response cùng hình GET; audit do S2 ghi mang người làm", async () => {
    const flag = await colorFlag();
    const blue = byKey(flag.variants, "blue");
    const green = byKey(flag.variants, "green");
    const res = await as(
      developer,
      request(app)
        .put(url(flag.id, "/variants"))
        .send({
          lastKnownUpdatedAt: flag.updatedAt,
          variants: [
            { id: blue.id, key: "blue", value: "#0000ff" },
            { id: green.id, key: "green", value: "#0f0" },
            { key: "red", value: "#f00" },
          ],
        }),
    ).expect(200);
    const detail = await as(developer, request(app).get(url(flag.id))).expect(
      200,
    );
    expect(res.body.flag).toEqual(detail.body.flag);
    expect(byKey(res.body.flag.variants as Variant[], "blue")).toEqual({
      id: blue.id,
      key: "blue",
      value: "#0000ff",
    });
    const audits = await admin.auditLog.findMany({
      where: { targetId: flag.id, action: "flag.variants.update" },
      select: { actorUserId: true },
    });
    expect(audits).toEqual([{ actorUserId: developer.userId }]);
  });

  it("flag ACTIVE: DEVELOPER 403; MAINTAINER thiếu key 428; đủ key 200", async () => {
    const flag = await activate(await colorFlag());
    const body = {
      lastKnownUpdatedAt: flag.updatedAt,
      variants: [...flag.variants, { key: "red", value: "#f00" }],
    };
    await as(
      developer,
      request(app).put(url(flag.id, "/variants")).send(body),
    ).expect(403);
    const noKey = await as(
      maintainer,
      request(app).put(url(flag.id, "/variants")).send(body),
    ).expect(428);
    expect(noKey.body.code).toBe("CONFIRMATION_REQUIRED");
    await as(
      maintainer,
      request(app)
        .put(url(flag.id, "/variants"))
        .send({ ...body, confirmFlagKey: flag.key }),
    ).expect(200);
  });

  it("lỗi nghiệp vụ của S2 tới Portal nguyên mã: xoá mặc định ⇒ 409 VARIANT_IN_USE", async () => {
    const flag = await colorFlag();
    const blue = byKey(flag.variants, "blue");
    const res = await as(
      developer,
      request(app)
        .put(url(flag.id, "/variants"))
        .send({
          lastKnownUpdatedAt: flag.updatedAt,
          variants: [
            { id: blue.id, key: "blue", value: "#00f" },
            { key: "red", value: "#f00" },
          ],
        }),
    ).expect(409);
    expect(res.body.code).toBe("VARIANT_IN_USE");
  });
});

// ------------------------------------------------------------- promote (AC-4)

describe("POST /flags/:flagId/promote", () => {
  it("rule khớp giữ id và salt ĐÍCH (I1), rule mới salt mới, rule thừa bị bỏ; trả diff đã áp", async () => {
    const flag = await colorFlag();
    const blue = byKey(flag.variants, "blue");
    const green = byKey(flag.variants, "green");
    const source = await setRules(flag.id, "dev", [
      {
        ruleType: "ATTRIBUTE_BASED",
        condition: vn,
        serve: { kind: "variant", variantId: blue.id },
        priority: 10,
      },
      {
        ruleType: "ALL",
        condition: {},
        serve: { kind: "variant", variantId: green.id },
        priority: 20,
      },
    ]);
    const target = await setRules(flag.id, "staging", [
      {
        ruleType: "ATTRIBUTE_BASED",
        condition: vn,
        serve: { kind: "variant", variantId: green.id },
        priority: 10,
      },
      {
        ruleType: "USER_BASED",
        condition: { userIds: ["u1"] },
        serve: { kind: "variant", variantId: blue.id },
        priority: 20,
      },
    ]);
    const kept = target.rules[0]?.id ?? "";
    const keptSalt = await saltOf(kept);

    const res = await as(
      developer,
      request(app)
        .post(url(flag.id, "/promote"))
        .send({
          fromEnvId: envId("dev"),
          toEnvId: envId("staging"),
          sourceUpdatedAt: source.updatedAt,
          lastKnownUpdatedAt: target.updatedAt,
        }),
    ).expect(200);
    expect(res.body.changes).toBe(3);
    expect((res.body.diff as { kind: string }[]).map((d) => d.kind)).toEqual([
      "changed",
      "added",
      "removed",
    ]);
    const after = res.body.rules as Rules["rules"];
    expect(after.map((r) => r.ruleType)).toEqual(["ATTRIBUTE_BASED", "ALL"]);
    expect(after[0]?.id).toBe(kept);
    expect(after[0]?.serve).toMatchObject({ variantId: blue.id });
    expect(await saltOf(kept)).toBe(keptSalt);
    const added = after[1]?.id ?? "";
    expect(await saltOf(added)).not.toBe(
      await saltOf(source.rules[1]?.id ?? ""),
    );
  });

  it("0 thay đổi ⇒ 200 và KHÔNG tăng version của đích", async () => {
    const flag = await colorFlag();
    const source = await rulesOf(flag.id, "dev");
    const target = await rulesOf(flag.id, "staging");
    const before = await versionOf("staging");
    const res = await as(
      developer,
      request(app)
        .post(url(flag.id, "/promote"))
        .send({
          fromEnvId: envId("dev"),
          toEnvId: envId("staging"),
          sourceUpdatedAt: source.updatedAt,
          lastKnownUpdatedAt: target.updatedAt,
        }),
    ).expect(200);
    expect(res.body.changes).toBe(0);
    expect(await versionOf("staging")).toBe(before);
  });

  it("nguồn đổi từ lúc xem diff ⇒ 409 OPTIMISTIC_LOCK; cùng env ⇒ 400", async () => {
    const flag = await colorFlag();
    const green = byKey(flag.variants, "green");
    const stale = await rulesOf(flag.id, "dev");
    await setRules(flag.id, "dev", [
      {
        ruleType: "ALL",
        condition: {},
        serve: { kind: "variant", variantId: green.id },
        priority: 10,
      },
    ]);
    const target = await rulesOf(flag.id, "staging");
    const res = await as(
      developer,
      request(app)
        .post(url(flag.id, "/promote"))
        .send({
          fromEnvId: envId("dev"),
          toEnvId: envId("staging"),
          sourceUpdatedAt: stale.updatedAt,
          lastKnownUpdatedAt: target.updatedAt,
        }),
    ).expect(409);
    expect(res.body.code).toBe("OPTIMISTIC_LOCK");

    await as(
      developer,
      request(app)
        .post(url(flag.id, "/promote"))
        .send({
          fromEnvId: envId("dev"),
          toEnvId: envId("dev"),
          sourceUpdatedAt: stale.updatedAt,
          lastKnownUpdatedAt: stale.updatedAt,
        }),
    ).expect(400);
  });

  it("đích production: DEVELOPER 403; MAINTAINER thiếu key 428, đủ key 200", async () => {
    const flag = await colorFlag();
    const green = byKey(flag.variants, "green");
    const source = await setRules(flag.id, "dev", [
      {
        ruleType: "ALL",
        condition: {},
        serve: { kind: "variant", variantId: green.id },
        priority: 10,
      },
    ]);
    const target = await rulesOf(flag.id, "prod");
    const body = {
      fromEnvId: envId("dev"),
      toEnvId: envId("prod"),
      sourceUpdatedAt: source.updatedAt,
      lastKnownUpdatedAt: target.updatedAt,
    };
    await as(
      developer,
      request(app).post(url(flag.id, "/promote")).send(body),
    ).expect(403);
    await as(
      maintainer,
      request(app).post(url(flag.id, "/promote")).send(body),
    ).expect(428);
    const res = await as(
      maintainer,
      request(app)
        .post(url(flag.id, "/promote"))
        .send({ ...body, confirmFlagKey: flag.key }),
    ).expect(200);
    expect(res.body.changes).toBe(1);
  });
});

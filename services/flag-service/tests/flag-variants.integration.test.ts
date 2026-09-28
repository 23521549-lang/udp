import { randomUUID } from "node:crypto";
import { ACTOR_HEADER, env, INTERNAL_SECRET_HEADER } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { configHashOf } from "@udp/flag-evaluator";
import { snapshotOf } from "@udp/flag-snapshot";
import { disposeProject, stableOwner } from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/**
 * [Plan #44] `PUT /internal/flags/:id/variants` qua HTTP thật, dưới `udp_s2`: danh tính variant giữ
 * qua PUT (rule và mặc định không mồ côi — I39), ADR-05 trên mọi environment (version, outbox, hash
 * khớp snapshot đọc thẳng), audit cùng transaction (I40), và mọi ca từ chối KHÔNG để lại dấu vết.
 */

const app = createApp();
const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_variants_${randomUUID()}`,
});

let projectId = "";
let devId = "";
let prodId = "";
let actorId = "";

beforeAll(async () => {
  actorId = (await stableOwner(admin)).id;
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId: actorId,
      name: `variants-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-var-${suffix}-dev` },
          {
            name: "prod",
            rank: 1,
            isProduction: true,
            k8sNamespace: `udp-var-${suffix}-prod`,
          },
        ],
      },
    },
    select: {
      id: true,
      environments: { select: { id: true }, orderBy: { rank: "asc" } },
    },
  });
  projectId = project.id;
  devId = project.environments[0]?.id ?? "";
  prodId = project.environments[1]?.id ?? "";
}, 60_000);

afterAll(async () => {
  if (projectId !== "") await disposeProject(admin, projectId);
  await admin.$disconnect();
});

// ------------------------------------------------------------- helper

const internal = (req: request.Test): request.Test =>
  req
    .set(INTERNAL_SECRET_HEADER, env.INTERNAL_SERVICE_SECRET)
    .set(ACTOR_HEADER, actorId);

interface Variant {
  id: string;
  key: string;
  value: unknown;
}

/** Flag STRING (hoặc kiểu khác) đã ACTIVE, hai variant `blue`/`green`, mặc định `green` */
async function colorFlag(
  flagType: "STRING" | "NUMBER" | "BOOLEAN" = "STRING",
): Promise<{ id: string; key: string; variants: Variant[] }> {
  const key = `var-${randomUUID().slice(0, 8)}`;
  const body =
    flagType === "BOOLEAN"
      ? { projectId, key, flagType }
      : flagType === "NUMBER"
        ? {
            projectId,
            key,
            flagType,
            variants: [
              { key: "low", value: 1 },
              { key: "high", value: 9 },
            ],
          }
        : {
            projectId,
            key,
            flagType,
            variants: [
              { key: "blue", value: "#00f" },
              { key: "green", value: "#0f0" },
            ],
            defaultVariantKey: "green",
          };
  const created = await internal(request(app).post("/internal/flags"))
    .send(body)
    .expect(201);
  const activated = await internal(
    request(app).patch(`/internal/flags/${created.body.flag.id as string}`),
  )
    .send({
      lastKnownUpdatedAt: created.body.flag.updatedAt as string,
      lifecycleStatus: "ACTIVE",
    })
    .expect(200);
  return {
    id: activated.body.flag.id as string,
    key,
    variants: activated.body.flag.variants as Variant[],
  };
}

const stampOf = async (flagId: string): Promise<string> =>
  (
    await admin.featureFlag.findUniqueOrThrow({
      where: { id: flagId },
      select: { updatedAt: true },
    })
  ).updatedAt.toISOString();

const put = async (
  flagId: string,
  body: Record<string, unknown>,
): Promise<request.Response> =>
  internal(request(app).put(`/internal/flags/${flagId}/variants`)).send({
    lastKnownUpdatedAt: await stampOf(flagId),
    ...body,
  });

const byKey = (variants: readonly Variant[], key: string): Variant => {
  const found = variants.find((v) => v.key === key);
  if (found === undefined) throw new Error(`thiếu variant ${key}`);
  return found;
};

const versionsOf = async (): Promise<number[]> =>
  (
    await admin.environment.findMany({
      where: { projectId },
      select: { configVersion: true },
      orderBy: { rank: "asc" },
    })
  ).map((row) => row.configVersion);

const variantAudits = (flagId: string) =>
  admin.auditLog.findMany({
    where: { targetId: flagId, action: "flag.variants.update" },
    select: { actorUserId: true, before: true, after: true },
  });

async function configOf(
  flagId: string,
  environmentId: string,
): Promise<{ id: string; updatedAt: string }> {
  const row = await admin.flagEnvConfig.findFirstOrThrow({
    where: { flagId, environmentId },
    select: { id: true, updatedAt: true },
  });
  return { id: row.id, updatedAt: row.updatedAt.toISOString() };
}

/** Một rule ALL serve đúng variant này ở dev */
async function serveRule(flagId: string, variantId: string): Promise<void> {
  const config = await configOf(flagId, devId);
  await internal(request(app).put(`/internal/flag-envs/${config.id}/rules`))
    .send({
      lastKnownUpdatedAt: config.updatedAt,
      rules: [
        {
          ruleType: "ALL",
          condition: {},
          serve: { kind: "variant", variantId },
          priority: 10,
        },
      ],
    })
    .expect(200);
}

// ------------------------------------------------------------- ghi được

describe("PUT variants — ghi được", () => {
  it("sửa tại chỗ giữ id (rule trỏ nó vẫn hợp lệ), thêm variant; ADR-05 mọi env; audit một hàng", async () => {
    const flag = await colorFlag();
    const blue = byKey(flag.variants, "blue");
    const green = byKey(flag.variants, "green");
    await serveRule(flag.id, blue.id);
    const before = await versionsOf();

    const res = await put(flag.id, {
      variants: [
        { id: blue.id, key: "blue", value: "#0000ff" },
        { id: green.id, key: "green", value: "#0f0" },
        { key: "red", value: "#f00" },
      ],
    });
    expect(res.status).toBe(200);
    const after = res.body.flag.variants as Variant[];
    expect(byKey(after, "blue")).toEqual({
      id: blue.id,
      key: "blue",
      value: "#0000ff",
    });
    expect(byKey(after, "red").value).toBe("#f00");

    // Rule vẫn serve ĐÚNG id cũ
    const rule = await admin.flagTargetingRule.findFirstOrThrow({
      where: { flagEnvConfig: { flagId: flag.id, environmentId: devId } },
      select: { serve: true },
    });
    expect(rule.serve).toMatchObject({ kind: "variant", variantId: blue.id });

    expect(await versionsOf()).toEqual(before.map((v) => v + 1));
    for (const environmentId of [devId, prodId]) {
      const snapshot = await snapshotOf(admin, environmentId);
      const entry = snapshot.flags.find((f) => f.key === flag.key);
      expect(entry).toMatchObject({
        variants: { blue: "#0000ff", green: "#0f0", red: "#f00" },
      });
      const row = await admin.environment.findUniqueOrThrow({
        where: { id: environmentId },
        select: { configHash: true },
      });
      expect(row.configHash).toBe(configHashOf(snapshot));
    }

    const audits = await variantAudits(flag.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(actorId);
  });

  it("đổi chỗ hai key trong một lần lưu không đụng chỉ mục (flag_id, key)", async () => {
    const flag = await colorFlag();
    const blue = byKey(flag.variants, "blue");
    const green = byKey(flag.variants, "green");
    const res = await put(flag.id, {
      variants: [
        { id: blue.id, key: "green", value: "#00f" },
        { id: green.id, key: "blue", value: "#0f0" },
      ],
    });
    expect(res.status).toBe(200);
    const after = res.body.flag.variants as Variant[];
    expect(byKey(after, "green").id).toBe(blue.id);
    expect(byKey(after, "blue").id).toBe(green.id);
  });

  it("xoá mặc định CÙNG lúc chọn mặc định mới (kể cả variant mới cùng tên cũ) ⇒ 200", async () => {
    const flag = await colorFlag();
    const blue = byKey(flag.variants, "blue");
    const res = await put(flag.id, {
      variants: [
        { id: blue.id, key: "blue", value: "#00f" },
        { key: "green", value: "#00ff00" },
      ],
      defaultVariantKey: "green",
    });
    expect(res.status).toBe(200);
    const green = byKey(res.body.flag.variants as Variant[], "green");
    expect(green.id).not.toBe(byKey(flag.variants, "green").id);
    expect(res.body.flag.defaultVariantId).toBe(green.id);
  });
});

// ------------------------------------------------------------- từ chối

describe("PUT variants — từ chối, không để lại dấu vết", () => {
  async function rejected(
    flagId: string,
    body: Record<string, unknown>,
    status: number,
    code?: string,
  ): Promise<request.Response> {
    const versions = await versionsOf();
    const res = await put(flagId, body);
    expect(res.status).toBe(status);
    if (code !== undefined) expect(res.body.code).toBe(code);
    expect(await versionsOf()).toEqual(versions);
    expect(await variantAudits(flagId)).toHaveLength(0);
    return res;
  }

  it("xoá variant rule đang serve ⇒ 409 VARIANT_IN_USE (kiểm trước khi xoá, không đợi trigger UDP02)", async () => {
    const flag = await colorFlag();
    const blue = byKey(flag.variants, "blue");
    const green = byKey(flag.variants, "green");
    await serveRule(flag.id, blue.id);
    await rejected(
      flag.id,
      {
        variants: [
          { id: green.id, key: "green", value: "#0f0" },
          { key: "red", value: "#f00" },
        ],
      },
      409,
      "VARIANT_IN_USE",
    );
  });

  it("xoá mặc định của flag mà không chọn mặc định mới ⇒ 409 VARIANT_IN_USE", async () => {
    const flag = await colorFlag();
    const blue = byKey(flag.variants, "blue");
    await rejected(
      flag.id,
      {
        variants: [
          { id: blue.id, key: "blue", value: "#00f" },
          { key: "red", value: "#f00" },
        ],
      },
      409,
      "VARIANT_IN_USE",
    );
  });

  it("xoá variant là mặc định ở một environment ⇒ 409 VARIANT_IN_USE", async () => {
    const flag = await colorFlag();
    const blue = byKey(flag.variants, "blue");
    const green = byKey(flag.variants, "green");
    const config = await configOf(flag.id, prodId);
    await internal(request(app).patch(`/internal/flag-envs/${config.id}`))
      .send({ defaultVariantId: blue.id })
      .expect(200);
    await rejected(
      flag.id,
      {
        variants: [
          { id: green.id, key: "green", value: "#0f0" },
          { key: "red", value: "#f00" },
        ],
      },
      409,
      "VARIANT_IN_USE",
    );
  });

  it("flag BOOLEAN ⇒ 422; giá trị sai kiểu ⇒ 400; id lạ ⇒ 400; không đổi gì ⇒ 400", async () => {
    const bool = await colorFlag("BOOLEAN");
    await rejected(
      bool.id,
      {
        variants: bool.variants.map((v) => ({ ...v, value: !v.value })),
      },
      422,
    );

    const num = await colorFlag("NUMBER");
    await rejected(
      num.id,
      {
        variants: num.variants.map((v) => ({ ...v, value: String(v.value) })),
      },
      400,
    );

    const flag = await colorFlag();
    await rejected(
      flag.id,
      {
        variants: [
          { id: randomUUID(), key: "blue", value: "#00f" },
          { key: "green", value: "#0f0" },
        ],
      },
      400,
    );
    await rejected(flag.id, { variants: flag.variants }, 400);
  });

  it("mốc cũ ⇒ 409 OPTIMISTIC_LOCK kèm bản hiện tại", async () => {
    const flag = await colorFlag();
    const versions = await versionsOf();
    const res = await internal(
      request(app).put(`/internal/flags/${flag.id}/variants`),
    ).send({
      lastKnownUpdatedAt: new Date(0).toISOString(),
      variants: [...flag.variants, { key: "red", value: "#f00" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OPTIMISTIC_LOCK");
    expect(res.body.current.id).toBe(flag.id);
    expect(await versionsOf()).toEqual(versions);
  });

  it("rollout sống ⇒ 409 ROLLOUT_IN_PROGRESS kèm rollout", async () => {
    const flag = await colorFlag();
    const config = await configOf(flag.id, devId);
    const session = await admin.rolloutSession.create({
      data: {
        projectId,
        environmentId: devId,
        flagEnvConfigId: config.id,
        workloadName: "checkout",
        rolloutScope: "FLAG_LEVEL",
        strategy: "CANARY",
        controlMode: "UDP_DRIVEN",
        status: "IN_PROGRESS",
        thresholds: {},
        stepPercent: 10,
        createdById: actorId,
      },
      select: { id: true },
    });
    const res = await rejected(
      flag.id,
      { variants: [...flag.variants, { key: "red", value: "#f00" }] },
      409,
      "ROLLOUT_IN_PROGRESS",
    );
    expect(res.body.resourceId).toBe(session.id);
    await admin.rolloutSession.update({
      where: { id: session.id },
      data: { status: "DONE" },
    });
  });

  it("thiếu X-Udp-Actor-Id ⇒ 400, không ghi", async () => {
    const flag = await colorFlag();
    const versions = await versionsOf();
    await request(app)
      .put(`/internal/flags/${flag.id}/variants`)
      .set(INTERNAL_SECRET_HEADER, env.INTERNAL_SERVICE_SECRET)
      .send({
        lastKnownUpdatedAt: await stampOf(flag.id),
        variants: [...flag.variants, { key: "red", value: "#f00" }],
      })
      .expect(400);
    expect(await versionsOf()).toEqual(versions);
  });
});

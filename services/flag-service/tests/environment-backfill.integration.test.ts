import { randomUUID } from "node:crypto";
import { ACTOR_HEADER, env, INTERNAL_SECRET_HEADER } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { configHashOf } from "@udp/flag-evaluator";
import { createActiveFlag, stableOwner } from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { prismaEntryLoader } from "../src/changefeed/snapshot.cache.js";

/**
 * [v4.11, Plan #40 AC-1/2] `POST /internal/environments/:id/backfill` qua HTTP thật: environment
 * mới nhận một `FlagEnvConfig` TẮT cho mọi flag của project (kể cả DRAFT), qua ADR-05 — một
 * version, hash đúng snapshot, dòng `environment.backfilled` — và gọi lại không đổi gì.
 */

let actorId = "";
const app = createApp();
const SECRET = env.INTERNAL_SERVICE_SECRET;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_backfilltest_${randomUUID()}`,
});
const readEntry = prismaEntryLoader(admin);

let projectId: string;
let suffix: string;
let flagKeys: string[];

beforeAll(async () => {
  const owner = await stableOwner(admin);
  actorId = owner.id;
  suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId: owner.id,
      name: `backfilltest-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-bf-${suffix}-dev` },
        ],
      },
    },
    select: { id: true },
  });
  projectId = project.id;
  flagKeys = [`b-active-${suffix}`, `a-active-${suffix}`];
  for (const key of flagKeys) {
    await createActiveFlag(app, actorId, {
      projectId,
      key,
      flagType: "BOOLEAN",
    });
  }
  // Flag DRAFT cũng có hàng ở mọi environment (§8.4) — backfill không được bỏ nó
  const draft = `c-draft-${suffix}`;
  await request(app)
    .post("/internal/flags")
    .set(INTERNAL_SECRET_HEADER, SECRET)
    .set(ACTOR_HEADER, actorId)
    .send({ projectId, key: draft, flagType: "BOOLEAN" })
    .expect(201);
  flagKeys = [...flagKeys, draft].sort();
});

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (projectId !== undefined) {
    const environments = await admin.environment.findMany({
      where: { projectId },
      select: { id: true },
    });
    await admin.configChangeLog.deleteMany({
      where: { environmentId: { in: environments.map((e) => e.id) } },
    });
    await admin.auditLog.deleteMany({ where: { projectId } });
    await admin.project.delete({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

async function newEnvironment(name: string): Promise<string> {
  const row = await admin.environment.create({
    data: {
      projectId,
      name,
      rank: 9,
      k8sNamespace: `udp-bf-${suffix}-${name}`,
    },
    select: { id: true },
  });
  return row.id;
}

const backfill = (environmentId: string) =>
  request(app)
    .post(`/internal/environments/${environmentId}/backfill`)
    .set(INTERNAL_SECRET_HEADER, SECRET)
    .set(ACTOR_HEADER, actorId)
    .send({});

describe("POST /internal/environments/:id/backfill", () => {
  it("mọi flag (kể cả DRAFT) nhận hàng TẮT; một version, hash đúng snapshot, một dòng environment.backfilled", async () => {
    const qa = await newEnvironment("qa");

    const res = await backfill(qa).expect(200);
    expect(res.body).toEqual({ created: 3 });

    const configs = await admin.flagEnvConfig.findMany({
      where: { environmentId: qa },
      select: { isEnabled: true, flag: { select: { key: true } } },
    });
    expect(configs.map((c) => c.flag.key).sort()).toEqual(flagKeys);
    expect(configs.every((c) => !c.isEnabled)).toBe(true);

    const entry = await readEntry(qa);
    expect(entry.configVersion).toBe(1);
    expect(entry.configHash).toBe(configHashOf(entry.snapshot));

    const log = await admin.configChangeLog.findMany({
      where: { environmentId: qa },
      select: { changeType: true, payload: true, actorUserId: true },
    });
    expect(log).toEqual([
      {
        changeType: "environment.backfilled",
        payload: { addedFlagKeys: flagKeys },
        actorUserId: actorId,
      },
    ]);
  });

  it("gọi lại ⇒ không hàng thừa, version KHÔNG tăng; environment mới không có hàng audit nào (vẫn xoá được)", async () => {
    const staging = await newEnvironment("staging");
    await backfill(staging).expect(200);
    const again = await backfill(staging).expect(200);

    expect(again.body).toEqual({ created: 0 });
    expect(
      await admin.flagEnvConfig.count({ where: { environmentId: staging } }),
    ).toBe(3);
    expect((await readEntry(staging)).configVersion).toBe(1);
    expect(
      await admin.auditLog.count({ where: { environmentId: staging } }),
    ).toBe(0);
  });

  it("environment không tồn tại ⇒ 404; thiếu người làm ⇒ 400; thiếu bí mật nội bộ ⇒ 401", async () => {
    await backfill(randomUUID()).expect(404);
    const qa2 = await newEnvironment("qa2");
    await request(app)
      .post(`/internal/environments/${qa2}/backfill`)
      .set(INTERNAL_SECRET_HEADER, SECRET)
      .send({})
      .expect(400);
    await request(app)
      .post(`/internal/environments/${qa2}/backfill`)
      .set(ACTOR_HEADER, actorId)
      .send({})
      .expect(401);
    expect(
      await admin.flagEnvConfig.count({ where: { environmentId: qa2 } }),
    ).toBe(0);
  });
});

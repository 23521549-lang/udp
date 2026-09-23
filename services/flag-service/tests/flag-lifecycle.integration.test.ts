import { randomUUID } from "node:crypto";
import { ACTOR_HEADER, env, STALE_FLAG_THRESHOLDS } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { hourFloor } from "@udp/shared-types";
import {
  disposeProject,
  issueSdkKey,
  seedEvalStats,
  stableOwner,
} from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { configCache } from "../src/changefeed/index.js";
import * as flagService from "../src/modules/flag/flag.service.js";

/**
 * [v4.9] Vòng đời flag ở Service 2 qua HTTP thật (Tester 1.2): chốt archive 7
 * ngày, `change_type = 'flag.archived'`, audit `flag.activate`/`archive`/`restore`
 * (V11), và bia mộ trong snapshot.
 *
 * Hai tầng cố ý:
 *
 *   - **Qua HTTP** cho mọi ca có lề ≥ 1 ngày — đó là đường thật, gồm cả outbox,
 *     hash và audit trong cùng transaction.
 *   - **Gọi thẳng service với `asOf`** cho ca BIÊN chính xác tới giờ. Biên "7
 *     ngày" là một bất đẳng thức trên `bucket_hour`, và một test phụ thuộc đồng
 *     hồ máy chạy nó sẽ đỏ vào lúc nửa đêm chứ không phải lúc code sai.
 */

const app = createApp();
const SECRET = env.INTERNAL_SERVICE_SECRET;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GUARD_DAYS = STALE_FLAG_THRESHOLDS.archiveGuardDays;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_lifecycle_${randomUUID()}`,
});

let projectId = "";
let devId = "";
let prodId = "";
let otherProjectId = "";
let otherEnvId = "";
let actorId = "";
let serverKey = "";

/** Project hai environment — cùng hình với `makeProject(..., withProd)` của sdk-config */
async function makeProject(prefix: string): Promise<{
  id: string;
  envIds: string[];
}> {
  const owner = await stableOwner(admin);
  actorId = owner.id;
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId: owner.id,
      name: `${prefix}-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-${prefix}-${suffix}-dev` },
          {
            name: "prod",
            rank: 1,
            isProduction: true,
            k8sNamespace: `udp-${prefix}-${suffix}-prod`,
          },
        ],
      },
    },
    select: {
      id: true,
      environments: { select: { id: true }, orderBy: { rank: "asc" } },
    },
  });
  return { id: project.id, envIds: project.environments.map((e) => e.id) };
}

beforeAll(async () => {
  const mine = await makeProject("lifecycle");
  projectId = mine.id;
  devId = mine.envIds[0] ?? "";
  prodId = mine.envIds[1] ?? "";
  const other = await makeProject("lifecycle-other");
  otherProjectId = other.id;
  otherEnvId = other.envIds[0] ?? "";
  serverKey = await issueSdkKey(admin, {
    environmentId: devId,
    keyType: "SERVER",
    createdById: actorId,
  });
}, 60_000);

afterAll(async () => {
  if (projectId !== "") await disposeProject(admin, projectId);
  if (otherProjectId !== "") await disposeProject(admin, otherProjectId);
  await admin.$disconnect();
});

// ------------------------------------------------------------- helper

const internal = (req: request.Test): request.Test =>
  req.set("X-Internal-Secret", SECRET).set(ACTOR_HEADER, actorId);

const newKey = () => `life-${randomUUID().slice(0, 8)}`;

const stampOf = async (flagId: string): Promise<string> =>
  (
    await admin.featureFlag.findUniqueOrThrow({
      where: { id: flagId },
      select: { updatedAt: true },
    })
  ).updatedAt.toISOString();

const patch = async (flagId: string, body: object): Promise<request.Response> =>
  internal(request(app).patch(`/internal/flags/${flagId}`)).send({
    lastKnownUpdatedAt: await stampOf(flagId),
    ...body,
  });

/** Flag ACTIVE mới của project đang xét (hoặc của project khác) */
async function activeFlag(
  pid = projectId,
  key = newKey(),
): Promise<{ id: string; key: string }> {
  const created = await internal(request(app).post("/internal/flags"))
    .send({ projectId: pid, key, flagType: "BOOLEAN" })
    .expect(201);
  const id = created.body.flag.id as string;
  await patch(id, { lifecycleStatus: "ACTIVE" }).then((res) => {
    expect(res.status).toBe(200);
  });
  return { id, key };
}

const seed = (
  flagId: string,
  environmentId: string,
  variantKey: string,
  evalCount: number,
  agoMs: number,
): Promise<void> =>
  seedEvalStats(admin, [
    {
      flagId,
      environmentId,
      variantKey,
      evalCount,
      bucketHour: hourFloor(new Date(Date.now() - agoMs)),
    },
  ]);

const versionsOf = async (): Promise<number[]> =>
  (
    await admin.environment.findMany({
      where: { projectId },
      select: { configVersion: true },
      orderBy: { rank: "asc" },
    })
  ).map((row) => row.configVersion);

const auditsOf = (flagId: string) =>
  admin.auditLog.findMany({
    where: { targetId: flagId },
    select: { action: true },
    orderBy: { occurredAt: "asc" },
  });

/** Dòng outbox của MỘT flag — payload là `{flag: entry}` (`deltaOf`) */
async function outboxOf(
  flagKey: string,
): Promise<{ changeType: string; environmentId: string }[]> {
  const rows = await admin.configChangeLog.findMany({
    where: { environmentId: { in: [devId, prodId] } },
    select: { changeType: true, environmentId: true, payload: true },
  });
  return rows.filter(
    (row) => (row.payload as { flag?: { key?: string } }).flag?.key === flagKey,
  );
}

const lifecycleOf = async (flagId: string): Promise<string> =>
  (
    await admin.featureFlag.findUniqueOrThrow({
      where: { id: flagId },
      select: { lifecycleStatus: true },
    })
  ).lifecycleStatus;

/**
 * `flags` của `GET /sdk/config`.
 *
 * `reload` trước mỗi lần đọc: cache snapshot chỉ được làm mới bởi watcher tầng 2,
 * và watcher KHÔNG chạy trong test (timer chỉ khởi động ở `index.ts` sau
 * `listen`). Không có dòng này thì mọi lần đọc sau lần đầu trả đúng bộ ba cũ —
 * đó là hành vi đúng của cache, không phải thứ cần sửa ở runtime.
 */
const configFlags = async (): Promise<{ key: string; archived?: true }[]> => {
  await configCache.reload(devId, "SERVER");
  const res = await request(app)
    .get("/sdk/config")
    .set("Authorization", `Bearer ${serverKey}`)
    .expect(200);
  return res.body.flags as { key: string; archived?: true }[];
};

// ------------------------------------------------------------- chốt 7 ngày

describe("chốt archive 7 ngày (§3.4)", () => {
  it("còn lượt trong cửa sổ ⇒ 409 FLAG_RECENTLY_EVALUATED; flag, version, audit, outbox đứng yên", async () => {
    const flag = await activeFlag();
    await seed(flag.id, devId, "on", 5, 3 * DAY);
    const versions = await versionsOf();
    const audits = (await auditsOf(flag.id)).length;
    const outbox = (await outboxOf(flag.key)).length;

    const res = await patch(flag.id, { lifecycleStatus: "ARCHIVED" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("FLAG_RECENTLY_EVALUATED");
    // V10: Problem chỉ mang `title`/`detail` — `current` là của OPTIMISTIC_LOCK
    expect(res.body.current).toBeUndefined();
    expect(res.body.detail).toMatch(/lượt đánh giá/);

    expect(await lifecycleOf(flag.id)).toBe("ACTIVE");
    expect(await versionsOf()).toEqual(versions);
    expect(await auditsOf(flag.id)).toHaveLength(audits);
    expect(await outboxOf(flag.key)).toHaveLength(outbox);
  });

  it("lượt ở environment KHÁC của cùng flag vẫn chặn", async () => {
    const flag = await activeFlag();
    await seed(flag.id, prodId, "off", 1, 2 * DAY);
    const res = await patch(flag.id, { lifecycleStatus: "ARCHIVED" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("FLAG_RECENTLY_EVALUATED");
  });

  it("hàng eval_count = 0 KHÔNG chặn — hàng rỗng không phải một lượt đánh giá", async () => {
    const flag = await activeFlag();
    await seed(flag.id, devId, "on", 0, 2 * DAY);
    expect((await patch(flag.id, { lifecycleStatus: "ARCHIVED" })).status).toBe(
      200,
    );
  });

  it("__disabled__ chặn (D1.1): flag tắt mà code vẫn gọi thì code vẫn phụ thuộc nó", async () => {
    const flag = await activeFlag();
    await seed(flag.id, devId, "__disabled__", 7, 2 * DAY);
    const res = await patch(flag.id, { lifecycleStatus: "ARCHIVED" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("FLAG_RECENTLY_EVALUATED");
  });

  it("chỉ có lượt cũ hơn cửa sổ ⇒ 200, outbox flag.archived, audit flag.archive, snapshot giữ bia mộ", async () => {
    const flag = await activeFlag();
    await seed(flag.id, devId, "on", 9, (GUARD_DAYS + 1) * DAY);
    expect(await configFlags()).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: flag.key })]),
    );

    expect((await patch(flag.id, { lifecycleStatus: "ARCHIVED" })).status).toBe(
      200,
    );

    const archived = (await outboxOf(flag.key)).filter(
      (row) => row.changeType === "flag.archived",
    );
    // Một dòng cho MỖI environment của project, và chỉ lần archive mới mang mã đó
    expect(archived).toHaveLength(2);
    expect(new Set(archived.map((row) => row.environmentId))).toEqual(
      new Set([devId, prodId]),
    );
    expect((await auditsOf(flag.id)).map((row) => row.action)).toEqual([
      "flag.create",
      "flag.activate",
      "flag.archive",
    ]);
    expect(await configFlags()).toEqual(
      expect.arrayContaining([{ key: flag.key, archived: true }]),
    );
  });

  it("I14: lượt của flag CÙNG KEY ở project khác không chặn", async () => {
    const key = newKey();
    const mine = await activeFlag(projectId, key);
    const theirs = await activeFlag(otherProjectId, key);
    await seed(theirs.id, otherEnvId, "on", 100, 1 * DAY);

    expect((await patch(mine.id, { lifecycleStatus: "ARCHIVED" })).status).toBe(
      200,
    );
  });

  it("DRAFT → ARCHIVED bỏ qua chốt dù có hàng stats (AC-1.3)", async () => {
    const created = await internal(request(app).post("/internal/flags"))
      .send({ projectId, key: newKey(), flagType: "BOOLEAN" })
      .expect(201);
    const id = created.body.flag.id as string;
    await seed(id, devId, "__disabled__", 50, 1 * HOUR);

    expect((await patch(id, { lifecycleStatus: "ARCHIVED" })).status).toBe(200);
    expect((await auditsOf(id)).map((row) => row.action)).toEqual([
      "flag.create",
      "flag.archive",
    ]);
  });

  it("biên chính xác: bucket ở asOf − 7 ngày chặn, sớm hơn 1 giờ thì không", async () => {
    const asOf = new Date("2026-09-01T12:34:56.000Z");
    const inside = hourFloor(
      new Date(hourFloor(asOf).getTime() - GUARD_DAYS * DAY),
    );
    const outside = new Date(inside.getTime() - HOUR);

    const blocked = await activeFlag();
    await seedEvalStats(admin, [
      {
        flagId: blocked.id,
        environmentId: devId,
        variantKey: "on",
        evalCount: 1,
        bucketHour: inside,
      },
    ]);
    await expect(
      flagService.update(
        blocked.id,
        {
          lastKnownUpdatedAt: await stampOf(blocked.id),
          lifecycleStatus: "ARCHIVED",
        },
        { actorUserId: actorId },
        asOf,
      ),
    ).rejects.toMatchObject({ problemCode: "FLAG_RECENTLY_EVALUATED" });

    const allowed = await activeFlag();
    await seedEvalStats(admin, [
      {
        flagId: allowed.id,
        environmentId: devId,
        variantKey: "on",
        evalCount: 1,
        bucketHour: outside,
      },
    ]);
    const updated = await flagService.update(
      allowed.id,
      {
        lastKnownUpdatedAt: await stampOf(allowed.id),
        lifecycleStatus: "ARCHIVED",
      },
      { actorUserId: actorId },
      asOf,
    );
    expect(updated.lifecycleStatus).toBe("ARCHIVED");
  });
});

// ------------------------------------------------------------- vòng đời

describe("audit theo vòng đời (V11) và khôi phục", () => {
  it("ARCHIVED → ACTIVE: audit flag.restore, snapshot có lại entry sống", async () => {
    const flag = await activeFlag();
    expect((await patch(flag.id, { lifecycleStatus: "ARCHIVED" })).status).toBe(
      200,
    );
    const restored = await patch(flag.id, { lifecycleStatus: "ACTIVE" });
    expect(restored.status).toBe(200);
    expect(restored.body.flag.activatedAt).not.toBeNull();

    expect((await auditsOf(flag.id)).map((row) => row.action)).toEqual([
      "flag.create",
      "flag.activate",
      "flag.archive",
      "flag.restore",
    ]);
    const live = (await configFlags()).find((row) => row.key === flag.key);
    expect(live?.archived).toBeUndefined();
  });

  it("PATCH vừa đổi vòng đời vừa đổi mô tả lấy action của VÒNG ĐỜI", async () => {
    const flag = await activeFlag();
    expect(
      (
        await patch(flag.id, {
          lifecycleStatus: "ARCHIVED",
          description: "gỡ khỏi code từ sprint trước",
        })
      ).status,
    ).toBe(200);
    expect((await auditsOf(flag.id)).at(-1)?.action).toBe("flag.archive");
  });

  it("sửa mô tả không đổi vòng đời vẫn là flag.update", async () => {
    const flag = await activeFlag();
    expect((await patch(flag.id, { description: "chỉ mô tả" })).status).toBe(
      200,
    );
    expect((await auditsOf(flag.id)).at(-1)?.action).toBe("flag.update");
  });

  it("permanent ghi được qua PATCH, không cần đổi vòng đời", async () => {
    const flag = await activeFlag();
    const res = await patch(flag.id, { permanent: true });
    expect(res.status).toBe(200);
    expect(res.body.flag.permanent).toBe(true);
    expect((await auditsOf(flag.id)).at(-1)?.action).toBe("flag.update");
    const row = await admin.featureFlag.findUniqueOrThrow({
      where: { id: flag.id },
      select: { permanent: true },
    });
    expect(row.permanent).toBe(true);
  });
});

// ------------------------------------------------------------- thứ tự lỗi

describe("thứ tự lỗi (D1.6) và guard của route", () => {
  it("mũi tên sai ⇒ 422 thắng chốt 7 ngày", async () => {
    const flag = await activeFlag();
    await seed(flag.id, devId, "on", 3, 1 * DAY);
    const res = await patch(flag.id, { lifecycleStatus: "DRAFT" });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/ACTIVE → DRAFT/);
  });

  it("rollout sống ⇒ 409 ROLLOUT_IN_PROGRESS thắng chốt 7 ngày", async () => {
    const flag = await activeFlag();
    await seed(flag.id, devId, "on", 3, 1 * DAY);
    const config = await admin.flagEnvConfig.findFirstOrThrow({
      where: { flagId: flag.id, environmentId: devId },
      select: { id: true },
    });
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

    const res = await patch(flag.id, { lifecycleStatus: "ARCHIVED" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "ROLLOUT_IN_PROGRESS",
      resourceId: session.id,
    });

    // Hết rollout thì chốt 7 ngày mới lên tiếng
    await admin.rolloutSession.update({
      where: { id: session.id },
      data: { status: "DONE" },
    });
    const after = await patch(flag.id, { lifecycleStatus: "ARCHIVED" });
    expect(after.status).toBe(409);
    expect(after.body.code).toBe("FLAG_RECENTLY_EVALUATED");
  });

  it("archive thiếu X-Udp-Actor-Id ⇒ 400 và không đổi gì", async () => {
    const flag = await activeFlag();
    const versions = await versionsOf();
    await request(app)
      .patch(`/internal/flags/${flag.id}`)
      .set("X-Internal-Secret", SECRET)
      .send({
        lastKnownUpdatedAt: await stampOf(flag.id),
        lifecycleStatus: "ARCHIVED",
      })
      .expect(400);
    expect(await lifecycleOf(flag.id)).toBe("ACTIVE");
    expect(await versionsOf()).toEqual(versions);
  });
});

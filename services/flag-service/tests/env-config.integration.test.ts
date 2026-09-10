import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { configHashOf, type Snapshot } from "@udp/flag-evaluator";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { stableOwner } from "./helpers/fixture.js";
import { prismaEntryLoader } from "../src/changefeed/snapshot.cache.js";

/**
 * `PATCH /internal/flag-envs/:id` qua HTTP thật (Plan #12, Mục 1).
 *
 * Trọng tâm là những tính chất mà một test "bật được flag" không nói gì tới:
 * chỉ ĐÚNG environment đó bị đánh thức, delta đủ để replica tự dựng lại cấu
 * hình, và một variant của flag khác bị database chặn mà không để lại dấu vết.
 */

const app = createApp();
const SECRET = env.INTERNAL_SERVICE_SECRET;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_envcfgtest_${randomUUID()}`,
});

/** Đọc `(version, hash, snapshot)` trong MỘT ảnh chụp — y như `/sdk/config` */
const readEntry = prismaEntryLoader(admin);

let projectId: string;
let envIds: string[];
let devEnv: string;
let prodEnv: string;
let flagId: string;
let flagKey: string;
let variantIdOf: Record<string, string>;
let foreignVariantId: string;

const createFlag = (key: string): request.Test =>
  request(app)
    .post("/internal/flags")
    .set("X-Internal-Secret", SECRET)
    .send({ projectId, key, flagType: "BOOLEAN" });

beforeAll(async () => {
  const owner = await stableOwner(admin);
  const suffix = randomUUID().slice(0, 8);

  const project = await admin.project.create({
    data: {
      ownerId: owner.id,
      name: `envcfgtest-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-envcfg-${suffix}-dev` },
          { name: "prod", rank: 1, k8sNamespace: `udp-envcfg-${suffix}-prd` },
        ],
      },
    },
    select: {
      id: true,
      environments: { select: { id: true }, orderBy: { rank: "asc" } },
    },
  });

  projectId = project.id;
  envIds = project.environments.map((e) => e.id);
  devEnv = envIds[0]!;
  prodEnv = envIds[1]!;

  flagKey = `toggle-${suffix}`;
  const created = await createFlag(flagKey).expect(201);
  flagId = created.body.flag.id as string;
  variantIdOf = Object.fromEntries(
    (created.body.flag.variants as { id: string; key: string }[]).map((v) => [
      v.key,
      v.id,
    ]),
  );

  // Một flag KHÁC, chỉ để lấy một variant không thuộc `flagId`
  const other = await createFlag(`other-${suffix}`).expect(201);
  foreignVariantId = (other.body.flag.variants as { id: string }[])[0]!.id;
});

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (projectId !== undefined) {
    await admin.configChangeLog.deleteMany({
      where: { environmentId: { in: envIds } },
    });
    await admin.project.delete({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

const envConfigIdOf = async (environmentId: string): Promise<string> =>
  (
    await admin.flagEnvConfig.findFirstOrThrow({
      where: { flagId, environmentId },
      select: { id: true },
    })
  ).id;

const versions = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    (
      await admin.environment.findMany({
        where: { id: { in: envIds } },
        select: { id: true, configVersion: true },
      })
    ).map((e) => [e.id, e.configVersion]),
  );

const patch = (id: string, body: object): request.Test =>
  request(app)
    .patch(`/internal/flag-envs/${id}`)
    .set("X-Internal-Secret", SECRET)
    .send(body);

const entryOf = (snapshot: Snapshot, key: string) => {
  const entry = snapshot.flags.find((f) => f.key === key);
  if (entry === undefined || "archived" in entry) {
    throw new Error(`snapshot không có flag ${key}`);
  }
  return entry;
};

describe("PATCH /internal/flag-envs/:id — chạm đúng MỘT environment", () => {
  it("bật flag ở dev: chỉ dev tăng config_version, prod đứng yên", async () => {
    /**
     * Bật flag ở `dev` mà đánh thức cả `prod` là bắt mọi SDK của `prod` tải lại
     * cấu hình vì một thay đổi không liên quan tới họ. Chính `writeWithOutbox`
     * không chặn được chuyện này — nó khoá đúng những environment được đưa vào,
     * nên nếu service đưa nhầm cả project thì ở tầng dưới mọi thứ vẫn "đúng".
     */
    const before = await versions();
    const res = await patch(await envConfigIdOf(devEnv), {
      isEnabled: true,
    }).expect(200);

    expect(res.body.envConfig.isEnabled).toBe(true);

    const after = await versions();
    expect(after[devEnv]).toBe((before[devEnv] ?? -1) + 1);
    expect(after[prodEnv]).toBe(before[prodEnv]);
  });

  it("ghi outbox envconfig.toggled, và delta áp lên snapshot cũ cho ra đúng config_hash mới", async () => {
    /**
     * I15c thu nhỏ cho đường này: replica chỉ có snapshot cũ cộng dòng outbox, và
     * phải tự dựng ra đúng con số S2 đã ghi — không đọc lại gì từ database.
     */
    const before = (await readEntry(devEnv)).snapshot;
    await patch(await envConfigIdOf(devEnv), { isEnabled: false }).expect(200);
    const after = await readEntry(devEnv);

    const log = await admin.configChangeLog.findUniqueOrThrow({
      where: {
        environmentId_configVersion: {
          environmentId: devEnv,
          configVersion: after.configVersion,
        },
      },
      select: { changeType: true, payload: true },
    });
    expect(log.changeType).toBe("envconfig.toggled");

    const delta = log.payload as unknown as { flag: Snapshot["flags"][number] };
    const applied: Snapshot = {
      ...before,
      flags: [...before.flags.filter((f) => f.key !== flagKey), delta.flag],
    };

    expect(configHashOf(applied)).toBe(after.configHash);
    expect(entryOf(after.snapshot, flagKey).isEnabled).toBe(false);
  });

  it("override default variant ở dev thắng default của flag — và CHỈ ở dev", async () => {
    /**
     * §6.5: `envConfig.defaultVariantId ?? flag.defaultVariantId`. Flag BOOLEAN
     * sinh ra với default là `on`; đặt override `off` ở dev thì snapshot của dev
     * phải nói `off`, còn prod — chưa ai đụng tới — vẫn nói `on`.
     */
    await patch(await envConfigIdOf(devEnv), {
      defaultVariantId: variantIdOf["off"],
    }).expect(200);

    expect(
      entryOf((await readEntry(devEnv)).snapshot, flagKey).defaultVariantKey,
    ).toBe("off");
    expect(
      entryOf((await readEntry(prodEnv)).snapshot, flagKey).defaultVariantKey,
    ).toBe("on");
  });

  it("defaultVariantId = null bỏ override, quay về default của flag", async () => {
    await patch(await envConfigIdOf(devEnv), {
      defaultVariantId: null,
    }).expect(200);

    expect(
      entryOf((await readEntry(devEnv)).snapshot, flagKey).defaultVariantKey,
    ).toBe("on");
  });
});

describe("những gì phải bị từ chối", () => {
  it("variant của flag KHÁC ⇒ 422 ORPHAN_RULE, và config_version KHÔNG đổi", async () => {
    /**
     * Trigger ở database chặn, và cả transaction ADR-05 phải rollback theo — gồm
     * bước tăng version đã chạy trước đó. Nếu version vẫn tăng thì mọi replica bị
     * đánh thức để tải về một cấu hình không hề đổi.
     */
    const before = await versions();
    const res = await patch(await envConfigIdOf(devEnv), {
      defaultVariantId: foreignVariantId,
    }).expect(422);

    expect(res.body.code).toBe("ORPHAN_RULE");
    expect(await versions()).toEqual(before);
  });

  it("body rỗng ⇒ 400: không có gì để đổi thì không được tăng version", async () => {
    await patch(await envConfigIdOf(devEnv), {}).expect(400);
  });

  it("trường gõ sai tên ⇒ 400, không bị nuốt im lặng", async () => {
    /** `isEnable` thiếu chữ `d`: nuốt im lặng là trả 200 trong khi không bật gì */
    await patch(await envConfigIdOf(devEnv), { isEnable: true }).expect(400);
  });

  it("id không phải UUID ⇒ 400; id không tồn tại ⇒ 404", async () => {
    await patch("khong-phai-uuid", { isEnabled: true }).expect(400);
    await patch(randomUUID(), { isEnabled: true }).expect(404);
  });

  it("thiếu bí mật nội bộ ⇒ 401", async () => {
    await request(app)
      .patch(`/internal/flag-envs/${await envConfigIdOf(devEnv)}`)
      .send({ isEnabled: true })
      .expect(401);
  });
});

import { randomUUID } from "node:crypto";
import { env, RATE_LIMIT, SDK_STATS } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { hourFloor } from "@udp/shared-types/flag-stats";
import {
  createActiveFlag,
  disposeProject,
  internalCall,
  newSdkKeyToken,
  sdkKeyData,
  stableOwner,
} from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { statsFlusher } from "../src/modules/stats/index.js";
import { statsIngest } from "../src/sdk/index.js";

/**
 * [v4.9] `POST /sdk/stats` qua HTTP thật, Service 2 trong tiến trình (Tester 2.2).
 *
 * Bốn nhóm ranh giới, không phải "gửi được số đếm":
 *
 *   - **I14 / R06** — environment và project suy ra TỪ KHOÁ. Hai project có flag
 *     CÙNG key: báo cáo bằng khoá của A không được cộng một lượt nào cho B.
 *   - **V6** — flag không có trong snapshot (lạ, DRAFT) và variant lạ bị bỏ qua
 *     IM LẶNG với 202: mã phản hồi khác nhau theo sự tồn tại của flag là kênh dò.
 *   - **INV-23.8** — body chỉ được parse SAU guard, kể cả với đường dẫn khác hoa
 *     thường hoặc có `/` cuối, và trần của nó là 2 MiB chứ không phải 1 MB của
 *     parser toàn cục.
 *   - **INV-23.4 / G12** — telemetry không chạm `config_version`, `config_hash`
 *     hay outbox.
 *
 * Flush gọi THẲNG (`statsFlusher.runOnce()`) như `snapshotWatcher.tick()` của
 * `sdk-stream`: không ca nào chờ 15 giây, và không timer nào chạy trong test.
 */

const app = createApp();
const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_stats_${randomUUID()}`,
});

const suffix = randomUUID().slice(0, 8);
const SERVER_DEV = newSdkKeyToken("SERVER");
const SERVER_PROD = newSdkKeyToken("SERVER");
const SERVER_OTHER = newSdkKeyToken("SERVER");
const CLIENT_DEV = newSdkKeyToken("CLIENT");
const REVOKED = newSdkKeyToken("SERVER");

/** Cùng key ở hai project — flag của B phải luôn đứng yên */
const SHARED_KEY = `stats-shared-${suffix}`;
const DRAFT_KEY = `stats-draft-${suffix}`;
const ARCHIVED_KEY = `stats-archived-${suffix}`;

let actorId = "";
let mine = { projectId: "", devEnv: "", prodEnv: "" };
let theirs = { projectId: "", devEnv: "" };
let sharedFlagId = "";
let otherFlagId = "";
let archivedFlagId = "";

const makeProject = async (
  tag: string,
  withProd: boolean,
): Promise<{ projectId: string; envIds: string[] }> => {
  const project = await admin.project.create({
    data: {
      ownerId: actorId,
      name: `stats-${tag}-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-stats-${tag}-${suffix}` },
          ...(withProd
            ? [
                {
                  name: "prod",
                  rank: 1,
                  k8sNamespace: `udp-stats-${tag}-${suffix}-p`,
                },
              ]
            : []),
        ],
      },
    },
    select: {
      id: true,
      environments: { select: { id: true }, orderBy: { rank: "asc" } },
    },
  });
  return {
    projectId: project.id,
    envIds: project.environments.map((e) => e.id),
  };
};

const postStats = (token: string, body: unknown, path = "/sdk/stats") =>
  request(app)
    .post(path)
    .set("Authorization", `Bearer ${token}`)
    .set("Content-Type", "application/json")
    .send(body as object);

const countsOf = async (
  flagId: string,
  environmentId: string,
): Promise<Map<string, bigint>> => {
  const rows = await admin.flagEvaluationStat.findMany({
    where: { flagId, environmentId },
    select: { variantKey: true, evalCount: true },
  });
  return new Map(rows.map((r) => [r.variantKey, r.evalCount]));
};

const bucketsOf = async (flagId: string, environmentId: string) =>
  admin.flagEvaluationStat.findMany({
    where: { flagId, environmentId },
    select: { variantKey: true, bucketHour: true, evalCount: true },
  });

/** Mốc bucket hợp lệ: giờ lúc gửi, hoặc giờ kế nếu ca chạy vắt qua ranh giới giờ */
const expectBucketNear = (bucketHour: Date, sentAt: number): void => {
  const first = hourFloor(new Date(sentAt)).getTime();
  const second = hourFloor(new Date()).getTime();
  expect([first, second]).toContain(bucketHour.getTime());
};

beforeAll(async () => {
  actorId = (await stableOwner(admin)).id;

  const a = await makeProject("mine", true);
  const b = await makeProject("other", false);
  mine = {
    projectId: a.projectId,
    devEnv: a.envIds[0] ?? "",
    prodEnv: a.envIds[1] ?? "",
  };
  theirs = { projectId: b.projectId, devEnv: b.envIds[0] ?? "" };

  await admin.sdkKey.createMany({
    data: [
      {
        token: SERVER_DEV,
        environmentId: mine.devEnv,
        keyType: "SERVER" as const,
      },
      {
        token: SERVER_PROD,
        environmentId: mine.prodEnv,
        keyType: "SERVER" as const,
      },
      {
        token: CLIENT_DEV,
        environmentId: mine.devEnv,
        keyType: "CLIENT" as const,
      },
      {
        token: REVOKED,
        environmentId: mine.devEnv,
        keyType: "SERVER" as const,
        revokedAt: new Date(),
      },
      {
        token: SERVER_OTHER,
        environmentId: theirs.devEnv,
        keyType: "SERVER" as const,
      },
    ].map((k) =>
      sdkKeyData({ ...k, createdById: actorId, label: "stats test" }),
    ),
  });

  const shared = await createActiveFlag(app, actorId, {
    projectId: mine.projectId,
    key: SHARED_KEY,
    flagType: "BOOLEAN",
    defaultVariantKey: "off",
  });
  sharedFlagId = shared.body.flag.id as string;

  /**
   * BẬT flag ở env dev: OFREP mới trả variant mặc định (`off`) thay vì DISABLED.
   * Đây là điều kiện để ca OFREP dưới kiểm được nhãn variant THẬT, chứ không chỉ
   * `__disabled__`. Bật ở đây, trước lần nạp snapshot đầu tiên, nên cache không
   * giữ bản cũ (watcher không chạy trong test).
   */
  const devConfig = await admin.flagEnvConfig.findFirstOrThrow({
    where: { flagId: sharedFlagId, environmentId: mine.devEnv },
    select: { id: true },
  });
  await internalCall(
    request(app).patch(`/internal/flag-envs/${devConfig.id}`),
    actorId,
  )
    .send({ isEnabled: true })
    .expect(200);

  const other = await createActiveFlag(app, actorId, {
    projectId: theirs.projectId,
    key: SHARED_KEY,
    flagType: "BOOLEAN",
    defaultVariantKey: "off",
  });
  otherFlagId = other.body.flag.id as string;

  // DRAFT: KHÔNG vào snapshot (§6.7) ⇒ mọi lượt báo cáo về nó bị bỏ qua
  await internalCall(request(app).post("/internal/flags"), actorId)
    .send({ projectId: mine.projectId, key: DRAFT_KEY, flagType: "BOOLEAN" })
    .expect(201);

  // Bia mộ: có mặt trong snapshot, chỉ nhận `__disabled__`
  const archived = await createActiveFlag(app, actorId, {
    projectId: mine.projectId,
    key: ARCHIVED_KEY,
    flagType: "BOOLEAN",
  });
  archivedFlagId = archived.body.flag.id as string;
  await internalCall(
    request(app).patch(`/internal/flags/${archivedFlagId}`),
    actorId,
  )
    .send({
      lastKnownUpdatedAt: archived.body.flag.updatedAt as string,
      lifecycleStatus: "ARCHIVED",
    })
    .expect(200);
}, 90_000);

afterAll(async () => {
  await disposeProject(admin, mine.projectId);
  await disposeProject(admin, theirs.projectId);
  await admin.$disconnect();
});

describe("POST /sdk/stats — đường đúng đắn", () => {
  it("SERVER key ⇒ 202, sau flush có hàng của ĐÚNG (flag, env) và bucket giờ", async () => {
    const sentAt = Date.now();
    const res = await postStats(SERVER_DEV, {
      counts: [
        { flagKey: SHARED_KEY, variant: "on", count: 3 },
        { flagKey: SHARED_KEY, variant: "off", count: 2 },
      ],
      sdk: { name: "udp-node", version: "0.1.0" },
    });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 2, ignored: 0 });

    await statsFlusher.runOnce();
    const rows = await bucketsOf(sharedFlagId, mine.devEnv);
    expect(rows).toHaveLength(2);
    for (const row of rows) expectBucketNear(row.bucketHour, sentAt);
    expect(new Map(rows.map((r) => [r.variantKey, r.evalCount]))).toEqual(
      new Map([
        ["on", 3n],
        ["off", 2n],
      ]),
    );
  });

  it("I14/R06: flag cùng key ở project khác và env khác của cùng project đứng yên", async () => {
    expect(await countsOf(otherFlagId, theirs.devEnv)).toEqual(new Map());
    expect(await countsOf(sharedFlagId, mine.prodEnv)).toEqual(new Map());
  });

  it("hai báo cáo rồi MỘT flush ⇒ một hàng; flush lần hai cộng dồn, không ghi đè", async () => {
    await postStats(SERVER_DEV, {
      counts: [{ flagKey: SHARED_KEY, variant: "on", count: 4 }],
    }).expect(202);
    await postStats(SERVER_DEV, {
      counts: [{ flagKey: SHARED_KEY, variant: "on", count: 5 }],
    }).expect(202);
    await statsFlusher.runOnce();

    expect((await countsOf(sharedFlagId, mine.devEnv)).get("on")).toBe(12n);

    await postStats(SERVER_DEV, {
      counts: [{ flagKey: SHARED_KEY, variant: "on", count: 1 }],
    }).expect(202);
    await statsFlusher.runOnce();
    expect((await countsOf(sharedFlagId, mine.devEnv)).get("on")).toBe(13n);
  });

  it("khoá của env prod ghi vào ĐÚNG env prod", async () => {
    await postStats(SERVER_PROD, {
      counts: [{ flagKey: SHARED_KEY, variant: "on", count: 6 }],
    }).expect(202);
    await statsFlusher.runOnce();

    expect((await countsOf(sharedFlagId, mine.prodEnv)).get("on")).toBe(6n);
    expect((await countsOf(sharedFlagId, mine.devEnv)).get("on")).toBe(13n);
  });

  it("`__disabled__` và `__error__` lưu nguyên văn", async () => {
    await postStats(SERVER_DEV, {
      counts: [
        { flagKey: SHARED_KEY, variant: "__disabled__", count: 1 },
        { flagKey: SHARED_KEY, variant: "__error__", count: 2 },
      ],
    }).expect(202);
    await statsFlusher.runOnce();

    const counts = await countsOf(sharedFlagId, mine.devEnv);
    expect(counts.get("__disabled__")).toBe(1n);
    expect(counts.get("__error__")).toBe(2n);
  });
});

describe("POST /sdk/stats — mục bị bỏ qua (V6)", () => {
  it("flag lạ, flag DRAFT và variant lạ ⇒ 202 nhưng `ignored`, không hàng nào", async () => {
    const res = await postStats(SERVER_DEV, {
      counts: [
        { flagKey: `khong-co-${suffix}`, variant: "on", count: 9 },
        { flagKey: DRAFT_KEY, variant: "on", count: 9 },
        { flagKey: SHARED_KEY, variant: "variant-la", count: 9 },
      ],
    });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 0, ignored: 3 });

    await statsFlusher.runOnce();
    const counts = await countsOf(sharedFlagId, mine.devEnv);
    expect(counts.has("variant-la")).toBe(false);
    expect(
      await admin.flagEvaluationStat.count({
        where: { flag: { key: DRAFT_KEY } },
      }),
    ).toBe(0);
  });

  it("bia mộ (ARCHIVED) chỉ nhận `__disabled__`, variant thật bị bỏ", async () => {
    const res = await postStats(SERVER_DEV, {
      counts: [
        { flagKey: ARCHIVED_KEY, variant: "__disabled__", count: 3 },
        { flagKey: ARCHIVED_KEY, variant: "on", count: 3 },
      ],
    });

    expect(res.body).toEqual({ accepted: 1, ignored: 1 });
    await statsFlusher.runOnce();
    expect(await countsOf(archivedFlagId, mine.devEnv)).toEqual(
      new Map([["__disabled__", 3n]]),
    );
  });
});

describe("POST /sdk/stats — xác thực và hợp đồng body", () => {
  it("thiếu khoá, khoá thu hồi, khoá CLIENT ⇒ 401 với CÙNG một thông điệp (R17)", async () => {
    const body = { counts: [{ flagKey: SHARED_KEY, variant: "on", count: 1 }] };
    const missing = await request(app)
      .post("/sdk/stats")
      .set("Content-Type", "application/json")
      .send(body);
    const revoked = await postStats(REVOKED, body);
    const client = await postStats(CLIENT_DEV, body);

    for (const res of [missing, revoked, client]) {
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe("SDK key không hợp lệ");
    }
  });

  it("giá trị sai ⇒ 400 và không nhận gì", async () => {
    const bad: unknown[] = [
      { counts: [] },
      { counts: [{ flagKey: SHARED_KEY, variant: "on", count: 0 }] },
      { counts: [{ flagKey: SHARED_KEY, variant: "on", count: -1 }] },
      { counts: [{ flagKey: SHARED_KEY, variant: "on", count: 1.5 }] },
      {
        counts: [
          {
            flagKey: SHARED_KEY,
            variant: "on",
            count: SDK_STATS.report.maxCountPerEntry + 1,
          },
        ],
      },
      { counts: [{ flagKey: SHARED_KEY, variant: "x".repeat(101), count: 1 }] },
      { counts: [{ flagKey: "Khong Hop Le", variant: "on", count: 1 }] },
      {
        counts: Array.from(
          { length: SDK_STATS.report.maxEntriesPerReport + 1 },
          () => ({ flagKey: SHARED_KEY, variant: "on", count: 1 }),
        ),
      },
    ];

    for (const body of bad) {
      const res = await postStats(SERVER_DEV, body);
      expect(res.status).toBe(400);
    }
  });

  it("AC-5.6: trường lạ ở CẢ BA cấp bị bỏ qua, vẫn 202", async () => {
    const res = await postStats(SERVER_DEV, {
      counts: [
        {
          flagKey: SHARED_KEY,
          variant: "on",
          count: 1,
          windowStart: "2026-09-22T00:00:00Z",
        },
      ],
      sdk: { name: "udp-node", version: "9", platform: "deno" },
      schemaVersion: 2,
    });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 1, ignored: 0 });
    await statsFlusher.runOnce();
  });

  it("body 1,5 MB qua `/SDK/stats/` ⇒ 202, không 413 (INV-23.8)", async () => {
    // Trường lạ `pad` bị `.strip()` bỏ, nên nó chỉ để làm body to hơn 1 MB
    const body = {
      counts: [{ flagKey: SHARED_KEY, variant: "on", count: 1 }],
      pad: "x".repeat(1_500_000),
    };
    const res = await postStats(SERVER_DEV, body, "/SDK/stats/");

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 1, ignored: 0 });
  });

  it("body vượt trần riêng 2 MiB ⇒ 413 problem+json", async () => {
    const res = await postStats(SERVER_DEV, {
      counts: [{ flagKey: SHARED_KEY, variant: "on", count: 1 }],
      pad: "x".repeat(SDK_STATS.report.maxBodyBytes + 1),
    });

    expect(res.status).toBe(413);
    expect(res.body.title).toBe("Payload too large");
  });

  it("R18: bucket rate limit RIÊNG — `/sdk/config` không ăn hạn mức của `/sdk/stats`", async () => {
    const first = await postStats(SERVER_DEV, {
      counts: [{ flagKey: SHARED_KEY, variant: "on", count: 1 }],
    }).expect(202);
    const before = Number(first.headers["ratelimit-remaining"]);
    expect(Number(first.headers["ratelimit-limit"])).toBe(
      RATE_LIMIT.sdk.statsPerKey.max,
    );

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .get("/sdk/config")
        .set("Authorization", `Bearer ${SERVER_DEV}`)
        .expect(200);
    }

    const after = await postStats(SERVER_DEV, {
      counts: [{ flagKey: SHARED_KEY, variant: "on", count: 1 }],
    }).expect(202);
    expect(Number(after.headers["ratelimit-remaining"])).toBe(before - 1);
    await statsFlusher.runOnce();
  });
});

describe("telemetry không chạm cấu hình (INV-23.4, G12)", () => {
  it("báo cáo và flush không đổi config_version, config_hash hay outbox", async () => {
    const before = await admin.environment.findUniqueOrThrow({
      where: { id: mine.devEnv },
      select: { configVersion: true, configHash: true },
    });
    const outboxBefore = await admin.configChangeLog.count({
      where: { environmentId: mine.devEnv },
    });

    await postStats(SERVER_DEV, {
      counts: [{ flagKey: SHARED_KEY, variant: "on", count: 2 }],
    }).expect(202);
    await statsFlusher.runOnce();

    expect(
      await admin.environment.findUniqueOrThrow({
        where: { id: mine.devEnv },
        select: { configVersion: true, configHash: true },
      }),
    ).toEqual(before);
    expect(
      await admin.configChangeLog.count({
        where: { environmentId: mine.devEnv },
      }),
    ).toBe(outboxBefore);
  });
});

describe("lượt đánh giá do Service 2 tự đếm", () => {
  it("OFREP MỘT flag bằng CLIENT key ⇒ có hàng; bulk ⇒ không (D7)", async () => {
    const before = (await countsOf(sharedFlagId, mine.devEnv)).get("off") ?? 0n;

    for (let i = 0; i < 10; i += 1) {
      await request(app)
        .post(`/ofrep/v1/evaluate/flags/${SHARED_KEY}`)
        .set("Authorization", `Bearer ${CLIENT_DEV}`)
        .send({ context: { targetingKey: `u-${String(i)}` } })
        .expect(200);
    }
    // Bulk: KHÔNG đếm — số của nó là "số lần cache miss", không phải số lượt
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post("/ofrep/v1/evaluate/flags")
        .set("Authorization", `Bearer ${CLIENT_DEV}`)
        .send({ context: { targetingKey: `bulk-${String(i)}` } })
        .expect(200);
    }
    await statsFlusher.runOnce();

    expect((await countsOf(sharedFlagId, mine.devEnv)).get("off")).toBe(
      before + 10n,
    );
  });

  it("R32: Flag Evaluation Tester 100 lần không đếm một lượt nào", async () => {
    const before = await countsOf(sharedFlagId, mine.devEnv);

    for (let i = 0; i < 100; i += 1) {
      await internalCall(
        request(app).post(`/internal/flags/${sharedFlagId}/evaluate`),
        actorId,
      )
        .send({
          environmentId: mine.devEnv,
          context: { targetingKey: `tester-${String(i)}` },
        })
        .expect(200);
    }
    await statsFlusher.runOnce();

    expect(await countsOf(sharedFlagId, mine.devEnv)).toEqual(before);
  }, 60_000);

  it("OFREP với flag lạ ⇒ 404 và không đếm (bộ gộp không phình theo key lạ)", async () => {
    await request(app)
      .post(`/ofrep/v1/evaluate/flags/khong-co-${suffix}`)
      .set("Authorization", `Bearer ${CLIENT_DEV}`)
      .send({ context: { targetingKey: "u1" } })
      .expect(404);

    await statsFlusher.runOnce();
    expect(
      await admin.flagEvaluationStat.count({
        where: { flag: { key: `khong-co-${suffix}` } },
      }),
    ).toBe(0);
  });
});

/**
 * Ca CUỐI của file có chủ đích: `statsIngest.close()` là một chiều (nó mô phỏng
 * tín hiệu dừng), nên mọi ca cần nhận báo cáo phải chạy trước nó.
 */
describe("đang tắt máy (R13)", () => {
  it("sau `statsIngest.close()` ⇒ 503 kèm Retry-After, không nhận thêm số đếm", async () => {
    statsIngest.close();

    const res = await postStats(SERVER_DEV, {
      counts: [{ flagKey: SHARED_KEY, variant: "on", count: 1 }],
    });

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
  });
});

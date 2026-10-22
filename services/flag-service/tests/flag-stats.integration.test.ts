import { randomUUID } from "node:crypto";
import { env, SDK_STATS, STALE_FLAG_THRESHOLDS } from "@udp/config";
import { createPrismaClient, type FlagLifecycleStatus } from "@udp/db";
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

/**
 * [v4.9] Ba route ĐỌC telemetry của Service 2 (§3.2) qua HTTP thật.
 *
 * Fixture dựng flag THẲNG bằng owner, không qua `POST /internal/flags`: các ca ở
 * đây đo đường ĐỌC, còn đường ghi (fan-out, outbox, hash) đã có
 * `flag-lifecycle.integration.test.ts` canh. Mỗi flag dựng bằng route thật tốn
 * ~2,5 giây vì phải fan-out mọi environment, mà file này cần hơn mười flag.
 *
 * `asOf` tiêm vào ở mọi ca có ràng buộc về mốc thời gian (seam T3, chỉ nhận khi
 * `NODE_ENV=test`): cửa sổ theo NGÀY ĐỊA PHƯƠNG chỉ kiểm được khi "bây giờ" là
 * một mốc cố định — ngày đổi giờ không lặp lại mỗi lần chạy test.
 */

const app = createApp();
const SECRET = env.INTERNAL_SERVICE_SECRET;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_flagstats_${randomUUID()}`,
});

interface Fixture {
  projectId: string;
  envIds: string[];
}

let stats: Fixture;
let stale: Fixture;
let empty: Fixture;
let actorId = "";

async function makeProject(prefix: string, envCount: number): Promise<Fixture> {
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
        create: Array.from({ length: envCount }, (_, i) => ({
          name: i === 0 ? "dev" : `env-${String(i)}`,
          rank: i,
          k8sNamespace: `udp-${prefix}-${suffix}-${String(i)}`,
        })),
      },
    },
    select: {
      id: true,
      environments: { select: { id: true }, orderBy: { rank: "asc" } },
    },
  });
  return {
    projectId: project.id,
    envIds: project.environments.map((row) => row.id),
  };
}

beforeAll(async () => {
  stats = await makeProject("fstats", 2);
  stale = await makeProject("fstale", 1);
  empty = await makeProject("fempty", 1);
}, 60_000);

afterAll(async () => {
  for (const fixture of [stats, stale, empty]) {
    /**
     * Kiểu nói ba biến này đã gán chắc chắn, nhưng nếu CHÍNH `beforeAll` ném thì
     * `afterAll` vẫn chạy với biến chưa gán — và bỏ phép kiểm này sẽ che lỗi thật
     * bằng một TypeError trong bước dọn dẹp.
     */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (fixture !== undefined) await disposeProject(admin, fixture.projectId);
  }
  await admin.$disconnect();
});

// ------------------------------------------------------------- helper

interface FlagSpec {
  lifecycleStatus?: FlagLifecycleStatus;
  permanent?: boolean;
  /** Lùi mốc tạo / mốc kích hoạt chừng này ms so với `asOf` của ca */
  createdAgo?: number;
  activatedAgo?: number;
  anchor?: Date;
  variantKeys?: string[];
}

/**
 * Flag dựng bằng owner. Mốc `activated_at` do trigger đặt lúc INSERT (ACTIVE),
 * rồi `backdateFlag` lùi nó — trigger không chạm hàng đang ACTIVE được sửa mốc,
 * và CHECK vẫn thoả vì mốc khác null.
 */
async function makeFlag(
  fixture: Fixture,
  spec: FlagSpec = {},
): Promise<{ id: string; key: string }> {
  const key = `st-${randomUUID().slice(0, 8)}`;
  const anchor = spec.anchor ?? new Date();
  const flag = await admin.featureFlag.create({
    data: {
      projectId: fixture.projectId,
      key,
      flagType: "BOOLEAN",
      lifecycleStatus: spec.lifecycleStatus ?? "ACTIVE",
      permanent: spec.permanent ?? false,
      variants: {
        create: (spec.variantKeys ?? ["on", "off"]).map((variantKey) => ({
          key: variantKey,
          value: variantKey === "on",
        })),
      },
    },
    select: { id: true },
  });
  if (spec.createdAgo !== undefined || spec.activatedAgo !== undefined) {
    await admin.featureFlag.update({
      where: { id: flag.id },
      data: {
        ...(spec.createdAgo === undefined
          ? {}
          : { createdAt: new Date(anchor.getTime() - spec.createdAgo) }),
        ...(spec.activatedAgo === undefined
          ? {}
          : { activatedAt: new Date(anchor.getTime() - spec.activatedAgo) }),
      },
    });
  }
  return { id: flag.id, key };
}

const seed = (
  flagId: string,
  environmentId: string,
  variantKey: string,
  evalCount: number,
  bucketHour: Date,
): Promise<void> =>
  seedEvalStats(admin, [
    { flagId, environmentId, variantKey, evalCount, bucketHour },
  ]);

const get = (path: string, query: Record<string, string>): request.Test =>
  request(app).get(path).query(query).set("X-Internal-Secret", SECRET);

const statsOf = (flagId: string, query: Record<string, string> = {}) =>
  get(`/internal/flags/${flagId}/stats`, query);

// ------------------------------------------------------------- stats theo flag

describe("GET /internal/flags/:id/stats", () => {
  it("guard: thiếu bí mật nội bộ ⇒ 401", async () => {
    const flag = await makeFlag(stats);
    await request(app).get(`/internal/flags/${flag.id}/stats`).expect(401);
  });

  it("tổng theo environment × variant trong cửa sổ; hàng ngoài cửa sổ bị loại", async () => {
    const asOf = new Date("2026-09-20T12:00:00.000Z");
    const flag = await makeFlag(stats, { anchor: asOf });
    const [dev, other] = stats.envIds as [string, string];
    await seed(
      flag.id,
      dev,
      "on",
      5,
      hourFloor(new Date(asOf.getTime() - DAY)),
    );
    await seed(
      flag.id,
      dev,
      "off",
      3,
      hourFloor(new Date(asOf.getTime() - 2 * DAY)),
    );
    await seed(
      flag.id,
      other,
      "on",
      11,
      hourFloor(new Date(asOf.getTime() - 3 * DAY)),
    );
    // Ngoài cửa sổ 7 ngày
    await seed(
      flag.id,
      dev,
      "on",
      1_000,
      hourFloor(new Date(asOf.getTime() - 9 * DAY)),
    );

    const res = await statsOf(flag.id, {
      days: "7",
      tz: "UTC",
      asOf: asOf.toISOString(),
    }).expect(200);

    expect(res.body.totals.evalCount).toBe(19);
    expect(res.body.window).toMatchObject({ granularity: "day", tz: "UTC" });
    const byEnv = res.body.byEnv as {
      environmentId: string;
      evalCount: number;
      variants: {
        variantKey: string;
        count: number;
        share: number;
        known: boolean;
      }[];
      series: { at: string; count: number }[];
    }[];
    expect(byEnv).toHaveLength(2);
    const devRow = byEnv.find((row) => row.environmentId === dev);
    expect(devRow?.evalCount).toBe(8);
    expect(devRow?.variants).toEqual([
      { variantKey: "off", count: 3, share: 3 / 8, known: true },
      { variantKey: "on", count: 5, share: 5 / 8, known: true },
    ]);
    expect(devRow?.series).toHaveLength(7);
    expect(devRow?.series.reduce((sum, point) => sum + point.count, 0)).toBe(8);
    // Bucket trống là 0, không phải điểm bị thiếu
    expect(devRow?.series.filter((point) => point.count === 0)).toHaveLength(5);
    expect(
      devRow?.series.every((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.at)),
    ).toBe(true);
  });

  it("variant đã bị xoá khỏi flag ⇒ known=false; nhãn stats vẫn known", async () => {
    const asOf = new Date("2026-09-20T12:00:00.000Z");
    const flag = await makeFlag(stats, {
      anchor: asOf,
      variantKeys: ["on", "off"],
    });
    const dev = stats.envIds[0] ?? "";
    const bucket = hourFloor(new Date(asOf.getTime() - HOUR));
    await seed(flag.id, dev, "beta-da-xoa", 2, bucket);
    await seed(flag.id, dev, "__disabled__", 4, bucket);

    const res = await statsOf(flag.id, {
      days: "1",
      tz: "UTC",
      asOf: asOf.toISOString(),
    }).expect(200);
    const variants = res.body.byEnv[0].variants as {
      variantKey: string;
      known: boolean;
    }[];
    expect(variants).toEqual([
      { variantKey: "__disabled__", count: 4, share: 4 / 6, known: true },
      { variantKey: "beta-da-xoa", count: 2, share: 2 / 6, known: false },
    ]);
  });

  it("granularity=hour: đúng days × 24 điểm, mốc ISO theo giờ UTC", async () => {
    const asOf = new Date("2026-09-20T12:34:56.000Z");
    const flag = await makeFlag(stats, { anchor: asOf });
    const dev = stats.envIds[0] ?? "";
    await seed(flag.id, dev, "on", 6, hourFloor(asOf));

    const res = await statsOf(flag.id, {
      days: "1",
      granularity: "hour",
      asOf: asOf.toISOString(),
    }).expect(200);
    const series = res.body.byEnv[0].series as { at: string; count: number }[];
    expect(series).toHaveLength(24);
    expect(series.at(-1)).toEqual({ at: "2026-09-20T12:00:00Z", count: 6 });
    expect(series[0]?.at).toBe("2026-09-19T13:00:00Z");
    expect(new Set(series.map((point) => point.at)).size).toBe(24);
  });

  it("BIGINT: tổng vượt 2^53 trả về `number` đã bão hoà, không phải bigint (R11, V17)", async () => {
    const asOf = new Date("2026-09-20T12:00:00.000Z");
    const flag = await makeFlag(stats, { anchor: asOf });
    const dev = stats.envIds[0] ?? "";
    const bucket = hourFloor(new Date(asOf.getTime() - HOUR));
    await seed(flag.id, dev, "on", 9e18, bucket);
    await seed(flag.id, dev, "off", 9e18, bucket);

    const res = await statsOf(flag.id, {
      days: "1",
      asOf: asOf.toISOString(),
    }).expect(200);
    expect(typeof res.body.totals.evalCount).toBe("number");
    expect(res.body.totals.evalCount).toBe(Number.MAX_SAFE_INTEGER);
    expect(res.body.byEnv[0].variants[0].count).toBe(Number.MAX_SAFE_INTEGER);
    expect(JSON.stringify(res.body)).not.toMatch(/9000000000000000000/);
  });

  it("archive: còn lượt trong 7 ngày ⇒ blockedBy RECENT_EVALUATIONS + archivableAfter; cũ hơn ⇒ allowed", async () => {
    const asOf = new Date("2026-09-20T12:00:00.000Z");
    const guard = STALE_FLAG_THRESHOLDS.archiveGuardDays;
    const blocked = await makeFlag(stats, { anchor: asOf });
    const dev = stats.envIds[0] ?? "";
    const last = hourFloor(new Date(asOf.getTime() - 2 * DAY));
    await seed(blocked.id, dev, "on", 4, last);

    const hit = await statsOf(blocked.id, {
      days: "7",
      asOf: asOf.toISOString(),
    }).expect(200);
    expect(hit.body.archive).toEqual({
      allowed: false,
      blockedBy: "RECENT_EVALUATIONS",
      evalCount7d: 4,
      lastEvaluatedAt: last.toISOString(),
      archivableAfter: new Date(
        last.getTime() + guard * DAY + HOUR,
      ).toISOString(),
    });

    const free = await makeFlag(stats, { anchor: asOf });
    await seed(
      free.id,
      dev,
      "on",
      4,
      hourFloor(new Date(asOf.getTime() - (guard + 2) * DAY)),
    );
    const ok = await statsOf(free.id, {
      days: "30",
      asOf: asOf.toISOString(),
    }).expect(200);
    expect(ok.body.archive).toMatchObject({ allowed: true, evalCount7d: 0 });
    expect(ok.body.archive.blockedBy).toBeUndefined();
    expect(ok.body.archive.archivableAfter).toBeUndefined();
  });

  it("telemetryGaps và clientTrafficUnobserved theo khoá đã dùng (V9)", async () => {
    const asOf = new Date();
    const gapFixture = await makeProject("fgap", 1);
    try {
      const flag = await makeFlag(gapFixture, { anchor: asOf });
      const envId = gapFixture.envIds[0] ?? "";
      const quiet = await statsOf(flag.id, { days: "7" }).expect(200);
      expect(quiet.body.telemetryGaps).toEqual([]);
      expect(quiet.body.clientTrafficUnobserved).toBe(false);

      const server = await issueSdkKey(admin, {
        environmentId: envId,
        keyType: "SERVER",
        createdById: actorId,
      });
      await issueSdkKey(admin, {
        environmentId: envId,
        keyType: "CLIENT",
        createdById: actorId,
      });
      await admin.sdkKey.updateMany({
        where: { environmentId: envId },
        data: { lastUsedAt: new Date(asOf.getTime() - HOUR) },
      });
      expect(server).toMatch(/^udp_sk_/);

      const gapped = await statsOf(flag.id, { days: "7" }).expect(200);
      expect(gapped.body.telemetryGaps).toEqual([envId]);
      expect(gapped.body.clientTrafficUnobserved).toBe(true);

      // Có hàng stats trong cửa sổ ⇒ không còn là "lỗ hổng telemetry"
      await seed(
        flag.id,
        envId,
        "on",
        1,
        hourFloor(new Date(asOf.getTime() - HOUR)),
      );
      const covered = await statsOf(flag.id, { days: "7" }).expect(200);
      expect(covered.body.telemetryGaps).toEqual([]);
    } finally {
      await disposeProject(admin, gapFixture.projectId);
    }
  });

  it("tham số sai ⇒ 400; flag lạ ⇒ 404; environment của project khác ⇒ 404", async () => {
    const flag = await makeFlag(stats);
    for (const query of [
      { days: "0" },
      { days: "91" },
      { days: "khong-phai-so" },
      { days: "8", granularity: "hour" },
      { granularity: "phut" },
      { tz: "Mars/Base" },
      { tz: "UTC+7" },
      { unknownParam: "1" },
    ]) {
      await statsOf(flag.id, query).expect(400);
    }
    await statsOf(randomUUID(), { days: "7" }).expect(404);
    await statsOf("khong-phai-uuid", { days: "7" }).expect(400);
    await statsOf(flag.id, {
      days: "7",
      environmentId: stale.envIds[0] ?? "",
    }).expect(404);
  });
});

// ------------------------------------------------------------- series theo tz

describe("series theo NGÀY ĐỊA PHƯƠNG qua mốc đổi giờ (F12)", () => {
  /** Mỗi ca: đúng một điểm cho mỗi ngày địa phương, và tổng được bảo toàn */
  const check = async (options: {
    tz: string;
    asOf: string;
    days: number;
    buckets: { at: string; count: number }[];
    firstDay: string;
    lastDay: string;
  }): Promise<void> => {
    const flag = await makeFlag(stats, { anchor: new Date(options.asOf) });
    const envId = stats.envIds[0] ?? "";
    for (const bucket of options.buckets) {
      await seed(flag.id, envId, "on", bucket.count, new Date(bucket.at));
    }
    const res = await statsOf(flag.id, {
      days: String(options.days),
      tz: options.tz,
      asOf: options.asOf,
    }).expect(200);

    const series = res.body.byEnv[0].series as { at: string; count: number }[];
    expect(series).toHaveLength(options.days);
    expect(new Set(series.map((point) => point.at)).size).toBe(options.days);
    expect(series[0]?.at).toBe(options.firstDay);
    expect(series.at(-1)?.at).toBe(options.lastDay);
    const seeded = options.buckets.reduce((sum, b) => sum + b.count, 0);
    expect(series.reduce((sum, point) => sum + point.count, 0)).toBe(seeded);
    expect(res.body.totals.evalCount).toBe(seeded);
  };

  it("America/New_York quanh 01/11/2026 (hết giờ mùa hè)", async () => {
    await check({
      tz: "America/New_York",
      asOf: "2026-11-04T17:00:00.000Z",
      days: 7,
      firstDay: "2026-10-29",
      lastDay: "2026-11-04",
      buckets: [
        { at: "2026-10-29T18:00:00.000Z", count: 1 },
        // 01/11 lúc 05:00Z là 01:00 EST — sau khi đồng hồ lùi
        { at: "2026-11-01T05:00:00.000Z", count: 2 },
        { at: "2026-11-01T03:00:00.000Z", count: 4 },
        { at: "2026-11-04T16:00:00.000Z", count: 8 },
      ],
    });
  });

  it("Asia/Kolkata (lệch nửa giờ)", async () => {
    await check({
      tz: "Asia/Kolkata",
      asOf: "2026-09-20T12:00:00.000Z",
      days: 5,
      firstDay: "2026-09-16",
      lastDay: "2026-09-20",
      buckets: [
        { at: "2026-09-16T19:00:00.000Z", count: 3 },
        { at: "2026-09-18T00:00:00.000Z", count: 5 },
        { at: "2026-09-20T05:00:00.000Z", count: 7 },
      ],
    });
  });

  it("America/Santiago 04/09–09/09/2026 (vào giờ mùa hè ngày 06/09)", async () => {
    await check({
      tz: "America/Santiago",
      asOf: "2026-09-09T15:00:00.000Z",
      days: 6,
      firstDay: "2026-09-04",
      lastDay: "2026-09-09",
      buckets: [
        { at: "2026-09-04T05:00:00.000Z", count: 1 },
        { at: "2026-09-05T05:00:00.000Z", count: 2 },
        { at: "2026-09-06T05:00:00.000Z", count: 4 },
        { at: "2026-09-06T23:00:00.000Z", count: 8 },
        { at: "2026-09-08T05:00:00.000Z", count: 16 },
        { at: "2026-09-09T05:00:00.000Z", count: 32 },
      ],
    });
  });
});

// ------------------------------------------------------------- Cleanup Center

describe("GET /internal/stale-flags", () => {
  const list = (query: Record<string, string>) =>
    get("/internal/stale-flags", query);

  it("ba nhóm đúng, không lẫn flag của project khác (AC-1.6)", async () => {
    const asOf = new Date();
    const { projectId } = stale;
    const envId = stale.envIds[0] ?? "";
    // Telemetry của project bắt đầu 60 ngày trước
    const anchorFlag = await makeFlag(stale, {
      anchor: asOf,
      activatedAgo: 70 * DAY,
      permanent: true,
    });
    await seed(
      anchorFlag.id,
      envId,
      "on",
      1,
      hourFloor(new Date(asOf.getTime() - 60 * DAY)),
    );

    const unused = await makeFlag(stale, {
      anchor: asOf,
      activatedAgo: 40 * DAY,
    });
    const exempt = await makeFlag(stale, {
      anchor: asOf,
      activatedAgo: 40 * DAY,
      permanent: true,
    });
    const young = await makeFlag(stale, {
      anchor: asOf,
      activatedAgo: 10 * DAY,
    });
    const oldDraft = await makeFlag(stale, {
      anchor: asOf,
      lifecycleStatus: "DRAFT",
      createdAgo: 31 * DAY,
    });
    const youngDraft = await makeFlag(stale, {
      anchor: asOf,
      lifecycleStatus: "DRAFT",
      createdAgo: 29 * DAY,
    });

    const res = await list({ projectId }).expect(200);
    const keys = (
      res.body.items as { flag: { id: string }; category: string }[]
    ).map((item) => `${item.flag.id}:${item.category}`);
    expect(new Set(keys)).toEqual(
      new Set([`${unused.id}:UNUSED`, `${oldDraft.id}:STALE_DRAFT`]),
    );
    expect(res.body.counts).toEqual({ UNUSED: 1, SETTLED: 0, STALE_DRAFT: 1 });
    expect(res.body.total).toBe(2);
    expect(res.body.telemetry.firstReportAt).not.toBeNull();
    expect(res.body.telemetry.observedDays).toBeGreaterThanOrEqual(59);
    for (const id of [exempt.id, young.id, youngDraft.id, anchorFlag.id]) {
      expect(keys.some((entry) => entry.startsWith(id))).toBe(false);
    }
  });

  it("lọc theo category, phân trang, và 400 khi thiếu projectId", async () => {
    const { projectId } = stale;
    const only = await list({ projectId, category: "STALE_DRAFT" }).expect(200);
    expect(only.body.items).toHaveLength(1);
    // `counts` là của TOÀN BỘ project, `total` là của bộ lọc
    expect(only.body.counts).toEqual({ UNUSED: 1, SETTLED: 0, STALE_DRAFT: 1 });
    expect(only.body.total).toBe(1);

    const paged = await list({ projectId, limit: "1", offset: "1" }).expect(
      200,
    );
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.total).toBe(2);

    await list({}).expect(400);
    await list({ projectId: "khong-phai-uuid" }).expect(400);
    await list({ projectId, category: "KHONG-CO" }).expect(400);
    await list({ projectId, limit: "0" }).expect(400);
    await list({ projectId, limit: "101" }).expect(400);
  });

  it("SETTLED: 100% lượt 14 ngày vào một variant ở mọi env (AC-1.7)", async () => {
    const asOf = new Date();
    const fixture = await makeProject("fsettled", 2);
    try {
      const [dev, prod] = fixture.envIds as [string, string];
      const flag = await makeFlag(fixture, {
        anchor: asOf,
        activatedAgo: 20 * DAY,
      });
      const bucket = hourFloor(new Date(asOf.getTime() - 2 * DAY));
      const older = hourFloor(new Date(asOf.getTime() - 40 * DAY));
      // Telemetry của project phải phủ ≥ 14 ngày
      await seed(flag.id, dev, "on", 1, older);
      await seed(flag.id, dev, "on", 80, bucket);
      await seed(flag.id, prod, "on", 40, bucket);

      const res = await list({ projectId: fixture.projectId }).expect(200);
      expect(res.body.counts).toEqual({
        UNUSED: 0,
        SETTLED: 1,
        STALE_DRAFT: 0,
      });
      const item = res.body.items[0] as {
        category: string;
        settled: { variantKey: string; count: number };
        evalCount30d: number;
        distribution: { variantKey: string; count: number }[];
        byEnv: { environmentId: string; evalCount14d: number }[];
        archive: { allowed: boolean; blockedBy?: string };
      };
      expect(item.category).toBe("SETTLED");
      expect(item.settled).toEqual({ variantKey: "on", count: 120 });
      expect(item.evalCount30d).toBe(120);
      expect(item.distribution).toEqual([{ variantKey: "on", count: 120 }]);
      expect(item.byEnv).toHaveLength(2);
      expect(item.byEnv.reduce((sum, row) => sum + row.evalCount14d, 0)).toBe(
        120,
      );
      // SETTLED gần như luôn bị chốt 7 ngày chặn — đó là ý của BR-1.8
      expect(item.archive).toMatchObject({
        allowed: false,
        blockedBy: "RECENT_EVALUATIONS",
      });

      // Một hàng __error__ phá SETTLED
      await seed(flag.id, dev, "__error__", 1, bucket);
      const after = await list({ projectId: fixture.projectId }).expect(200);
      expect(after.body.counts.SETTLED).toBe(0);
    } finally {
      await disposeProject(admin, fixture.projectId);
    }
  });

  it("project chưa có telemetry: firstReportAt null, 0 UNUSED/SETTLED, STALE_DRAFT vẫn tính (AC-1.8)", async () => {
    const asOf = new Date();
    await makeFlag(empty, { anchor: asOf, activatedAgo: 90 * DAY });
    const draft = await makeFlag(empty, {
      anchor: asOf,
      lifecycleStatus: "DRAFT",
      createdAgo: 45 * DAY,
    });

    const res = await list({ projectId: empty.projectId }).expect(200);
    expect(res.body.telemetry).toEqual({
      firstReportAt: null,
      observedDays: 0,
    });
    expect(res.body.counts).toEqual({ UNUSED: 0, SETTLED: 0, STALE_DRAFT: 1 });
    expect(res.body.items[0].flag.id).toBe(draft.id);
    expect(res.body.items[0].archive).toMatchObject({
      allowed: true,
      evalCount7d: 0,
    });
  });
});

// ------------------------------------------------------------- summary

describe("GET /internal/flag-stats/summary", () => {
  const summary = (query: Record<string, string>) =>
    get("/internal/flag-stats/summary", query);

  it("daily14 đúng 14 điểm, evalCount7d dùng cửa sổ của chốt archive", async () => {
    const asOf = new Date("2026-09-20T12:00:00.000Z");
    const envId = stats.envIds[0] ?? "";
    const busy = await makeFlag(stats, { anchor: asOf });
    const quiet = await makeFlag(stats, { anchor: asOf });
    await seed(
      busy.id,
      envId,
      "on",
      5,
      hourFloor(new Date(asOf.getTime() - DAY)),
    );
    await seed(
      busy.id,
      envId,
      "on",
      6,
      hourFloor(new Date(asOf.getTime() - 10 * DAY)),
    );
    // Ngoài cả cửa sổ sparkline
    await seed(
      busy.id,
      envId,
      "on",
      99,
      hourFloor(new Date(asOf.getTime() - 20 * DAY)),
    );

    const res = await summary({
      environmentId: envId,
      flagIds: `${busy.id},${quiet.id}`,
      asOf: asOf.toISOString(),
    }).expect(200);

    const items = res.body.items as {
      flagId: string;
      evalCount7d: number;
      daily14: number[];
    }[];
    expect(items.map((item) => item.flagId)).toEqual([busy.id, quiet.id]);
    const first = items[0];
    expect(first?.daily14).toHaveLength(SDK_STATS.query.sparklineDays);
    expect(first?.daily14.reduce((sum, n) => sum + n, 0)).toBe(11);
    expect(first?.daily14.at(-2)).toBe(5);
    expect(first?.evalCount7d).toBe(5);
    // Flag không có hàng nào vẫn có một chỗ trong phản hồi, toàn 0
    expect(items[1]?.daily14).toEqual(Array.from({ length: 14 }, () => 0));
    expect(items[1]?.evalCount7d).toBe(0);
  });

  it("tham số sai ⇒ 400", async () => {
    const envId = stats.envIds[0] ?? "";
    await summary({ environmentId: envId }).expect(400);
    await summary({ environmentId: envId, flagIds: "khong-phai-uuid" }).expect(
      400,
    );
    await summary({
      environmentId: envId,
      flagIds: Array.from({ length: SDK_STATS.query.summaryMaxFlags + 1 }, () =>
        randomUUID(),
      ).join(","),
    }).expect(400);
    await summary({ environmentId: "x", flagIds: randomUUID() }).expect(400);
    await summary({
      environmentId: envId,
      flagIds: randomUUID(),
      tz: "Mars/Base",
    }).expect(400);
  });
});

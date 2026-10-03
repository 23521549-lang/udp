import { randomUUID } from "node:crypto";
import { env, SDK_STATS } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { disposeProject, seedEvalStats, stableOwner } from "@udp/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/core/db.js";
import { createStatsRepository } from "../src/modules/stats/stats.repository.js";
import { createStatsRollupJob } from "../src/modules/stats/stats.rollup.job.js";

/**
 * [v4.9] Retention của `flag_evaluation_stats`: hàng giờ quá hạn gộp thành hàng
 * ngày 00:00 UTC, bằng `prisma` của Service 2 (role `udp_s2` — bảng này nó có
 * DELETE, nên không cần hàm SECURITY DEFINER; I22 không đổi).
 *
 * Dữ liệu dựng ở năm 2001 chứ không phải "92 ngày trước": câu gộp luôn chọn ngày
 * CŨ NHẤT còn hàng giờ, nên mốc thật cũ làm test không phụ thuộc thứ tự chạy với
 * file khác, và không thể gộp lẫn dữ liệu của file khác.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_rollup_${randomUUID()}`,
});

const repository = createStatsRepository(prisma);
const suffix = randomUUID().slice(0, 8);

/** Ba ngày liên tiếp, mỗi ngày hai hàng giờ; ngày đầu đã có sẵn hàng 00:00 */
const DAYS = [
  "2001-01-01T00:00:00.000Z",
  "2001-01-02T00:00:00.000Z",
  "2001-01-03T00:00:00.000Z",
] as const;

let projectId = "";
let environmentId = "";
let flagId = "";

const rows = () =>
  admin.flagEvaluationStat.findMany({
    where: { flagId },
    select: { variantKey: true, evalCount: true, bucketHour: true },
    orderBy: [{ bucketHour: "asc" }, { variantKey: "asc" }],
  });

beforeAll(async () => {
  const owner = await stableOwner(admin);
  const project = await admin.project.create({
    data: {
      ownerId: owner.id,
      name: `rollup-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-rollup-${suffix}` },
        ],
      },
      flags: { create: [{ key: `rollup-${suffix}`, flagType: "BOOLEAN" }] },
    },
    select: {
      id: true,
      environments: { select: { id: true } },
      flags: { select: { id: true } },
    },
  });
  projectId = project.id;
  environmentId = project.environments[0]?.id ?? "";
  flagId = project.flags[0]?.id ?? "";

  await seedEvalStats(admin, [
    // Ngày 1: hàng ngày ĐÃ CÓ (00:00) + hai hàng giờ ⇒ gộp phải CỘNG vào hàng có sẵn
    {
      flagId,
      environmentId,
      variantKey: "on",
      evalCount: 10,
      bucketHour: new Date(DAYS[0]),
    },
    {
      flagId,
      environmentId,
      variantKey: "on",
      evalCount: 3,
      bucketHour: new Date("2001-01-01T05:00:00.000Z"),
    },
    {
      flagId,
      environmentId,
      variantKey: "on",
      evalCount: 4,
      bucketHour: new Date("2001-01-01T17:00:00.000Z"),
    },
    // Ngày 2: hai variant khác nhau trong cùng một giờ và hai giờ khác nhau
    {
      flagId,
      environmentId,
      variantKey: "on",
      evalCount: 5,
      bucketHour: new Date("2001-01-02T01:00:00.000Z"),
    },
    {
      flagId,
      environmentId,
      variantKey: "off",
      evalCount: 6,
      bucketHour: new Date("2001-01-02T23:00:00.000Z"),
    },
    // Ngày 3
    {
      flagId,
      environmentId,
      variantKey: "on",
      evalCount: 7,
      bucketHour: new Date("2001-01-03T08:00:00.000Z"),
    },
    {
      flagId,
      environmentId,
      variantKey: "on",
      evalCount: 8,
      bucketHour: new Date("2001-01-03T09:00:00.000Z"),
    },
  ]);
}, 60_000);

afterAll(async () => {
  await disposeProject(admin, projectId);
  await admin.$disconnect();
});

describe("stats rollup", () => {
  it("MỘT lượt gộp đủ ba ngày; hàng giờ biến mất, tổng được bảo toàn (C-14)", async () => {
    const job = createStatsRollupJob({ repository });

    // 6 hàng giờ (hàng 00:00 của ngày 1 không bị xoá)
    expect(await job.runOnce()).toBe(6);

    expect(await rows()).toEqual([
      { variantKey: "on", evalCount: 17n, bucketHour: new Date(DAYS[0]) },
      { variantKey: "off", evalCount: 6n, bucketHour: new Date(DAYS[1]) },
      { variantKey: "on", evalCount: 5n, bucketHour: new Date(DAYS[1]) },
      { variantKey: "on", evalCount: 15n, bucketHour: new Date(DAYS[2]) },
    ]);
  });

  it("chạy lại là no-op: idempotent, không gộp hàng ngày vào chính nó", async () => {
    const job = createStatsRollupJob({ repository });

    expect(
      await repository.rollupOldestDay(SDK_STATS.retention.hourlyDays),
    ).toBe(0);
    expect(await job.runOnce()).toBe(0);
    expect(await rows()).toHaveLength(4);
  });

  it("hàng giờ CHƯA quá hạn không bị chạm", async () => {
    const fresh = new Date(Date.UTC(2026, 8, 22, 5));
    await seedEvalStats(admin, [
      {
        flagId,
        environmentId,
        variantKey: "on",
        evalCount: 2,
        bucketHour: fresh,
      },
    ]);

    expect(
      await repository.rollupOldestDay(SDK_STATS.retention.hourlyDays),
    ).toBe(0);
    expect(
      (await rows()).find((r) => r.bucketHour.getTime() === fresh.getTime())
        ?.evalCount,
    ).toBe(2n);
  });

  it("trần số bước mỗi lượt: maxDaysPerRun = 1 chỉ gộp ngày cũ nhất", async () => {
    await seedEvalStats(admin, [
      {
        flagId,
        environmentId,
        variantKey: "on",
        evalCount: 1,
        bucketHour: new Date("2001-02-01T03:00:00.000Z"),
      },
      {
        flagId,
        environmentId,
        variantKey: "on",
        evalCount: 1,
        bucketHour: new Date("2001-02-02T03:00:00.000Z"),
      },
    ]);

    const job = createStatsRollupJob({ repository, maxDaysPerRun: 1 });
    expect(await job.runOnce()).toBe(1);

    const remaining = await rows();
    expect(
      remaining.some(
        (r) =>
          r.bucketHour.getTime() === Date.parse("2001-02-01T00:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      remaining.some(
        (r) =>
          r.bucketHour.getTime() === Date.parse("2001-02-02T03:00:00.000Z"),
      ),
    ).toBe(true);
  });
});

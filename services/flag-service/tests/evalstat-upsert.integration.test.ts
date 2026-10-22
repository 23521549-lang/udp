import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { disposeProject, stableOwner } from "@udp/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/core/db.js";
import {
  createStatsRepository,
  upsertStatsSql,
} from "../src/modules/stats/stats.repository.js";
import type { StatsRow } from "../src/modules/stats/stats.aggregator.js";

/**
 * [v4.9] Câu UPSERT của `flag_evaluation_stats` trên database THẬT, chạy bằng
 * `prisma` của Service 2 (role `udp_s2`) — tức đúng đường mà flusher đi
 * (Tester 2.3, B-04).
 *
 * File này nằm ở `services/flag-service/tests` chứ không ở
 * `packages/db/tests/invariants`: câu SQL thuộc `stats.repository.ts`, và một
 * test ở package khác chỉ kiểm được một BẢN CHÉP của nó — bản chép trôi khỏi bản
 * thật mà không ai thấy. Ở đây nó import chính hàm dựng câu.
 *
 * Bốn tính chất, mỗi cái là một cách mất số đếm đã biết:
 *   - cộng dồn chứ không ghi đè (R09);
 *   - hai entry cùng khoá xung đột trong MỘT câu không làm lỗi `21000` (R7 V1);
 *   - `eval_count` lớn hơn 2^31 không tràn (R11);
 *   - flag cùng key ở project khác KHÔNG bị cộng lẫn (R06, I14).
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_evalstat_${randomUUID()}`,
});

const repository = createStatsRepository(prisma);
const BUCKET = new Date("2026-09-20T04:00:00.000Z");
const suffix = randomUUID().slice(0, 8);
const FLAG_KEY = `evalstat-${suffix}`;

interface Fixture {
  projectId: string;
  envIds: [string, string];
  flagId: string;
}

let mine: Fixture;
let theirs: Fixture;

const makeFixture = async (tag: string): Promise<Fixture> => {
  const owner = await stableOwner(admin);
  const project = await admin.project.create({
    data: {
      ownerId: owner.id,
      name: `evalstat-${tag}-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-es-${tag}-${suffix}` },
          { name: "prod", rank: 1, k8sNamespace: `udp-es-${tag}-${suffix}-p` },
        ],
      },
      // Cùng MỘT key flag ở hai project: đúng tình huống R06
      flags: { create: [{ key: FLAG_KEY, flagType: "BOOLEAN" }] },
    },
    select: {
      id: true,
      environments: { select: { id: true }, orderBy: { rank: "asc" } },
      flags: { select: { id: true } },
    },
  });

  const [dev, prod] = project.environments;
  const flagId = project.flags[0]?.id;
  if (dev === undefined || prod === undefined || flagId === undefined) {
    throw new Error("fixture thiếu environment hoặc flag");
  }
  return { projectId: project.id, envIds: [dev.id, prod.id], flagId };
};

const rowsOf = (fixture: Fixture) =>
  admin.flagEvaluationStat.findMany({
    where: { flagId: fixture.flagId },
    select: {
      environmentId: true,
      variantKey: true,
      evalCount: true,
      bucketHour: true,
    },
    orderBy: [{ environmentId: "asc" }, { variantKey: "asc" }],
  });

/**
 * `(environmentId, variant) ⇒ eval_count`, mốc bucket kiểm riêng.
 *
 * Khẳng định theo Map chứ không theo mảng có thứ tự: thứ tự của `orderBy
 * environmentId` là thứ tự UUID, mà UUID của `dev` và `prod` sinh ngẫu nhiên —
 * một test đỏ vì chuyện đó là test chập chờn, không phải test bắt lỗi.
 */
const countsOf = async (fixture: Fixture): Promise<Map<string, bigint>> => {
  const rows = await rowsOf(fixture);
  expect(rows.every((r) => r.bucketHour.getTime() === BUCKET.getTime())).toBe(
    true,
  );
  return new Map(
    rows.map((r) => [`${r.environmentId}|${r.variantKey}`, r.evalCount]),
  );
};

const row = (
  environmentId: string,
  variant: string,
  count: number,
): StatsRow => ({
  environmentId,
  flagKey: FLAG_KEY,
  variant,
  count,
  bucketHour: BUCKET.getTime(),
});

beforeAll(async () => {
  mine = await makeFixture("mine");
  theirs = await makeFixture("theirs");
}, 60_000);

afterAll(async () => {
  await disposeProject(admin, mine.projectId);
  await disposeProject(admin, theirs.projectId);
  await admin.$disconnect();
});

describe("upsertStatsSql trên database thật", () => {
  it("ghi lô đầu, cộng dồn lô sau (ON CONFLICT cộng, không ghi đè)", async () => {
    await repository.upsertBatch([
      row(mine.envIds[0], "on", 3),
      row(mine.envIds[0], "off", 1),
      row(mine.envIds[1], "on", 2),
    ]);
    await repository.upsertBatch([row(mine.envIds[0], "on", 4)]);

    expect([...(await countsOf(mine))].sort()).toEqual(
      [
        [`${mine.envIds[0]}|off`, 1n],
        [`${mine.envIds[0]}|on`, 7n],
        [`${mine.envIds[1]}|on`, 2n],
      ].sort(),
    );
  });

  it("hai entry CÙNG khoá xung đột trong một lô: GROUP BY giữ đúng tổng, không lỗi 21000", async () => {
    await repository.upsertBatch([
      row(mine.envIds[0], "dup", 5),
      row(mine.envIds[0], "dup", 6),
    ]);

    const dup = (await rowsOf(mine)).find((r) => r.variantKey === "dup");
    expect(dup?.evalCount).toBe(11n);
  });

  it("eval_count lớn hơn 2^31 đi và về nguyên vẹn (R11)", async () => {
    await repository.upsertBatch([row(mine.envIds[0], "big", 3_000_000_000)]);
    await repository.upsertBatch([row(mine.envIds[0], "big", 1)]);

    const big = (await rowsOf(mine)).find((r) => r.variantKey === "big");
    expect(big?.evalCount).toBe(3_000_000_001n);
  });

  it("flag cùng key ở project khác KHÔNG bị cộng lẫn (R06, I14)", async () => {
    expect(await rowsOf(theirs)).toEqual([]);
  });

  it("environment lạ trong lô: hàng đó rơi, các hàng khác vẫn được ghi", async () => {
    await repository.upsertBatch([
      { ...row(randomUUID(), "on", 100), flagKey: FLAG_KEY },
      row(mine.envIds[0], "orphan-batch", 2),
    ]);

    const rows = await rowsOf(mine);
    expect(rows.find((r) => r.variantKey === "orphan-batch")?.evalCount).toBe(
      2n,
    );
    expect(rows.every((r) => r.evalCount !== 100n)).toBe(true);
  });

  it("flagKey không tồn tại: lô đi qua mà không ghi hàng nào", async () => {
    const before = await rowsOf(mine);
    await repository.upsertBatch([
      { ...row(mine.envIds[0], "on", 50), flagKey: `khong-co-${suffix}` },
    ]);

    expect(await rowsOf(mine)).toEqual(before);
  });

  it("lô rỗng không chạm database; lô quá flushBatchRows bị từ chối ở JS", async () => {
    await expect(repository.upsertBatch([])).resolves.toBeUndefined();
    const tooMany = Array.from({ length: 1_001 }, (_, i) =>
      row(mine.envIds[0], `v-${String(i)}`, 1),
    );
    await expect(repository.upsertBatch(tooMany)).rejects.toThrow(
      /flushBatchRows/,
    );
  });

  it("xoá flag ⇒ CASCADE hàng stats", async () => {
    const solo = await makeFixture("cascade");
    await repository.upsertBatch([row(solo.envIds[0], "on", 1)]);
    expect(await rowsOf(solo)).toHaveLength(1);

    await admin.featureFlag.delete({ where: { id: solo.flagId } });
    expect(await rowsOf(solo)).toEqual([]);
    await disposeProject(admin, solo.projectId);
  });

  it("câu SQL export ra mang đúng 5 tham số mảng text[]", () => {
    const sql = upsertStatsSql([row(mine.envIds[0], "on", 1)]);
    expect(sql.values).toEqual([
      [mine.envIds[0]],
      [FLAG_KEY],
      ["on"],
      ["1"],
      [BUCKET.toISOString()],
    ]);
  });
});

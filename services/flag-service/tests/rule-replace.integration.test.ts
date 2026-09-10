import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { configHashOf, pickVariant, type Snapshot } from "@udp/flag-evaluator";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { stableOwner } from "./helpers/fixture.js";
import { prismaEntryLoader } from "../src/changefeed/snapshot.cache.js";

/**
 * `PUT /internal/flag-envs/:id/rules` qua HTTP thật (Plan #12, Mục 2).
 *
 * Endpoint này là nơi I1 dễ vỡ nhất trong cả hệ thống: một lần "thay danh sách"
 * viết theo kiểu xoá hết chèn lại sinh salt mới cho mọi rule, và đã đo được là
 * 69,4% người đang thấy `on` mất quyền thấy chỉ vì một lần sửa trọng số. Nên các
 * test ở đây không hỏi "lưu được không" mà hỏi "danh tính của rule có sống sót
 * qua lần lưu không".
 */

const app = createApp();
const SECRET = env.INTERNAL_SERVICE_SECRET;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_ruletest_${randomUUID()}`,
});
const readEntry = prismaEntryLoader(admin);

let ownerId: string;
let projectId: string;
let otherProjectId: string;
let envIds: string[];
let devEnv: string;
let prodEnv: string;
let flagKey: string;
let on: string;
let off: string;
let foreignVariant: string;
let devConfig: string;
let prodConfig: string;
let ownSegment: string;
let foreignSegment: string;

const makeProject = async (
  tag: string,
): Promise<{ id: string; envs: string[] }> => {
  const suffix = randomUUID().slice(0, 8);
  const p = await admin.project.create({
    data: {
      ownerId,
      name: `ruletest-${tag}-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-rule-${tag}-${suffix}-d` },
          {
            name: "prod",
            rank: 1,
            k8sNamespace: `udp-rule-${tag}-${suffix}-p`,
          },
        ],
      },
    },
    select: {
      id: true,
      environments: { select: { id: true }, orderBy: { rank: "asc" } },
    },
  });
  return { id: p.id, envs: p.environments.map((e) => e.id) };
};

const createFlag = (key: string): request.Test =>
  request(app)
    .post("/internal/flags")
    .set("X-Internal-Secret", SECRET)
    .send({ projectId, key, flagType: "BOOLEAN" });

beforeAll(async () => {
  ownerId = (await stableOwner(admin)).id;

  const mine = await makeProject("own");
  const theirs = await makeProject("other");
  projectId = mine.id;
  otherProjectId = theirs.id;
  envIds = [...mine.envs, ...theirs.envs];
  devEnv = mine.envs[0]!;
  prodEnv = mine.envs[1]!;

  flagKey = `rules-${randomUUID().slice(0, 8)}`;
  const flag = await createFlag(flagKey).expect(201);
  const variants = flag.body.flag.variants as { id: string; key: string }[];
  on = variants.find((v) => v.key === "on")!.id;
  off = variants.find((v) => v.key === "off")!.id;

  const other = await createFlag(`foreign-${randomUUID().slice(0, 8)}`).expect(
    201,
  );
  foreignVariant = (other.body.flag.variants as { id: string }[])[0]!.id;

  const configs = await admin.flagEnvConfig.findMany({
    where: { flagId: flag.body.flag.id as string },
    select: { id: true, environmentId: true },
  });
  devConfig = configs.find((c) => c.environmentId === devEnv)!.id;
  prodConfig = configs.find((c) => c.environmentId === prodEnv)!.id;

  ownSegment = (
    await admin.segment.create({
      data: { projectId, name: "beta", conditions: [] },
      select: { id: true },
    })
  ).id;
  foreignSegment = (
    await admin.segment.create({
      data: { projectId: otherProjectId, name: "beta", conditions: [] },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (projectId !== undefined) {
    await admin.configChangeLog.deleteMany({
      where: { environmentId: { in: envIds } },
    });
    await admin.project.deleteMany({
      where: { id: { in: [projectId, otherProjectId] } },
    });
  }
  await admin.$disconnect();
});

/** Mốc optimistic lock hiện tại của một env-config */
const stamp = async (id: string): Promise<string> =>
  (
    await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id },
      select: { updatedAt: true },
    })
  ).updatedAt.toISOString();

const put = (id: string, body: object): request.Test =>
  request(app)
    .put(`/internal/flag-envs/${id}/rules`)
    .set("X-Internal-Secret", SECRET)
    .send(body);

/** Gửi danh sách rule với mốc optimistic lock ĐÚNG */
const save = async (
  id: string,
  rules: object[],
  status = 200,
): Promise<request.Response> =>
  put(id, { lastKnownUpdatedAt: await stamp(id), rules }).expect(status);

const canary = (onPercent: number) => ({
  kind: "distribution",
  weights: [
    { variantId: on, weight: onPercent * 1000 },
    { variantId: off, weight: 100_000 - onPercent * 1000 },
  ],
});

const allRule = (onPercent: number, extra: object = {}) => ({
  ruleType: "ALL",
  condition: {},
  serve: canary(onPercent),
  priority: 1,
  ...extra,
});

const versions = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    (
      await admin.environment.findMany({
        where: { id: { in: envIds } },
        select: { id: true, configVersion: true },
      })
    ).map((e) => [e.id, e.configVersion]),
  );

const wireRule = (snapshot: Snapshot, ruleId: string) => {
  const entry = snapshot.flags.find((f) => f.key === flagKey);
  if (entry === undefined || "archived" in entry) throw new Error("mất flag");
  const rule = entry.rules.find((r) => r.id === ruleId);
  if (rule === undefined) throw new Error(`mất rule ${ruleId}`);
  return rule;
};

/** Ai thấy `on` theo đúng thứ SDK nhận — hình dạng dây, salt trên dây */
const audience = async (
  ruleId: string,
  users: number,
): Promise<Set<string>> => {
  const rule = wireRule((await readEntry(devEnv)).snapshot, ruleId);
  const out = new Set<string>();
  for (let i = 0; i < users; i += 1) {
    const stickyValue = `user-${String(i)}`;
    const pick = pickVariant(rule.serve, {
      stickyValue,
      flagKey,
      bucketSalt: rule.bucketSalt,
    });
    if (pick.kind !== "no-sticky" && pick.variantKey === "on") {
      out.add(stickyValue);
    }
  }
  return out;
};

describe("tạo và thay rule — chạm đúng MỘT environment", () => {
  it("rule mới: server sinh id và bucket_salt; chỉ dev tăng version; outbox rule.replaced", async () => {
    const before = await versions();
    const res = await save(devConfig, [allRule(20)]);

    const [rule] = res.body.rules as { id: string; bucketSalt: string }[];
    expect(rule?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rule?.bucketSalt).toMatch(/^[0-9a-f-]{36}$/);

    const after = await versions();
    expect(after[devEnv]).toBe((before[devEnv] ?? -1) + 1);
    expect(after[prodEnv]).toBe(before[prodEnv]);

    const log = await admin.configChangeLog.findUniqueOrThrow({
      where: {
        environmentId_configVersion: {
          environmentId: devEnv,
          configVersion: after[devEnv]!,
        },
      },
      select: { changeType: true },
    });
    expect(log.changeType).toBe("rule.replaced");
  });

  it("delta áp lên snapshot cũ cho ra đúng config_hash mới (I15c)", async () => {
    const before = (await readEntry(devEnv)).snapshot;
    const current = (
      await admin.flagTargetingRule.findFirstOrThrow({
        where: { flagEnvConfigId: devConfig },
        select: { id: true },
      })
    ).id;

    await save(devConfig, [allRule(25, { id: current })]);
    const after = await readEntry(devEnv);

    const log = await admin.configChangeLog.findUniqueOrThrow({
      where: {
        environmentId_configVersion: {
          environmentId: devEnv,
          configVersion: after.configVersion,
        },
      },
      select: { payload: true },
    });
    const delta = log.payload as unknown as { flag: Snapshot["flags"][number] };
    const applied: Snapshot = {
      ...before,
      flags: [...before.flags.filter((f) => f.key !== flagKey), delta.flag],
    };

    expect(configHashOf(applied)).toBe(after.configHash);
  });
});

describe("I1 qua HTTP — danh tính rule sống sót qua lần lưu", () => {
  it("nâng 20% → 30% GIỮ bucket_salt, và MỌI người đang thấy on vẫn thấy", async () => {
    const created = await save(devConfig, [allRule(20)]);
    const rule = (
      created.body.rules as { id: string; bucketSalt: string }[]
    )[0]!;
    const at20 = await audience(rule.id, 2000);

    const ramped = await save(devConfig, [allRule(30, { id: rule.id })]);
    const after = (
      ramped.body.rules as { id: string; bucketSalt: string }[]
    )[0]!;

    expect(after.id).toBe(rule.id);
    expect(after.bucketSalt).toBe(rule.bucketSalt);

    const at30 = await audience(rule.id, 2000);
    const lost = [...at20].filter((u) => !at30.has(u));
    expect(lost).toEqual([]);
    expect(at30.size).toBeGreaterThan(at20.size);
  });

  it("weights gửi NGƯỢC thứ tự vẫn được lưu theo thứ tự chuẩn (§6.4)", async () => {
    /**
     * Đúng hình dạng body ramp mẫu của Service 3 ở §7.3 — `[target, other]`, không
     * theo `variantId`. Không sắp ở tầng ghi thì thứ tự lưu xuống phụ thuộc UUID
     * nào lớn hơn, và lần sửa kế tiếp có thể đảo nhóm của 100% người dùng.
     */
    const reversed = {
      ...allRule(20),
      serve: {
        kind: "distribution",
        weights: [
          { variantId: off, weight: 80_000 },
          { variantId: on, weight: 20_000 },
        ],
      },
    };
    const res = await save(devConfig, [reversed]);

    const stored = (
      res.body.rules as {
        serve: { weights: { variantId: string }[] };
      }[]
    )[0]!.serve.weights.map((w) => w.variantId);
    expect(stored).toEqual([...stored].sort());
  });

  it("bỏ một rule khỏi danh sách thì nó bị xoá; rule còn lại giữ nguyên salt", async () => {
    const two = await save(devConfig, [
      allRule(20),
      { ...allRule(50), priority: 2 },
    ]);
    const [keep, drop] = two.body.rules as { id: string; bucketSalt: string }[];

    const one = await save(devConfig, [allRule(20, { id: keep!.id })]);
    const rules = one.body.rules as { id: string; bucketSalt: string }[];

    expect(rules.map((r) => r.id)).toEqual([keep!.id]);
    expect(rules[0]!.bucketSalt).toBe(keep!.bucketSalt);
    expect(
      await admin.flagTargetingRule.findUnique({ where: { id: drop!.id } }),
    ).toBeNull();
  });
});

describe("optimistic lock thật sự có tác dụng", () => {
  it("PUT thành công ĐẨY mốc updated_at — nếu không thì khoá không bảo vệ gì", async () => {
    /**
     * Lần ghi chạm `flag_targeting_rules` chứ không chạm `flag_env_configs`, và
     * đã đo: `@updatedAt` của hàng cha đứng yên, kể cả với `update({ data: {} })`.
     * Mốc đứng yên nghĩa là hai PUT đồng thời cùng qua phép so.
     */
    const before = await stamp(devConfig);
    await save(devConfig, [allRule(20)]);
    expect(await stamp(devConfig)).not.toBe(before);
  });

  it("mốc cũ ⇒ 409 OPTIMISTIC_LOCK, và danh sách rule KHÔNG đổi", async () => {
    const stale = await stamp(devConfig);
    await save(devConfig, [allRule(20)]);
    const kept = await admin.flagTargetingRule.findMany({
      where: { flagEnvConfigId: devConfig },
      select: { id: true },
    });

    const res = await put(devConfig, {
      lastKnownUpdatedAt: stale,
      rules: [allRule(90)],
    }).expect(409);

    expect(res.body.code).toBe("OPTIMISTIC_LOCK");
    // §8.4: kèm bản mới nhất — đúng danh sách đang có, để Portal hiển thị diff
    expect(
      (res.body.current.rules as { id: string }[]).map((r) => r.id).sort(),
    ).toEqual(kept.map((r) => r.id).sort());
    expect(
      await admin.flagTargetingRule.findMany({
        where: { flagEnvConfigId: devConfig },
        select: { id: true },
      }),
    ).toEqual(kept);
  });
});

describe("những gì phải bị từ chối", () => {
  it("id rule của env-config KHÁC ⇒ 422, và không environment nào đổi version", async () => {
    /**
     * Coi một id lạ là "rule mới" thì một rule của `prod` được "chuyển" sang
     * `dev` — đường vòng qua I14. Nó phải bị từ chối, không được lặng lẽ nhận.
     */
    const prodRule = (
      (await save(prodConfig, [allRule(10)])).body.rules as {
        id: string;
      }[]
    )[0]!.id;

    const before = await versions();
    await save(devConfig, [allRule(10, { id: prodRule })], 422);
    expect(await versions()).toEqual(before);
  });

  it("bucketSalt trong body ⇒ 400 — salt chỉ sinh ở server", async () => {
    await save(devConfig, [allRule(20, { bucketSalt: "tu-chon-salt" })], 400);
  });

  it("condition sai theo ruleType ⇒ 400, và chỉ ra đúng rules.N.condition", async () => {
    const res = await save(
      devConfig,
      [allRule(20), { ...allRule(20), ruleType: "USER_BASED", priority: 2 }],
      400,
    );

    const fields = (res.body.errors as { field: string }[]).map((e) => e.field);
    expect(fields).toContain("rules.1.condition");
  });

  it("segment của project KHÁC ⇒ 422; segment cùng project ⇒ 200", async () => {
    const segmentRule = (segmentId: string) => ({
      ...allRule(20),
      ruleType: "SEGMENT",
      condition: { segmentId },
    });

    await save(devConfig, [segmentRule(foreignSegment)], 422);
    await save(devConfig, [segmentRule(ownSegment)]);
  });

  it("serve trỏ variant của flag KHÁC ⇒ 422 ORPHAN_RULE (trigger UDP01), version không đổi", async () => {
    const before = await versions();
    const res = await save(
      devConfig,
      [
        {
          ...allRule(20),
          serve: {
            kind: "distribution",
            weights: [
              { variantId: on, weight: 20_000 },
              { variantId: foreignVariant, weight: 80_000 },
            ],
          },
        },
      ],
      422,
    );

    expect(res.body.code).toBe("ORPHAN_RULE");
    expect(await versions()).toEqual(before);
  });

  it("quá MAX_RULES_PER_ENV_CONFIG rule ⇒ 400, trước khi chạm database", async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({
      ...allRule(20),
      priority: i,
    }));
    await save(devConfig, many, 400);
  });

  it("điều kiện ngưỡng THẬP PHÂN ⇒ 200 — số tuần tự theo RFC 8785", async () => {
    /** Trước v4.1: `canonicalJson` ném trong transaction ghi và thành 500 */
    await save(devConfig, [
      {
        ...allRule(20),
        ruleType: "ATTRIBUTE_BASED",
        condition: {
          all: [{ attribute: "score", operator: "gte", value: 0.75 }],
        },
      },
    ]);
  });
});

describe("rule đang có rollout hoạt động thuộc về Service 3 (§1.2)", () => {
  it("PAUSED vẫn giữ rule: xoá ⇒ 409, đổi serve ⇒ 409, chỉ đổi mô tả ⇒ 200", async () => {
    /**
     * `PAUSED` là ca quan trọng: v3 từng để truy vấn claim bỏ sót nó, và
     * intent RESUME/ROLLBACK trên session tạm dừng không bao giờ chạy. Một rollout
     * tạm dừng vẫn sở hữu rule của nó.
     *
     * Và xoá phải bị chặn ở tầng ứng dụng, vì khoá ngoại là CASCADE: để nó lọt thì
     * `RolloutSession` đang chạy biến mất cùng rule, âm thầm.
     */
    const rule = (
      (await save(devConfig, [allRule(20)])).body.rules as {
        id: string;
      }[]
    )[0]!;

    const session = await admin.rolloutSession.create({
      data: {
        projectId,
        environmentId: devEnv,
        flagEnvConfigId: devConfig,
        targetingRuleId: rule.id,
        rolloutScope: "FLAG_LEVEL",
        strategy: "CANARY",
        controlMode: "UDP_DRIVEN",
        status: "PAUSED",
        thresholds: {},
        stepPercent: 10,
        createdById: ownerId,
      },
      select: { id: true },
    });

    try {
      const removed = await save(devConfig, [], 409);
      expect(removed.body.code).toBe("ROLLOUT_IN_PROGRESS");
      expect(
        await admin.rolloutSession.findUnique({ where: { id: session.id } }),
      ).not.toBeNull();

      await save(devConfig, [allRule(60, { id: rule.id })], 409);

      await save(devConfig, [
        allRule(20, { id: rule.id, description: "chỉ đổi mô tả" }),
      ]);

      // Rollout kết thúc ⇒ rule trả về cho người dùng
      await admin.rolloutSession.update({
        where: { id: session.id },
        data: { status: "DONE" },
      });
      await save(devConfig, []);
    } finally {
      await admin.rolloutSession.deleteMany({ where: { id: session.id } });
    }
  });
});

import { randomUUID } from "node:crypto";
import { ACTIVE_ROLLOUT_STATUSES, env } from "@udp/config";
import { createPrismaClient, RolloutStatus } from "@udp/db";
import { configHashOf, pickVariant, type Snapshot } from "@udp/flag-evaluator";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { prismaEntryLoader } from "../src/changefeed/snapshot.cache.js";
import { stableOwner } from "./helpers/fixture.js";

/**
 * `PATCH /internal/rules/:ruleId` qua HTTP thật (Plan #12, Mục 3 và 5).
 *
 * Đóng góp C1 đứng trên endpoint này: rollout FLAG_LEVEL đổi `serve.weights` qua
 * nó, và rollback cũng qua nó. Nên các test canh hai chiều ngược nhau — worker
 * HẾT quyền phải bị chặn (I23, T12), còn worker ĐÚNG quyền không được bị chặn
 * nhầm: kể cả ở bước ramp đầu tiên lúc session còn PENDING, và khi rollback một
 * rollout đang PAUSED.
 */

const app = createApp();
const SECRET = env.INTERNAL_SERVICE_SECRET;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_ramptest_${randomUUID()}`,
});
const readEntry = prismaEntryLoader(admin);

let projectId: string;
let envIds: string[];
let devEnv: string;
let prodEnv: string;
let flagKey: string;
let on: string;
let off: string;
let devConfig: string;
let ruleId: string;
let variantRuleId: string;
let otherRuleId: string;
let sessionId: string;

/** Body ramp đúng hình dạng §7.3: `[target, other]` — KHÔNG theo thứ tự variantId */
const weights = (onPercent: number) => [
  { variantId: on, weight: onPercent * 1000 },
  { variantId: off, weight: 100_000 - onPercent * 1000 },
];

const stamp = async (id: string): Promise<string> =>
  (
    await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id },
      select: { updatedAt: true },
    })
  ).updatedAt.toISOString();

beforeAll(async () => {
  const ownerId = (await stableOwner(admin)).id;
  const suffix = randomUUID().slice(0, 8);

  const project = await admin.project.create({
    data: {
      ownerId,
      name: `ramptest-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-ramp-${suffix}-dev` },
          { name: "prod", rank: 1, k8sNamespace: `udp-ramp-${suffix}-prd` },
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

  flagKey = `ramp-${suffix}`;
  const flag = await request(app)
    .post("/internal/flags")
    .set("X-Internal-Secret", SECRET)
    .send({ projectId, key: flagKey, flagType: "BOOLEAN" })
    .expect(201);
  const variants = flag.body.flag.variants as { id: string; key: string }[];
  on = variants.find((v) => v.key === "on")!.id;
  off = variants.find((v) => v.key === "off")!.id;

  devConfig = (
    await admin.flagEnvConfig.findFirstOrThrow({
      where: { flagId: flag.body.flag.id as string, environmentId: devEnv },
      select: { id: true },
    })
  ).id;

  // Ba rule: một phục vụ thẳng một variant, một phân phối để ramp, một phân phối khác
  const score = (min: number) => ({
    all: [{ attribute: "score", operator: "gte", value: min }],
  });
  const saved = await request(app)
    .put(`/internal/flag-envs/${devConfig}/rules`)
    .set("X-Internal-Secret", SECRET)
    .send({
      lastKnownUpdatedAt: await stamp(devConfig),
      rules: [
        {
          ruleType: "ATTRIBUTE_BASED",
          condition: score(90),
          serve: { kind: "variant", variantId: on },
          priority: 0,
        },
        {
          ruleType: "ALL",
          condition: {},
          serve: { kind: "distribution", weights: weights(10) },
          priority: 1,
        },
        {
          ruleType: "ATTRIBUTE_BASED",
          condition: score(50),
          serve: { kind: "distribution", weights: weights(50) },
          priority: 2,
        },
      ],
    })
    .expect(200);
  const idAt = new Map(
    (saved.body.rules as { id: string; priority: number }[]).map((r) => [
      r.priority,
      r.id,
    ]),
  );
  variantRuleId = idAt.get(0)!;
  ruleId = idAt.get(1)!;
  otherRuleId = idAt.get(2)!;

  sessionId = (
    await admin.rolloutSession.create({
      data: {
        projectId,
        environmentId: devEnv,
        flagEnvConfigId: devConfig,
        targetingRuleId: ruleId,
        rolloutScope: "FLAG_LEVEL",
        strategy: "CANARY",
        controlMode: "UDP_DRIVEN",
        status: "IN_PROGRESS",
        thresholds: {},
        stepPercent: 10,
        createdById: ownerId,
      },
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
    // RolloutSession đi theo project — khoá ngoại CASCADE
    await admin.project.deleteMany({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

const token = (version: number): string => `"${sessionId}:${String(version)}"`;

const patchRule = (
  id: string,
  body: object,
  ifMatch?: string,
): request.Test => {
  const req = request(app)
    .patch(`/internal/rules/${id}`)
    .set("X-Internal-Secret", SECRET)
    .send(body);
  return ifMatch === undefined ? req : req.set("If-Match", ifMatch);
};

const ramp = (id: string, onPercent: number, ifMatch?: string): request.Test =>
  patchRule(
    id,
    { weights: weights(onPercent), reason: `rollout:${sessionId} step` },
    ifMatch,
  );

const setSession = (data: {
  version?: number;
  status?: RolloutStatus;
  claimedUntil?: Date | null;
  targetingRuleId?: string;
}): Promise<unknown> =>
  admin.rolloutSession.update({ where: { id: sessionId }, data });

/**
 * Đặt session về "một worker đang giữ lease hợp lệ" với `version` cho trước.
 * Mỗi test gọi nó TRƯỚC rồi mới đổi đúng một chiều mình muốn kiểm — nên không
 * test nào phụ thuộc thứ tự chạy.
 */
const holdLease = (version: number): Promise<unknown> =>
  setSession({
    version,
    status: "IN_PROGRESS",
    targetingRuleId: ruleId,
    claimedUntil: new Date(Date.now() + 60_000),
  });

const storedWeights = async (
  id: string,
): Promise<{ variantId: string; weight: number }[]> => {
  const { serve } = await admin.flagTargetingRule.findUniqueOrThrow({
    where: { id },
    select: { serve: true },
  });
  return (
    serve as unknown as { weights: { variantId: string; weight: number }[] }
  ).weights;
};

const onWeight = async (id: string): Promise<number | undefined> =>
  (await storedWeights(id)).find((w) => w.variantId === on)?.weight;

const versions = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    (
      await admin.environment.findMany({
        where: { id: { in: envIds } },
        select: { id: true, configVersion: true },
      })
    ).map((e) => [e.id, e.configVersion]),
  );

/** Một cái chốt mở bằng tay — để dựng thứ tự giữa hai transaction */
function latch(): { opened: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = () => {
      resolve();
    };
  });
  return { opened, open };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("I23 — bên nhận side effect từ chối fencing token cũ", () => {
  it("A (version 5) ramp; B giành lease (6) và ramp; A tỉnh dậy ⇒ 412, weights là của B", async () => {
    /**
     * Đúng kịch bản của I23: A claim với version 5 rồi tạm dừng; lease hết, B
     * claim (version 6) và promote; A tỉnh dậy gọi PATCH với version 5. Lần ghi
     * của A bị từ chối CẢ transaction — kể cả bước tăng `config_version`, nên
     * không replica nào bị đánh thức vì một lần ghi không xảy ra.
     */
    await holdLease(5);
    await ramp(ruleId, 20, token(5)).expect(200);

    await holdLease(6);
    await ramp(ruleId, 30, token(6)).expect(200);

    const before = await versions();
    const late = await ramp(ruleId, 90, token(5)).expect(412);

    expect(late.body.code).toBe("PRECONDITION_FAILED");
    expect(await onWeight(ruleId)).toBe(30_000);
    expect(await versions()).toEqual(before);
  });

  it("version LỚN hơn cái đang lưu ⇒ 412 — không tin con số bên gọi tự khai", async () => {
    await holdLease(6);
    await ramp(ruleId, 40, token(7)).expect(412);
  });

  it("thử lại với CÙNG version được nhận", async () => {
    /**
     * §7.3 đòi version BẰNG, không phải "lớn hơn lần trước". Executor thử lại
     * với backoff (§7.6) mang đúng `If-Match` cũ, và lần trước có thể đã commit
     * mà phản hồi mất trên đường về. Từ chối lần thử lại là báo "bên khác đã
     * thay mặt" khi không có bên nào cả — và §7.1 xử lý 412 bằng `return`.
     */
    await holdLease(6);
    await ramp(ruleId, 30, token(6)).expect(200);
    await ramp(ruleId, 30, token(6)).expect(200);
    expect(await onWeight(ruleId)).toBe(30_000);
  });
});

describe("T12 — token đúng là chưa đủ, phải đang giữ lease của đúng rule", () => {
  it("lease đã hết hạn ⇒ 412, dù version đúng", async () => {
    await holdLease(6);
    await setSession({ claimedUntil: new Date(Date.now() - 60_000) });
    await ramp(ruleId, 40, token(6)).expect(412);
  });

  it("chưa ai giữ lease (claimed_until NULL) ⇒ 412", async () => {
    await holdLease(6);
    await setSession({ claimedUntil: null });
    await ramp(ruleId, 40, token(6)).expect(412);
  });

  it("session giữ rule KHÁC ⇒ 412", async () => {
    await holdLease(6);
    await setSession({ targetingRuleId: otherRuleId });
    await ramp(ruleId, 40, token(6)).expect(412);
  });

  it("session không tồn tại ⇒ 412", async () => {
    await holdLease(6);
    await ramp(ruleId, 40, `"${randomUUID()}:6"`).expect(412);
  });

  it("lease hết hạn TRONG LÚC chờ khoá environment ⇒ 412", async () => {
    /**
     * Đã đo: trong một transaction, `now()` là giờ BEGIN — sau `pg_sleep(1.2)`
     * nó chậm hơn giờ thật 1,3 giây. PATCH mở transaction rồi mới chờ khoá
     * environment ở bước 1 của ADR-05, nên so lease với `now()` là so với lúc
     * TRƯỚC khi chờ: một lease hết hạn giữa chừng vẫn được coi là còn.
     *
     * Dựng đúng hình dạng đó: một transaction khác giữ khoá environment; lease
     * chỉ còn 1,5 giây theo đồng hồ database; PATCH đi vào và phải chờ; khoá
     * được nhả khi lease đã hết.
     */
    await holdLease(6);
    const before = await onWeight(ruleId);
    const locked = latch();
    const released = latch();

    const holder = admin.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          SELECT 1 FROM environments WHERE id = ${devEnv}::uuid FOR UPDATE`;
        locked.open();
        await released.opened;
      },
      { timeout: 20_000 },
    );
    // `holder` ném trước khi khoá được thì test đỏ ngay, không treo tới timeout
    await Promise.race([locked.opened, holder]);

    // Lease theo đồng hồ DATABASE — cùng đồng hồ với phép kiểm
    await admin.$executeRaw`
      UPDATE rollout_sessions
         SET claimed_until = now() + interval '1500 milliseconds'
       WHERE id = ${sessionId}::uuid`;

    const pending = ramp(ruleId, 90, token(6)).then((res) => res);
    await sleep(3_000);
    released.open();
    await holder;

    expect((await pending).status).toBe(412);
    expect(await onWeight(ruleId)).toBe(before);
  });
});

describe("status: đúng vị từ của truy vấn giành lease", () => {
  it.each([...ACTIVE_ROLLOUT_STATUSES])("%s ⇒ ramp được", async (status) => {
    /**
     * PENDING: bước ramp ĐẦU TIÊN chạy lúc session còn PENDING (`start()` trong
     * sơ đồ rollout FLAG_LEVEL). PAUSED: rollback một rollout đang tạm dừng — v3
     * bỏ sót PAUSED ở truy vấn claim nên intent RESUME/ROLLBACK không bao giờ
     * chạy; chặn nó ở đây là cài lại đúng lỗi đó ở phía bên kia lời gọi mạng.
     */
    await holdLease(6);
    await setSession({ status });
    await ramp(ruleId, 10, token(6)).expect(200);
  });

  /** Suy từ enum chứ không liệt kê tay: một status mới tự rơi vào nhóm này */
  const ended = Object.values(RolloutStatus).filter(
    (s) => !ACTIVE_ROLLOUT_STATUSES.some((active) => active === s),
  );

  it.each(ended)(
    "%s ⇒ 412 — rollout đã kết thúc không được ramp nữa",
    async (status) => {
      await holdLease(6);
      await setSession({ status });
      await ramp(ruleId, 10, token(6)).expect(412);
    },
  );
});

describe("hình dạng request", () => {
  it("thiếu If-Match ⇒ 400 — theo HTTP, thiếu nó là ghi VÔ ĐIỀU KIỆN", async () => {
    await holdLease(6);
    await ramp(ruleId, 10).expect(400);
  });

  it("If-Match sai dạng ⇒ 400", async () => {
    await holdLease(6);
    // Cái cuối là đúng thứ Node đưa lên khi request mang HAI header If-Match
    for (const bad of ["6", `W/${token(6)}`, "*", `${token(6)}, ${token(6)}`]) {
      await ramp(ruleId, 10, bad).expect(400);
    }
  });

  it("tổng weight khác 100000 ⇒ 400", async () => {
    await holdLease(6);
    await patchRule(
      ruleId,
      {
        weights: [
          { variantId: on, weight: 10_000 },
          { variantId: off, weight: 10_000 },
        ],
        reason: "sai tổng",
      },
      token(6),
    ).expect(400);
  });

  it("trường ngoài weights/reason ⇒ 400 — endpoint không rộng hơn GRANT của S3", async () => {
    await holdLease(6);
    await patchRule(
      ruleId,
      { weights: weights(10), reason: "lấn quyền", priority: 99 },
      token(6),
    ).expect(400);
  });

  it("ruleId không phải UUID ⇒ 400; rule không tồn tại ⇒ 404", async () => {
    await holdLease(6);
    await ramp("khong-phai-uuid", 10, token(6)).expect(400);
    await ramp(randomUUID(), 10, token(6)).expect(404);
  });

  it("thiếu bí mật nội bộ ⇒ 401", async () => {
    await request(app)
      .patch(`/internal/rules/${ruleId}`)
      .set("If-Match", token(6))
      .send({ weights: weights(10), reason: "không bí mật" })
      .expect(401);
  });
});

describe("ramp chỉ đổi TRỌNG SỐ", () => {
  it("rule phục vụ thẳng một variant ⇒ 422", async () => {
    await holdLease(6);
    await setSession({ targetingRuleId: variantRuleId });
    await ramp(variantRuleId, 10, token(6)).expect(422);
  });

  it("bỏ bớt một variant ⇒ 422, dù tổng vẫn đủ 100000", async () => {
    /**
     * Không có phép kiểm tập variant thì lần ghi này HỢP LỆ với mọi chốt khác —
     * variant cùng flag nên trigger UDP01 không chặn, tổng đủ nên schema không
     * chặn — và rollout vừa đổi CÁI GÌ được phục vụ, trong khi nó chỉ có quyền
     * quyết định BAO NHIÊU.
     */
    await holdLease(6);
    const before = await storedWeights(ruleId);
    await patchRule(
      ruleId,
      { weights: [{ variantId: on, weight: 100_000 }], reason: "bỏ off" },
      token(6),
    ).expect(422);
    expect(await storedWeights(ruleId)).toEqual(before);
  });

  it("variant lạ ⇒ 422 từ phép kiểm tập variant, trước khi tới trigger", async () => {
    await holdLease(6);
    const res = await patchRule(
      ruleId,
      {
        weights: [
          { variantId: on, weight: 50_000 },
          { variantId: randomUUID(), weight: 50_000 },
        ],
        reason: "variant lạ",
      },
      token(6),
    ).expect(422);
    // ORPHAN_RULE là mã của trigger — thấy nó nghĩa là service đã để lọt
    expect(res.body.code).not.toBe("ORPHAN_RULE");
  });
});

describe("dấu vết của một lần ramp", () => {
  it("outbox rule.ramped: actor NULL, mang rolloutSessionId, delta dựng lại đúng config_hash", async () => {
    await holdLease(6);
    const before = (await readEntry(devEnv)).snapshot;
    await ramp(ruleId, 35, token(6)).expect(200);
    const after = await readEntry(devEnv);

    const log = await admin.configChangeLog.findUniqueOrThrow({
      where: {
        environmentId_configVersion: {
          environmentId: devEnv,
          configVersion: after.configVersion,
        },
      },
      select: { changeType: true, actorUserId: true, payload: true },
    });

    expect(log.changeType).toBe("rule.ramped");
    // §2.2: NULL = Service 3 khi rollout — không có người dùng nào bấm gì
    expect(log.actorUserId).toBeNull();

    const payload = log.payload as unknown as {
      flag: Snapshot["flags"][number];
      rolloutSessionId: string;
    };
    expect(payload.rolloutSessionId).toBe(sessionId);

    // I15c: replica chỉ có snapshot cũ cộng dòng outbox, và phải ra đúng con số
    const applied: Snapshot = {
      ...before,
      flags: [...before.flags.filter((f) => f.key !== flagKey), payload.flag],
    };
    expect(configHashOf(applied)).toBe(after.configHash);
  });

  it("chỉ environment của rule tăng config_version", async () => {
    await holdLease(6);
    const before = await versions();
    await ramp(ruleId, 25, token(6)).expect(200);
    const after = await versions();

    expect(after[devEnv]).toBe((before[devEnv] ?? -1) + 1);
    expect(after[prodEnv]).toBe(before[prodEnv]);
  });

  it("weights gửi NGƯỢC thứ tự vẫn được lưu theo thứ tự chuẩn (§6.4)", async () => {
    /** Gửi giảm dần theo variantId để phép so luôn phân biệt, bất kể UUID nào lớn hơn */
    await holdLease(6);
    const descending = [...weights(40)].sort((a, b) =>
      a.variantId < b.variantId ? 1 : -1,
    );
    await patchRule(
      ruleId,
      { weights: descending, reason: "thứ tự ngược" },
      token(6),
    ).expect(200);

    const ids = (await storedWeights(ruleId)).map((w) => w.variantId);
    expect(ids).toEqual([...ids].sort());
    expect(ids).not.toEqual(descending.map((w) => w.variantId));
  });

  it("ramp ĐẨY mốc optimistic lock — PUT mang mốc cũ ⇒ 409 OPTIMISTIC_LOCK", async () => {
    /**
     * Người dùng mở danh sách rule TRƯỚC lần ramp rồi bấm lưu: phải nhận 409
     * kèm bản mới nhất, không phải ghi đè phần trăm rollout vừa đặt.
     */
    await holdLease(6);
    const stale = await stamp(devConfig);
    await ramp(ruleId, 45, token(6)).expect(200);

    const res = await request(app)
      .put(`/internal/flag-envs/${devConfig}/rules`)
      .set("X-Internal-Secret", SECRET)
      .send({ lastKnownUpdatedAt: stale, rules: [] })
      .expect(409);
    expect(res.body.code).toBe("OPTIMISTIC_LOCK");
  });

  it("rollback = ramp về baseline, cùng endpoint, cùng fencing (§7.3)", async () => {
    await holdLease(6);
    await ramp(ruleId, 40, token(6)).expect(200);
    await ramp(ruleId, 0, token(6)).expect(200);
    expect(await onWeight(ruleId)).toBe(0);
  });

  it("I1 qua đường ramp: 20% → 50% giữ bucket_salt, không ai đang thấy on mất nó", async () => {
    await holdLease(6);

    const audience = async (): Promise<{
      salt: string;
      users: Set<string>;
    }> => {
      const entry = (await readEntry(devEnv)).snapshot.flags.find(
        (f) => f.key === flagKey,
      );
      if (entry === undefined || "archived" in entry) {
        throw new Error("mất flag");
      }
      const rule = entry.rules.find((r) => r.id === ruleId);
      if (rule === undefined) throw new Error("mất rule");

      const users = new Set<string>();
      for (let i = 0; i < 2000; i += 1) {
        const stickyValue = `user-${String(i)}`;
        const pick = pickVariant(rule.serve, {
          stickyValue,
          flagKey,
          bucketSalt: rule.bucketSalt,
        });
        if (pick.kind !== "no-sticky" && pick.variantKey === "on") {
          users.add(stickyValue);
        }
      }
      return { salt: rule.bucketSalt, users };
    };

    await ramp(ruleId, 20, token(6)).expect(200);
    const at20 = await audience();
    await ramp(ruleId, 50, token(6)).expect(200);
    const at50 = await audience();

    expect(at50.salt).toBe(at20.salt);
    expect([...at20.users].filter((u) => !at50.users.has(u))).toEqual([]);
    expect(at50.users.size).toBeGreaterThan(at20.users.size);
  });
});

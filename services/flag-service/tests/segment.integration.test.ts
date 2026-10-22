import { randomUUID } from "node:crypto";
import {
  CLIENT_IP_HEADER,
  CLIENT_UA_HEADER,
  CONDITION_LIMITS,
  INTERNAL_SECRET_HEADER,
  SEGMENT,
  env,
} from "@udp/config";
import { createPrismaClient, type Prisma } from "@udp/db";
import { configHashOf } from "@udp/flag-evaluator";
import { segmentPayloadBytesOf, snapshotOf } from "@udp/flag-snapshot";
import {
  createActiveFlag,
  internalCall,
  lockEnvRows,
  stableOwner,
  waitForBlocked,
} from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { setRegexAnalyzer } from "../src/modules/rule/regex-safety.js";

/**
 * Ba route `/internal/segments` qua HTTP thật (§3.2, L6) — pha rủi ro nhất của
 * Plan #23 theo QA.
 *
 * File này không hỏi "lưu được không". Nó hỏi bốn câu mà QA nói là chỗ vỡ:
 *
 *   - **R02 fan-out**: mỗi lần ghi segment có tăng `config_version` và ghi outbox
 *     ở MỌI environment của project, và `config_hash` của từng environment có
 *     bằng hash của snapshot CỦA CHÍNH NÓ không (I15a, INV-23.6).
 *   - **R03 đua**: `DELETE segment` và `PUT rules` trỏ tới nó có bị tuần tự hoá
 *     qua hàng `environments` không — kiểm bằng rào chắn khoá, không bằng may rủi.
 *   - **R07 thứ tự**: phân tích ReDoS có chạy NGOÀI transaction không — chứng
 *     minh bằng cách cho nó treo rồi ghi flag cùng project.
 *   - **V21/INV-23.10**: trần dung lượng theo project có cưỡng chế dưới khoá
 *     không, kể cả khi hai lời tạo tới cùng lúc.
 */

const app = createApp();

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 4,
  cacheKey: `__udp_prisma_segtest_${randomUUID()}`,
});

const IP = "203.0.113.7";
const UA = "portal-segment-test";

interface TestProject {
  id: string;
  envs: string[];
}

let ownerId: string;
/** Project chính: ba environment, và rule chỉ đặt ở `prod` */
let A: TestProject;
/** Project khác — ma trận id chéo của I14 */
let B: TestProject;
/** Một environment, cho các ca trần dung lượng (nhanh hơn ba env) */
let Q: TestProject;
/** Một environment, cho hai ca đua: hàng đợi khoá MỘT hàng là FIFO toàn phần */
let R: TestProject;
let projectIds: string[];
let envIds: string[];

/** Flag ACTIVE ở project A — cho ca thứ tự R07 và cho rule tham chiếu segment */
let flagA: { id: string; updatedAt: string };
let variantA: string;
/** env-config của flag A ở `prod` — nơi đặt rule SEGMENT */
let prodConfigA: string;
/** Variant và env-config của flag ACTIVE ở project R */
let variantR: string;
let configR: string;

// ------------------------------------------------------------------ fixture

async function makeProject(
  tag: string,
  names: readonly string[],
): Promise<TestProject> {
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId,
      name: `segtest-${tag}-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: names.map((name, rank) => ({
          name,
          rank,
          isProduction: name === "prod",
          k8sNamespace: `udp-seg-${tag}-${suffix}-${String(rank)}`,
        })),
      },
    },
    select: {
      id: true,
      environments: { select: { id: true }, orderBy: { rank: "asc" } },
    },
  });
  return { id: project.id, envs: project.environments.map((e) => e.id) };
}

/** Project dùng một lần cho một ca — đăng ký luôn vào danh sách dọn */
async function throwawayProject(tag: string): Promise<TestProject> {
  const project = await makeProject(tag, ["dev"]);
  projectIds.push(project.id);
  envIds.push(...project.envs);
  return project;
}

const envOf = (project: TestProject, index: number): string => {
  const id = project.envs[index];
  if (id === undefined) throw new Error("project thiếu environment");
  return id;
};

async function activeFlag(
  projectId: string,
): Promise<{ id: string; updatedAt: string; variantId: string }> {
  const res = await createActiveFlag(app, ownerId, {
    projectId,
    key: `seg-${randomUUID().slice(0, 8)}`,
    flagType: "BOOLEAN",
  });
  const flag = res.body.flag as {
    id: string;
    updatedAt: string;
    variants: { id: string; key: string }[];
  };
  const variant = flag.variants[0];
  if (variant === undefined) throw new Error("flag thiếu variant");
  return { id: flag.id, updatedAt: flag.updatedAt, variantId: variant.id };
}

const configOf = (flagId: string, environmentId: string): Promise<string> =>
  admin.flagEnvConfig
    .findFirstOrThrow({
      where: { flagId, environmentId },
      select: { id: true },
    })
    .then((c) => c.id);

// ------------------------------------------------------------------ lời gọi

const call = (req: request.Test): request.Test =>
  internalCall(req, ownerId)
    .set(CLIENT_IP_HEADER, IP)
    .set(CLIENT_UA_HEADER, UA);

const post = (body: object): request.Test =>
  call(request(app).post("/internal/segments")).send(body);

const put = (
  segmentId: string,
  projectId: string,
  body: object,
): request.Test =>
  call(
    request(app).put(`/internal/segments/${segmentId}?projectId=${projectId}`),
  ).send(body);

const del = (segmentId: string, projectId: string): request.Test =>
  call(
    request(app).delete(
      `/internal/segments/${segmentId}?projectId=${projectId}`,
    ),
  );

const named = (tag: string): string => `${tag}-${randomUUID().slice(0, 8)}`;

/** `conditions` tối giản — một userId, không điều kiện thuộc tính */
const oneUser = { all: [], userIds: ["u-1"] };

const regexCondition = (value: string) => ({
  attribute: "email",
  operator: "regex",
  value,
});

/** `count` userId ASCII, mỗi cái đúng `userIdMaxLength` ký tự và khác nhau */
const userIds = (count: number, tag = "u"): string[] =>
  Array.from({ length: count }, (_, i) =>
    `${tag}-${String(i)}`.padEnd(CONDITION_LIMITS.userIdMaxLength, "x"),
  );

async function createSegment(
  projectId: string,
  conditions: object = oneUser,
  name = named("seg"),
): Promise<{ id: string; updatedAt: string }> {
  const res = await post({ projectId, name, conditions }).expect(201);
  return res.body.segment as { id: string; updatedAt: string };
}

const stampOf = (flagEnvConfigId: string): Promise<string> =>
  admin.flagEnvConfig
    .findUniqueOrThrow({
      where: { id: flagEnvConfigId },
      select: { updatedAt: true },
    })
    .then((c) => c.updatedAt.toISOString());

const segmentRule = (segmentId: string, variantId: string) => ({
  ruleType: "SEGMENT",
  condition: { segmentId },
  serve: { kind: "variant", variantId },
  priority: 1,
});

async function saveRules(
  flagEnvConfigId: string,
  rules: object[],
): Promise<void> {
  await call(request(app).put(`/internal/flag-envs/${flagEnvConfigId}/rules`))
    .send({ lastKnownUpdatedAt: await stampOf(flagEnvConfigId), rules })
    .expect(200);
}

const segmentStampOf = (segmentId: string): Promise<string> =>
  admin.segment
    .findUniqueOrThrow({
      where: { id: segmentId },
      select: { updatedAt: true },
    })
    .then((s) => s.updatedAt.toISOString());

// ------------------------------------------------------------------ đo lường

interface EnvState {
  configVersion: number;
  configHash: string;
}

async function statesOf(
  ids: readonly string[],
): Promise<Map<string, EnvState>> {
  const rows = await admin.environment.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, configVersion: true, configHash: true },
  });
  return new Map(
    rows.map((r) => [
      r.id,
      { configVersion: r.configVersion, configHash: r.configHash },
    ]),
  );
}

const outboxAt = (
  environmentId: string,
  configVersion: number,
): Promise<{ changeType: string; payload: Prisma.JsonValue }[]> =>
  admin.configChangeLog.findMany({
    where: { environmentId, configVersion },
    select: { changeType: true, payload: true },
  });

/**
 * Chốt fan-out của R02/INV-23.6, áp cho MỌI environment của project.
 *
 * Ba khẳng định độc lập, và thiếu bất kỳ cái nào thì lỗi mà R02 mô tả vẫn lọt:
 * version tiến đúng một bước, đúng MỘT dòng outbox `segment.updated` ở version
 * đó, và `config_hash` đã ghi bằng hash của snapshot environment ấy TÍNH LẠI từ
 * database.
 */
async function expectFanOut(
  project: TestProject,
  before: Map<string, EnvState>,
  payload: unknown,
): Promise<void> {
  const after = await statesOf(project.envs);
  for (const id of project.envs) {
    const was = before.get(id);
    const now = after.get(id);
    if (was === undefined || now === undefined) throw new Error("thiếu env");
    expect(now.configVersion, `version của env ${id}`).toBe(
      was.configVersion + 1,
    );
    expect(await outboxAt(id, now.configVersion)).toEqual([
      { changeType: "segment.updated", payload },
    ]);
    expect(now.configHash, `hash của env ${id}`).toBe(
      configHashOf(await snapshotOf(admin, id)),
    );
  }
}

async function expectFrozen(
  project: TestProject,
  before: Map<string, EnvState>,
): Promise<void> {
  expect(await statesOf(project.envs)).toEqual(before);
}

const auditRows = (targetId: string) =>
  admin.auditLog.findMany({
    where: { targetId },
    select: {
      action: true,
      actorUserId: true,
      ipAddress: true,
      userAgent: true,
      before: true,
      after: true,
    },
    orderBy: { occurredAt: "asc" },
  });

/** INV-23.2 — không tồn tại rule SEGMENT nào trỏ tới segment vắng mặt */
async function expectNoDanglingSegmentRule(): Promise<void> {
  const rows = await admin.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM flag_targeting_rules r
     WHERE r.rule_type = 'SEGMENT'
       AND NOT EXISTS (
             SELECT 1 FROM segments s
              WHERE s.id::text = r.condition ->> 'segmentId')`;
  expect(rows[0]?.n).toBe(0);
}

const projectBytes = async (projectId: string): Promise<number> => {
  const rows = await admin.$queryRaw<{ bytes: number }[]>`
    SELECT COALESCE(SUM(octet_length(conditions::text)), 0)::int AS bytes
      FROM segments WHERE project_id = ${projectId}::uuid`;
  return rows[0]?.bytes ?? 0;
};

/** Chèn thẳng bằng owner: dựng TRẠNG THÁI, không kiểm đường ghi */
const seedSegment = (projectId: string, count: number, tag: string) =>
  admin.segment.create({
    data: {
      projectId,
      name: named(tag),
      conditions: { all: [], userIds: userIds(count, tag) },
    },
    select: { id: true, updatedAt: true },
  });

// ------------------------------------------------------------------ vòng đời

beforeAll(async () => {
  ownerId = (await stableOwner(admin)).id;
  projectIds = [];
  envIds = [];
  A = await makeProject("a", ["dev", "staging", "prod"]);
  B = await makeProject("b", ["dev"]);
  Q = await makeProject("q", ["dev"]);
  R = await makeProject("r", ["dev"]);
  projectIds.push(A.id, B.id, Q.id, R.id);
  envIds.push(...A.envs, ...B.envs, ...Q.envs, ...R.envs);

  const fa = await activeFlag(A.id);
  flagA = { id: fa.id, updatedAt: fa.updatedAt };
  variantA = fa.variantId;
  prodConfigA = await configOf(fa.id, envOf(A, 2));

  const fr = await activeFlag(R.id);
  variantR = fr.variantId;
  configR = await configOf(fr.id, envOf(R, 0));
}, 180_000);

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (envIds !== undefined) {
    await admin.configChangeLog.deleteMany({
      where: { environmentId: { in: envIds } },
    });
    await admin.auditLog.deleteMany({
      where: { projectId: { in: projectIds } },
    });
    await admin.project.deleteMany({ where: { id: { in: projectIds } } });
  }
  await admin.$disconnect();
});

// ==================================================================== tests

describe("fan-out MỌI environment của project (R02, INV-23.6, L6)", () => {
  it("tạo ⇒ 201; cả ba env của A tiến đúng 1 version với hash khớp snapshot; env của B đứng yên", async () => {
    const before = await statesOf(A.envs);
    const frozen = await statesOf(B.envs);
    const segment = await createSegment(A.id, {
      all: [],
      userIds: ["u-fanout-1", "u-fanout-2"],
    });

    await expectFanOut(A, before, {
      segment: {
        id: segment.id,
        all: [],
        userIds: ["u-fanout-1", "u-fanout-2"],
      },
    });
    await expectFrozen(B, frozen);
  });

  it("sửa ⇒ segment.updated ở MỌI env của A, kể cả env KHÔNG có rule nào dùng nó", async () => {
    const segment = await createSegment(A.id);
    /**
     * Rule chỉ ở `prod`. `dev` và `staging` không tham chiếu segment này — và
     * chính hai environment đó là chỗ lỗi R02 (b) sống: theo đúng chữ "chỉ ghi
     * outbox cho env có rule dùng segment" thì chúng không nhận gì, `config_hash`
     * của chúng mô tả trạng thái cũ, và một rule PUT ở đó về sau sẽ được SDK đánh
     * giá bằng điều kiện CŨ của segment.
     */
    await saveRules(prodConfigA, [segmentRule(segment.id, variantA)]);

    const before = await statesOf(A.envs);
    await put(segment.id, A.id, {
      name: named("renamed"),
      description: "đã sửa",
      conditions: { all: [], userIds: ["u-after"] },
      lastKnownUpdatedAt: segment.updatedAt,
    }).expect(200);

    await expectFanOut(A, before, {
      segment: { id: segment.id, all: [], userIds: ["u-after"] },
    });
    await saveRules(prodConfigA, []);
    await del(segment.id, A.id).expect(200);
  });

  it("xoá segment không ai dùng ⇒ 200, fan-out với payload absentSegmentId", async () => {
    const segment = await createSegment(A.id);
    const before = await statesOf(A.envs);
    await del(segment.id, A.id).expect(200);
    await expectFanOut(A, before, { absentSegmentId: segment.id });
    expect(
      await admin.segment.findUnique({ where: { id: segment.id } }),
    ).toBeNull();
  });

  it("project 0 environment ⇒ 404, không ghi gì (F8)", async () => {
    const empty = await admin.project.create({
      data: {
        ownerId,
        name: `segtest-noenv-${randomUUID().slice(0, 8)}`,
        creationMode: "CREATE_NEW",
        languageRuntime: "nodejs",
        resourceQuota: {},
      },
      select: { id: true },
    });
    try {
      await post({
        projectId: empty.id,
        name: named("seg"),
        conditions: oneUser,
      }).expect(404);
      expect(
        await admin.segment.count({ where: { projectId: empty.id } }),
      ).toBe(0);
    } finally {
      await admin.project.delete({ where: { id: empty.id } });
    }
  });
});

describe("trùng tên, optimistic lock, mốc updated_at", () => {
  it("trùng tên trong project ⇒ 409 DUPLICATE_RESOURCE; cùng tên ở project khác ⇒ 201", async () => {
    const name = named("shared-name");
    await createSegment(A.id, oneUser, name);
    const before = await statesOf(A.envs);
    const clash = await post({
      projectId: A.id,
      name,
      conditions: oneUser,
    }).expect(409);
    expect(clash.body.code).toBe("DUPLICATE_RESOURCE");
    await expectFrozen(A, before);

    await post({ projectId: B.id, name, conditions: oneUser }).expect(201);
  });

  it("PUT mốc cũ ⇒ 409 OPTIMISTIC_LOCK kèm current; segment và version không đổi", async () => {
    const segment = await createSegment(A.id);
    const stale = segment.updatedAt;
    await put(segment.id, A.id, {
      name: named("first"),
      description: null,
      conditions: { all: [], userIds: ["u-first"] },
      lastKnownUpdatedAt: stale,
    }).expect(200);

    const before = await statesOf(A.envs);
    const res = await put(segment.id, A.id, {
      name: named("second"),
      description: null,
      conditions: { all: [], userIds: ["u-second"] },
      lastKnownUpdatedAt: stale,
    }).expect(409);
    expect(res.body.code).toBe("OPTIMISTIC_LOCK");
    expect(res.body.current.updatedAt).toEqual(expect.any(String));
    await expectFrozen(A, before);
    expect(
      (
        await admin.segment.findUniqueOrThrow({
          where: { id: segment.id },
          select: { conditions: true },
        })
      ).conditions,
    ).toEqual({ all: [], userIds: ["u-first"] });
  });

  it("PUT thành công đẩy mốc updated_at (R28 — @updatedAt được tôn trọng)", async () => {
    const segment = await createSegment(A.id);
    const res = await put(segment.id, A.id, {
      name: named("bumped"),
      description: null,
      conditions: oneUser,
      lastKnownUpdatedAt: segment.updatedAt,
    }).expect(200);
    const next = res.body.segment.updatedAt as string;
    expect(new Date(next).getTime()).toBeGreaterThan(
      new Date(segment.updatedAt).getTime(),
    );
    /** Mốc trả về là mốc THẬT trong database, không phải giá trị bên gọi gửi */
    expect(await segmentStampOf(segment.id)).toBe(new Date(next).toISOString());
  });

  it("userIds trùng bị khử, GIỮ thứ tự lần đầu (V13)", async () => {
    const segment = await createSegment(A.id, {
      all: [],
      userIds: ["b", "a", "b", "c", "a"],
    });
    expect(
      (
        await admin.segment.findUniqueOrThrow({
          where: { id: segment.id },
          select: { conditions: true },
        })
      ).conditions,
    ).toEqual({ all: [], userIds: ["b", "a", "c"] });
  });
});

describe("schema chặn trước khi chạm database", () => {
  const cases: [string, object][] = [
    ["thiếu all", { userIds: ["u-1"] }],
    ["thiếu userIds", { all: [] }],
    ["cả hai rỗng", { all: [], userIds: [] }],
    [
      `quá ${String(CONDITION_LIMITS.conditionsPerRule)} điều kiện`,
      {
        all: Array.from(
          { length: CONDITION_LIMITS.conditionsPerRule + 1 },
          (_, i) => ({
            attribute: "plan",
            operator: "eq",
            value: `v${String(i)}`,
          }),
        ),
        userIds: [],
      },
    ],
    [
      `quá ${String(CONDITION_LIMITS.userIdsMax)} userId`,
      { all: [], userIds: userIds(CONDITION_LIMITS.userIdsMax + 1) },
    ],
    [
      "userId dài quá trần",
      { all: [], userIds: ["x".repeat(CONDITION_LIMITS.userIdMaxLength + 1)] },
    ],
    [
      "điều kiện SEGMENT lồng trong segment (không đệ quy)",
      { all: [{ segmentId: randomUUID() }], userIds: [] },
    ],
    ["trường lạ trong conditions", { all: [], userIds: ["u-1"], extra: true }],
  ];

  it.each(cases)("%s ⇒ 400", async (_label, conditions) => {
    const before = await statesOf(A.envs);
    const count = await admin.segment.count({ where: { projectId: A.id } });
    await post({ projectId: A.id, name: named("bad"), conditions }).expect(400);
    expect(await admin.segment.count({ where: { projectId: A.id } })).toBe(
      count,
    );
    await expectFrozen(A, before);
  });

  it("chuỗi chứa NUL ⇒ 400, không để Postgres ném 22P05 (V13, R38)", async () => {
    const nul = String.fromCharCode(0);
    await post({
      projectId: A.id,
      name: named("nul"),
      conditions: { all: [], userIds: [`u${nul}1`] },
    }).expect(400);
  });
});

describe("ReDoS chạy TRƯỚC transaction (R07)", () => {
  it.each(["^(a+)+$", "^(a|a)*$", "(x+x+)+y"])(
    "pattern %s ⇒ 422 trước khi chạm database",
    async (pattern) => {
      const before = await statesOf(A.envs);
      const count = await admin.segment.count({ where: { projectId: A.id } });
      const res = await post({
        projectId: A.id,
        name: named("redos"),
        conditions: { all: [regexCondition(pattern)], userIds: [] },
      }).expect(422);
      expect(res.body.detail).toMatch(/ReDoS/);
      expect(await admin.segment.count({ where: { projectId: A.id } })).toBe(
        count,
      );
      await expectFrozen(A, before);
    },
  );

  it("pattern tuyến tính ⇒ 201", async () => {
    const segment = await createSegment(A.id, {
      all: [regexCondition("^[a-z]+@udp[.]vn$")],
      userIds: [],
    });
    await del(segment.id, A.id).expect(200);
  });

  it("pattern chưa ở dạng NFC ⇒ 400 ở schema (không lưu thứ sẽ chạy khác đi)", async () => {
    const acute = String.fromCharCode(0x0301);
    await post({
      projectId: A.id,
      name: named("nfc"),
      conditions: { all: [regexCondition(`^e${acute}$`)], userIds: [] },
    }).expect(400);
  });

  /**
   * Chốt THỨ TỰ của R07 (b): phân tích ReDoS không được giữ khoá environment.
   *
   * Cho bộ phân tích treo vô hạn, rồi PATCH một flag CÙNG project. Nếu phân tích
   * chạy trong `mutate` thì lần PATCH kia đứng ở bước 1 của ADR-05 cho tới khi
   * `TRANSACTION_BUDGET.timeout` hết — tức là một lần lưu segment chặn mọi lần
   * ghi flag và cả kill-switch của Service 3 (I30).
   */
  it("phân tích treo thì PATCH flag cùng project vẫn xong", async () => {
    let unblock!: () => void;
    const hang = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const restore = setRegexAnalyzer(async () => {
      reached();
      await hang;
      return undefined;
    });

    try {
      const pending = post({
        projectId: A.id,
        name: named("hanging"),
        conditions: { all: [regexCondition("^hang-me$")], userIds: [] },
      }).then((res) => res);
      await entered;

      const patched = await call(
        request(app).patch(`/internal/flags/${flagA.id}`),
      )
        .send({
          lastKnownUpdatedAt: flagA.updatedAt,
          description: "xong trong lúc phân tích ReDoS đang treo",
        })
        .expect(200);
      flagA = {
        id: flagA.id,
        updatedAt: patched.body.flag.updatedAt as string,
      };

      unblock();
      const created = await pending;
      expect(created.status).toBe(201);
      await del(created.body.segment.id as string, A.id).expect(200);
    } finally {
      restore();
      unblock();
    }
  });
});

describe("xoá bị chặn khi còn rule tham chiếu (R03, SEGMENT_IN_USE)", () => {
  it("rule ở BẤT KỲ env ⇒ 409 kèm resourceId là flag; không đổi gì", async () => {
    const segment = await createSegment(A.id);
    await saveRules(prodConfigA, [segmentRule(segment.id, variantA)]);

    const before = await statesOf(A.envs);
    const res = await del(segment.id, A.id).expect(409);
    expect(res.body.code).toBe("SEGMENT_IN_USE");
    expect(res.body.resourceId).toBe(flagA.id);
    await expectFrozen(A, before);
    /** Chỉ còn dòng audit của lần tạo — lần xoá bị lùi không để lại gì (I40c) */
    expect((await auditRows(segment.id)).map((r) => r.action)).toEqual([
      "segment.create",
    ]);
    expect(
      await admin.segment.findUnique({ where: { id: segment.id } }),
    ).not.toBeNull();

    await saveRules(prodConfigA, []);
    await del(segment.id, A.id).expect(200);
    await expectNoDanglingSegmentRule();
  });

  it("rule của flag ARCHIVED vẫn chặn xoá", async () => {
    const segment = await createSegment(A.id);
    const flag = await activeFlag(A.id);
    const config = await configOf(flag.id, envOf(A, 0));
    await saveRules(config, [segmentRule(segment.id, flag.variantId)]);
    await call(request(app).patch(`/internal/flags/${flag.id}`))
      .send({
        lastKnownUpdatedAt: (
          await admin.featureFlag.findUniqueOrThrow({
            where: { id: flag.id },
            select: { updatedAt: true },
          })
        ).updatedAt.toISOString(),
        lifecycleStatus: "ARCHIVED",
      })
      .expect(200);

    const res = await del(segment.id, A.id).expect(409);
    expect(res.body.code).toBe("SEGMENT_IN_USE");
    expect(res.body.resourceId).toBe(flag.id);

    await saveRules(config, []);
    await del(segment.id, A.id).expect(200);
  });
});

describe("V12 — rollout sống giữ rule SEGMENT", () => {
  it("đổi conditions ⇒ 409 ROLLOUT_IN_PROGRESS kèm resourceId; chỉ đổi tên ⇒ 200", async () => {
    const segment = await createSegment(R.id);
    await saveRules(configR, [segmentRule(segment.id, variantR)]);
    const rule = await admin.flagTargetingRule.findFirstOrThrow({
      where: { flagEnvConfigId: configR },
      select: { id: true },
    });
    const rollout = await admin.rolloutSession.create({
      data: {
        projectId: R.id,
        environmentId: envOf(R, 0),
        flagEnvConfigId: configR,
        targetingRuleId: rule.id,
        targetVariantId: variantR,
        workloadName: "seg-rollout",
        rolloutScope: "FLAG_LEVEL",
        strategy: "CANARY",
        controlMode: "UDP_DRIVEN",
        status: "IN_PROGRESS",
        currentTrafficPercentage: 10,
        baselinePercentage: 10,
        thresholds: {},
        stepPercent: 10,
        createdById: ownerId,
      },
      select: { id: true },
    });

    try {
      const blocked = await put(segment.id, R.id, {
        name: named("canary"),
        description: null,
        conditions: { all: [], userIds: ["u-moved"] },
        lastKnownUpdatedAt: await segmentStampOf(segment.id),
      }).expect(409);
      expect(blocked.body.code).toBe("ROLLOUT_IN_PROGRESS");
      expect(blocked.body.resourceId).toBe(rollout.id);

      /** Đổi tên không đổi ai nhận gì, nên rollout không chặn nó */
      await put(segment.id, R.id, {
        name: named("renamed-only"),
        description: "chỉ đổi tên",
        conditions: oneUser,
        lastKnownUpdatedAt: await segmentStampOf(segment.id),
      }).expect(200);
    } finally {
      await admin.rolloutSession.delete({ where: { id: rollout.id } });
      await saveRules(configR, []);
      await del(segment.id, R.id).expect(200);
    }
  });
});

describe("audit trong transaction (I40) và guard nội bộ", () => {
  it("mỗi lần ghi đúng MỘT dòng, mang actor/IP/UA, và KHÔNG mang userIds nguyên văn", async () => {
    const segment = await createSegment(A.id, {
      all: [],
      userIds: ["u-audit-1", "u-audit-2"],
    });
    const created = await auditRows(segment.id);
    expect(created).toHaveLength(1);
    expect(created[0]?.action).toBe("segment.create");
    expect(created[0]?.actorUserId).toBe(ownerId);
    expect(created[0]?.ipAddress).toBe(IP);
    expect(created[0]?.userAgent).toBe(UA);
    const after = created[0]?.after as Record<string, unknown>;
    expect(after.userIdCount).toBe(2);
    expect(after.userIdsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(after)).not.toContain("u-audit-1");

    await put(segment.id, A.id, {
      name: named("audited"),
      description: null,
      conditions: oneUser,
      lastKnownUpdatedAt: segment.updatedAt,
    }).expect(200);
    await del(segment.id, A.id).expect(200);
    expect(new Set((await auditRows(segment.id)).map((r) => r.action))).toEqual(
      new Set(["segment.create", "segment.update", "segment.delete"]),
    );
    expect(await auditRows(segment.id)).toHaveLength(3);
  });

  it("lần ghi bị lùi ⇒ 0 dòng audit mới (audit nằm trong cùng transaction)", async () => {
    const segment = await createSegment(A.id);
    const rows = await auditRows(segment.id);
    await put(segment.id, A.id, {
      name: named("rolled-back"),
      description: null,
      conditions: oneUser,
      lastKnownUpdatedAt: new Date(0).toISOString(),
    }).expect(409);
    expect(await auditRows(segment.id)).toEqual(rows);
    await del(segment.id, A.id).expect(200);
  });

  it("thiếu X-Udp-Actor-Id ⇒ 400; thiếu bí mật nội bộ ⇒ 401", async () => {
    await request(app)
      .post("/internal/segments")
      .set(INTERNAL_SECRET_HEADER, env.INTERNAL_SERVICE_SECRET)
      .send({ projectId: A.id, name: named("noactor"), conditions: oneUser })
      .expect(400);
    await request(app)
      .post("/internal/segments")
      .send({ projectId: A.id, name: named("nosecret"), conditions: oneUser })
      .expect(401);
  });

  it("segment của project khác trong PUT/DELETE ⇒ 404 (I14, R05)", async () => {
    const segment = await createSegment(B.id);
    const before = await statesOf(B.envs);
    await put(segment.id, A.id, {
      name: named("crossed"),
      description: null,
      conditions: oneUser,
      lastKnownUpdatedAt: segment.updatedAt,
    }).expect(404);
    await del(segment.id, A.id).expect(404);
    await expectFrozen(B, before);
    expect(
      await admin.segment.findUnique({ where: { id: segment.id } }),
    ).not.toBeNull();
  });

  /**
   * INV-23.8 ở biên trong, phần TẤT ĐỊNH: thân là JSON HỎNG, nên nếu parser chạy
   * trước guard thì câu trả lời là 400. 401 chứng minh guard đứng trước parser,
   * và phép kiểm này không phụ thuộc kích thước hay đồng hồ.
   */
  it("thân JSON hỏng của người vô danh ⇒ 401, KHÔNG phải 400 (parser đứng sau guard)", async () => {
    const res = await request(app)
      .post("/internal/segments")
      .set("content-type", "application/json")
      .send('{"broken":');
    expect(res.status).toBe(401);
  });

  /**
   * Và phần KÍCH THƯỚC: 16 MiB vô danh không bao giờ được đọc hết.
   *
   * Server trả 401 rồi đóng kết nối trong lúc client vẫn đang tải lên, nên
   * `supertest` có thể thấy 401 HOẶC thấy kết nối bị cắt (`ECONNRESET`/`EPIPE`)
   * tuỳ nó kịp đọc response trước khi socket đóng hay không. Cả hai kết cục đều
   * chứng minh điều cần chứng minh: KHÔNG có 400 (thân hỏng đã được parse) và
   * KHÔNG có 413 (parser đã chạy rồi mới từ chối).
   */
  it("body 16 MiB vô danh không bao giờ được parse (INV-23.8)", async () => {
    const outcome = await request(app)
      .post("/internal/segments")
      .set("content-type", "application/json")
      .send(`{"broken":"${"x".repeat(16 * 1024 * 1024)}`)
      .then((res) => res.status as number | string)
      .catch((err: unknown) => (err as { code?: string }).code ?? "ERR");
    expect([401, "ECONNRESET", "EPIPE"]).toContain(outcome);
  }, 60_000);
});

describe("trần số lượng và trần dung lượng (V5, V21, AC-5.4, INV-23.10)", () => {
  it(`segment thứ ${String(SEGMENT.maxPerProject + 1)} ⇒ 422 QUOTA_EXCEEDED (V5)`, async () => {
    const project = await throwawayProject("quota");
    await admin.segment.createMany({
      data: Array.from({ length: SEGMENT.maxPerProject }, (_, i) => ({
        projectId: project.id,
        name: `quota-${String(i)}`,
        conditions: { all: [], userIds: ["u-1"] },
      })),
    });
    const before = await statesOf(project.envs);
    const res = await post({
      projectId: project.id,
      name: named("over"),
      conditions: oneUser,
    }).expect(422);
    expect(res.body.code).toBe("QUOTA_EXCEEDED");
    await expectFrozen(project, before);
  });

  it("MỘT segment lớn hơn trần TỔNG ⇒ 422 trước transaction (§16 (e))", async () => {
    const before = await statesOf(Q.envs);
    /** userId toàn ký tự BMP 3 byte — ca §2.1 nói không bao giờ lưu được */
    const bmp = "ệ".repeat(CONDITION_LIMITS.userIdMaxLength);
    const conditions = {
      all: [],
      userIds: Array.from({ length: 6_000 }, (_, i) =>
        `${String(i)}${bmp}`.slice(0, CONDITION_LIMITS.userIdMaxLength),
      ),
    };
    expect(segmentPayloadBytesOf(conditions)).toBeGreaterThan(
      SEGMENT.maxProjectBytes,
    );
    const res = await post({
      projectId: Q.id,
      name: named("huge"),
      conditions,
    }).expect(422);
    expect(res.body.code).toBe("QUOTA_EXCEEDED");
    await expectFrozen(Q, before);
  }, 60_000);

  it("tạo làm tổng vượt trần ⇒ 422; sửa làm tăng vượt trần ⇒ 422; sửa làm nhỏ đi ⇒ 200", async () => {
    const project = await throwawayProject("bytes");
    await seedSegment(project.id, 9_300, "big"); // ~2,4 MB
    const medium = await seedSegment(project.id, 6_200, "med"); // ~1,6 MB
    expect(await projectBytes(project.id)).toBeLessThan(
      SEGMENT.maxProjectBytes,
    );

    const before = await statesOf(project.envs);
    const created = await post({
      projectId: project.id,
      name: named("extra"),
      conditions: { all: [], userIds: userIds(2_000, "extra") },
    }).expect(422);
    expect(created.body.code).toBe("QUOTA_EXCEEDED");
    await expectFrozen(project, before);

    const grow = await put(medium.id, project.id, {
      name: named("grown"),
      description: null,
      conditions: { all: [], userIds: userIds(7_800, "med") },
      lastKnownUpdatedAt: medium.updatedAt.toISOString(),
    }).expect(422);
    expect(grow.body.code).toBe("QUOTA_EXCEEDED");
    await expectFrozen(project, before);

    await put(medium.id, project.id, {
      name: named("shrunk"),
      description: null,
      conditions: { all: [], userIds: userIds(3_000, "med") },
      lastKnownUpdatedAt: medium.updatedAt.toISOString(),
    }).expect(200);
    expect(await projectBytes(project.id)).toBeLessThan(
      SEGMENT.maxProjectBytes,
    );
  }, 120_000);

  it("project ĐÃ vượt trần vẫn sửa nhỏ đi được, nhưng không phình thêm (V21)", async () => {
    const project = await throwawayProject("over");
    await seedSegment(project.id, 16_700, "fat"); // ~4,3 MB, tự nó đã vượt trần
    const small = await seedSegment(project.id, 2_000, "small");
    expect(await projectBytes(project.id)).toBeGreaterThan(
      SEGMENT.maxProjectBytes,
    );

    const grow = await put(small.id, project.id, {
      name: named("grow"),
      description: null,
      conditions: { all: [], userIds: userIds(2_400, "small") },
      lastKnownUpdatedAt: small.updatedAt.toISOString(),
    }).expect(422);
    expect(grow.body.code).toBe("QUOTA_EXCEEDED");

    await put(small.id, project.id, {
      name: named("shrink"),
      description: null,
      conditions: { all: [], userIds: userIds(1_000, "small") },
      lastKnownUpdatedAt: small.updatedAt.toISOString(),
    }).expect(200);
  }, 120_000);

  /**
   * INV-23.10: hai lời TẠO đồng thời không cùng lọt qua trần.
   *
   * Đây là ca mà một phép kiểm NGOÀI khoá luôn để lọt: cả hai đọc tổng cũ (0),
   * cả hai thấy còn chỗ, cả hai ghi. Vì phép kiểm nằm trong `mutate` — sau khi
   * bước 1 của ADR-05 đã khoá hàng `environments` — hai transaction bị tuần tự
   * hoá và bên thứ hai thấy tổng đã gồm bên thứ nhất.
   */
  it("hai lời tạo đồng thời: đúng một 201, một 422", async () => {
    const project = await throwawayProject("race-bytes");
    const half = (tag: string) => ({
      projectId: project.id,
      name: named(tag),
      conditions: { all: [], userIds: userIds(9_300, tag) },
    });
    const results = await Promise.all([
      post(half("l")).then((r) => r.status),
      post(half("r")).then((r) => r.status),
    ]);
    expect(results.sort((a, b) => a - b)).toEqual([201, 422]);
    expect(await projectBytes(project.id)).toBeLessThanOrEqual(
      SEGMENT.maxProjectBytes,
    );
  }, 120_000);

  /**
   * AC-3.10 ở biên trong: segment ASCII lớn nhất theo trần TỪNG segment (10 000
   * userId × 256 ký tự, canonical 2 590 022 B) luôn lưu được trên project trống.
   *
   * [v4.10] Khẳng định theo CẢ HAI thước, vì hai con số khác nhau cho cùng một
   * segment: `segmentPayloadBytesOf` (canonical, chặn dưới, từ chối sớm) và
   * `octet_length(conditions::text)` (thước của trần, cưỡng chế dưới khoá). Con số
   * thứ hai dài hơn đúng 10 002 byte — 10 000 dấu `,` và 2 dấu `:` mà Postgres in
   * kèm khoảng trắng — và vẫn dưới trần, nên 201 đúng theo thước được cưỡng chế.
   */
  it("segment ASCII ở trần schema ⇒ 201 trên project trống (AC-3.10)", async () => {
    const project = await throwawayProject("cap");
    const conditions = {
      all: [],
      userIds: userIds(CONDITION_LIMITS.userIdsMax, "cap"),
    };
    expect(segmentPayloadBytesOf(conditions)).toBe(2_590_022);
    await post({
      projectId: project.id,
      name: named("at-cap"),
      conditions,
    }).expect(201);
    expect(await projectBytes(project.id)).toBe(2_600_024);
    expect(await projectBytes(project.id)).toBeLessThanOrEqual(
      SEGMENT.maxProjectBytes,
    );
  }, 120_000);
});

describe("đua", () => {
  it("hai PUT cùng mốc ⇒ đúng một 200, một 409; version tiến đúng một lần", async () => {
    const segment = await createSegment(A.id);
    const before = await statesOf(A.envs);
    const body = (tag: string) => ({
      name: named(tag),
      description: null,
      conditions: { all: [], userIds: [`u-${tag}`] },
      lastKnownUpdatedAt: segment.updatedAt,
    });
    const results = await Promise.all([
      put(segment.id, A.id, body("l")).then((r) => r.status),
      put(segment.id, A.id, body("r")).then((r) => r.status),
    ]);
    expect(results.sort((a, b) => a - b)).toEqual([200, 409]);
    const after = await statesOf(A.envs);
    for (const id of A.envs) {
      expect(after.get(id)?.configVersion).toBe(
        (before.get(id)?.configVersion ?? 0) + 1,
      );
    }
    await del(segment.id, A.id).expect(200);
  });

  it("hai POST cùng tên ⇒ một 201, một 409 DUPLICATE_RESOURCE", async () => {
    const name = named("dup-race");
    const results = await Promise.all([
      post({ projectId: A.id, name, conditions: oneUser }).then(
        (r) => r.status,
      ),
      post({ projectId: A.id, name, conditions: oneUser }).then(
        (r) => r.status,
      ),
    ]);
    expect(results.sort((a, b) => a - b)).toEqual([201, 409]);
    expect(
      await admin.segment.count({ where: { projectId: A.id, name } }),
    ).toBe(1);
  });

  /**
   * R03 — chứng minh `DELETE segment` và `PUT rules` tuần tự hoá qua hàng
   * `environments`, KHÔNG dựa vào may rủi lịch OS.
   *
   * Rào chắn giữ `FOR UPDATE` trên hàng environment của project; hai request xếp
   * hàng sau nó theo thứ tự đến (hàng đợi khoá dòng của Postgres là FIFO), và
   * project này có ĐÚNG một environment nên thứ tự đó là toàn phần. Nếu phép kiểm
   * tham chiếu của DELETE chạy NGOÀI khoá thì nó đọc trạng thái trước khi PUT
   * commit, xoá segment, và để lại một rule trỏ tới id vắng mặt — thứ evaluator
   * bỏ qua trong im lặng.
   */
  it("PUT rules tới trước ⇒ DELETE segment nhận 409 SEGMENT_IN_USE", async () => {
    const segment = await createSegment(R.id);
    const stamp = await stampOf(configR);
    const gate = await lockEnvRows(admin, R.envs);
    try {
      const rules = call(
        request(app).put(`/internal/flag-envs/${configR}/rules`),
      )
        .send({
          lastKnownUpdatedAt: stamp,
          rules: [segmentRule(segment.id, variantR)],
        })
        .then((r) => r);
      await waitForBlocked(admin, gate, 1);
      const removal = del(segment.id, R.id).then((r) => r);
      await waitForBlocked(admin, gate, 2);
      await gate.release();

      expect((await rules).status).toBe(200);
      const res = await removal;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("SEGMENT_IN_USE");
    } finally {
      await gate.release();
    }
    await expectNoDanglingSegmentRule();
    await saveRules(configR, []);
    await del(segment.id, R.id).expect(200);
  }, 60_000);

  it("DELETE segment tới trước ⇒ PUT rules nhận 422 (segment không thuộc project)", async () => {
    const segment = await createSegment(R.id);
    const stamp = await stampOf(configR);
    const gate = await lockEnvRows(admin, R.envs);
    try {
      const removal = del(segment.id, R.id).then((r) => r);
      await waitForBlocked(admin, gate, 1);
      const rules = call(
        request(app).put(`/internal/flag-envs/${configR}/rules`),
      )
        .send({
          lastKnownUpdatedAt: stamp,
          rules: [segmentRule(segment.id, variantR)],
        })
        .then((r) => r);
      await waitForBlocked(admin, gate, 2);
      await gate.release();

      expect((await removal).status).toBe(200);
      expect((await rules).status).toBe(422);
    } finally {
      await gate.release();
    }
    await expectNoDanglingSegmentRule();
    expect(
      await admin.flagTargetingRule.count({
        where: { flagEnvConfigId: configR },
      }),
    ).toBe(0);
  }, 60_000);
});

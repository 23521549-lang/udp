import { randomUUID } from "node:crypto";
import {
  CLIENT_IP_HEADER,
  CLIENT_UA_HEADER,
  INTERNAL_SECRET_HEADER,
  SDK_KEY,
  env,
} from "@udp/config";
import {
  createPrismaClient,
  issueSdkKeyToken,
  sdkKeyMaterialOf,
  SDK_KEY_PLAINTEXT_PATTERN,
  type Prisma,
  type SdkKeyType,
} from "@udp/db";
import {
  internalCall,
  scanForSecret,
  sdkKeyData,
  stableOwner,
} from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/**
 * Hai route `/internal/sdk-keys` qua HTTP thật (§3.2, L1, L7, V4, V5) [v4.9].
 *
 * File này hỏi năm câu, và mỗi câu là một chỗ QA nói sẽ vỡ:
 *
 *   - **Vòng tròn phát hành (L7):** token sinh bằng `issueSdkKeyToken` của
 *     Service 1, lưu bằng hash mà Service 2 nhận, rồi guard của Service 2 tra lại
 *     đúng token đó. Ba công thức ấy từng nằm ở ba nơi; lệch một nơi là khoá phát
 *     hành ra không bao giờ dùng được, và không test đơn lẻ nào thấy.
 *   - **Idempotent theo `key_hash` (V4, R24, C-05):** gửi lại CÙNG vật liệu ra
 *     200 `created:false` — kể cả ở environment đã có 19 khoá, nơi một phép đếm
 *     quota đặt trước phép tra hash sẽ trả 422 cho chính khoá vừa tạo.
 *   - **Trần khoá dưới khoá (V5, AC-5.1):** nhiều lời tạo đồng thời không bao giờ
 *     cùng lọt qua trần.
 *   - **Thu hồi đi qua outbox (L1):** đúng MỘT dòng `sdkkey.revoked`, version
 *     tiến, `config_hash` KHÔNG đổi — ba điều kiện để poller chiếu nó thành no-op
 *     và hub gửi `flag_changed` rỗng thay cho snapshot. (Nửa còn lại của L1 —
 *     poller và hub — đã có test riêng: `changefeed.test.ts` và
 *     `sse.manager.test.ts` §"thu hồi khoá".)
 *   - **Cô lập environment (R05, I14):** id chéo ra 404, không thay đổi, không
 *     audit, không outbox.
 */

const app = createApp();

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 4,
  cacheKey: `__udp_prisma_keytest_${randomUUID()}`,
});

const IP = "203.0.113.11";
const UA = "portal-sdk-key-test";

interface TestProject {
  id: string;
  envs: string[];
}

let ownerId: string;
/** Project chính: hai environment — environment thứ hai là id chéo của I14 */
let A: TestProject;
/** Project khác — id chéo mạnh hơn: khác cả project */
let B: TestProject;
let projectIds: string[];
let envIds: string[];

// ------------------------------------------------------------------ fixture

async function makeProject(
  tag: string,
  names: readonly string[],
): Promise<TestProject> {
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId,
      name: `keytest-${tag}-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: names.map((name, rank) => ({
          name,
          rank,
          isProduction: name === "prod",
          k8sNamespace: `udp-key-${tag}-${suffix}-${String(rank)}`,
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

// ------------------------------------------------------------------ lời gọi

const call = (req: request.Test): request.Test =>
  internalCall(req, ownerId)
    .set(CLIENT_IP_HEADER, IP)
    .set(CLIENT_UA_HEADER, UA);

/**
 * Vật liệu của MỘT khoá, sinh đúng như Service 1 sinh (L7).
 *
 * Token ở lại trong tiến trình test, đúng vai Service 1: thứ gửi đi chỉ có hash
 * và đuôi. Nhờ vậy chính file này chứng minh được rằng Service 2 không có cách
 * nào thấy plaintext — phép quét cuối cùng tìm token trong toàn bộ database.
 */
interface KeyMaterial {
  token: string;
  environmentId: string;
  keyType: SdkKeyType;
  label: string | null;
  keyHash: string;
  keySuffix: string;
}

function material(
  environmentId: string,
  keyType: SdkKeyType = "SERVER",
  label: string | null = "test-label",
): KeyMaterial {
  const token = issueSdkKeyToken(keyType, "QA Việt");
  return {
    token,
    environmentId,
    keyType,
    label,
    ...sdkKeyMaterialOf(token),
  };
}

/** Thân của `POST /internal/sdk-keys` — KHÔNG mang `token` */
const bodyOf = (m: KeyMaterial) => ({
  environmentId: m.environmentId,
  keyType: m.keyType,
  label: m.label,
  keyHash: m.keyHash,
  keySuffix: m.keySuffix,
});

const post = (body: object): request.Test =>
  call(request(app).post("/internal/sdk-keys")).send(body);

const del = (keyId: string, environmentId: string): request.Test =>
  call(
    request(app).delete(
      `/internal/sdk-keys/${keyId}?environmentId=${environmentId}`,
    ),
  );

async function createKey(m: KeyMaterial): Promise<string> {
  const res = await post(bodyOf(m)).expect(201);
  expect(res.body.created).toBe(true);
  return (res.body.key as { id: string }).id;
}

/** Chèn thẳng bằng owner: dựng TRẠNG THÁI (n khoá sống), không kiểm đường ghi */
async function seedKeys(environmentId: string, count: number): Promise<void> {
  await admin.sdkKey.createMany({
    data: Array.from({ length: count }, () =>
      sdkKeyData({
        token: issueSdkKeyToken("SERVER", "seed"),
        environmentId,
        keyType: "SERVER",
        createdById: ownerId,
      }),
    ),
  });
}

// ------------------------------------------------------------------ đo lường

const activeCount = (environmentId: string): Promise<number> =>
  admin.sdkKey.count({ where: { environmentId, revokedAt: null } });

interface EnvState {
  configVersion: number;
  configHash: string;
}

const stateOf = (environmentId: string): Promise<EnvState> =>
  admin.environment.findUniqueOrThrow({
    where: { id: environmentId },
    select: { configVersion: true, configHash: true },
  });

const outboxOf = (
  environmentId: string,
): Promise<{ changeType: string; payload: Prisma.JsonValue }[]> =>
  admin.configChangeLog.findMany({
    where: { environmentId },
    select: { changeType: true, payload: true },
    orderBy: { configVersion: "asc" },
  });

const auditRows = (targetId: string) =>
  admin.auditLog.findMany({
    where: { targetId },
    select: {
      action: true,
      actorUserId: true,
      environmentId: true,
      ipAddress: true,
      userAgent: true,
      before: true,
      after: true,
    },
    orderBy: { occurredAt: "asc" },
  });

// ------------------------------------------------------------------ vòng đời

beforeAll(async () => {
  ownerId = (await stableOwner(admin)).id;
  projectIds = [];
  envIds = [];
  A = await makeProject("a", ["dev", "prod"]);
  B = await makeProject("b", ["dev"]);
  projectIds.push(A.id, B.id);
  envIds.push(...A.envs, ...B.envs);
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

describe("vòng tròn phát hành: Service 1 sinh token, guard Service 2 nhận (L7, AC-4.1)", () => {
  it("khoá SERVER vừa phát hành dùng được ngay ở /sdk/config; thu hồi rồi thì 401", async () => {
    const project = await throwawayProject("loop");
    const m = material(envOf(project, 0));

    /** AC-4.9: "QA Việt" ra `qaviet`, không `qa-viet` — token không có gạch ngang */
    expect(m.token).toMatch(/^udp_sk_qaviet_[0-9a-f]{64}$/);

    const keyId = await createKey(m);

    await request(app)
      .get("/sdk/config")
      .set("Authorization", `Bearer ${m.token}`)
      .expect(200);

    await del(keyId, m.environmentId).expect(200);

    /**
     * 401 NGAY sau khi thu hồi, không phải sau một TTL: guard tra database mỗi
     * request, và đó là lựa chọn đã ghi ở `sdk-key.guard.ts` — thu hồi là hành
     * động an ninh, người bấm nút đang tin rằng nó có hiệu lực ngay.
     */
    await request(app)
      .get("/sdk/config")
      .set("Authorization", `Bearer ${m.token}`)
      .expect(401);
  }, 120_000);

  it("khoá CLIENT phát hành được nhưng KHÔNG vào /sdk/config (ADR-03, AC-4.1)", async () => {
    const project = await throwawayProject("client");
    const m = material(envOf(project, 0), "CLIENT");

    expect(m.token).toMatch(/^udp_ck_qaviet_[0-9a-f]{64}$/);
    await createKey(m);

    /**
     * `/sdk/config` trả rule đầy đủ, nên §9 nói "CLIENT key không bao giờ chạm
     * endpoint này". Khoá CLIENT đi qua được là toàn bộ tập rule rời server xuống
     * trình duyệt (I11, T1).
     */
    await request(app)
      .get("/sdk/config")
      .set("Authorization", `Bearer ${m.token}`)
      .expect(401);
  }, 120_000);

  it("đuôi đã lưu là 6 ký tự CUỐI của token, và hash là sha256 của nó", async () => {
    const project = await throwawayProject("suffix");
    const m = material(envOf(project, 0));
    const keyId = await createKey(m);

    const row = await admin.sdkKey.findUniqueOrThrow({
      where: { id: keyId },
      select: { keyHash: true, keySuffix: true, label: true, keyType: true },
    });
    expect(row.keySuffix).toBe(m.token.slice(-SDK_KEY.displaySuffixLength));
    expect(row.keyHash).toBe(m.keyHash);
    expect(row.label).toBe("test-label");
    expect(row.keyType).toBe("SERVER");
  }, 120_000);
});

describe("tạo khoá idempotent theo key_hash (V4, R24, C-05)", () => {
  it("gửi lại CÙNG vật liệu ⇒ 200 created:false, không hàng mới, không audit mới", async () => {
    const project = await throwawayProject("retry");
    const m = material(envOf(project, 0));
    const keyId = await createKey(m);

    const again = await post(bodyOf(m)).expect(200);
    expect(again.body).toEqual({ key: { id: keyId }, created: false });

    expect(await activeCount(m.environmentId)).toBe(1);
    expect(await auditRows(keyId)).toHaveLength(1);
  }, 120_000);

  /**
   * AC-5.5 — lý do phép tra hash phải đứng TRƯỚC phép đếm quota (C-05).
   *
   * Environment có 19 khoá, lời gọi đầu tạo khoá thứ 20, rồi response mất và
   * Service 1 gửi lại cùng vật liệu. Nếu quota được đếm trước thì lần thử lại đọc
   * 20/20 và trả 422 `QUOTA_EXCEEDED` cho CHÍNH khoá vừa được tạo — người dùng
   * nhận lỗi trong khi khoá của họ đang nằm trong database, và plaintext thì mất.
   */
  it("env có 19 khoá: tạo rồi gửi lại ⇒ 200 created:false và vẫn đúng 20 khoá (AC-5.5)", async () => {
    const project = await throwawayProject("ac55");
    const environmentId = envOf(project, 0);
    await seedKeys(environmentId, SDK_KEY.maxActivePerEnvironment - 1);

    const m = material(environmentId);
    const keyId = await createKey(m);
    expect(await activeCount(environmentId)).toBe(
      SDK_KEY.maxActivePerEnvironment,
    );

    const again = await post(bodyOf(m)).expect(200);
    expect(again.body).toEqual({ key: { id: keyId }, created: false });
    expect(await activeCount(environmentId)).toBe(
      SDK_KEY.maxActivePerEnvironment,
    );
  }, 120_000);

  /**
   * Cùng hash mà khác environment, khác người tạo, hay khác loại ⇒ 409.
   *
   * Không có đường hợp lệ nào dẫn tới đây: token sinh từ 32 byte ngẫu nhiên, nên
   * hai lời gọi không bao giờ tình cờ cùng hash. Đó là dấu hiệu bên gọi đang gửi
   * lại vật liệu không thuộc về nó, và trả 200 kèm id khoá cũ là giao một khoá
   * của người khác.
   */
  it("cùng hash nhưng khác environment ⇒ 409 DUPLICATE_RESOURCE", async () => {
    const project = await throwawayProject("dup-env");
    const m = material(envOf(project, 0));
    await createKey(m);

    const res = await post({
      ...bodyOf(m),
      environmentId: envOf(A, 0),
    }).expect(409);
    expect(res.body.code).toBe("DUPLICATE_RESOURCE");
  }, 120_000);

  it("cùng hash nhưng khác loại khoá ⇒ 409 DUPLICATE_RESOURCE", async () => {
    const project = await throwawayProject("dup-type");
    const m = material(envOf(project, 0), "SERVER");
    await createKey(m);

    const res = await post({ ...bodyOf(m), keyType: "CLIENT" }).expect(409);
    expect(res.body.code).toBe("DUPLICATE_RESOURCE");
  }, 120_000);

  it("cùng hash nhưng khác người tạo ⇒ 409 DUPLICATE_RESOURCE", async () => {
    const project = await throwawayProject("dup-actor");
    const m = material(envOf(project, 0));
    await createKey(m);

    /**
     * Một id người dùng KHÔNG tồn tại là đủ, và cố tình: nhánh 409 dừng TRƯỚC mọi
     * lần ghi, nên không khoá ngoại nào bị chạm. Dựng thêm một user thật chỉ để
     * đọc id của nó là thêm một hàng phải dọn cho một phép so chuỗi.
     */
    const res = await internalCall(
      request(app).post("/internal/sdk-keys"),
      randomUUID(),
    )
      .send(bodyOf(m))
      .expect(409);
    expect(res.body.code).toBe("DUPLICATE_RESOURCE");
  }, 120_000);
});

describe("trần khoá mỗi environment, cưỡng chế dưới khoá (V5, AC-5.1)", () => {
  it("khoá thứ 21 ⇒ 422 QUOTA_EXCEEDED", async () => {
    const project = await throwawayProject("quota");
    const environmentId = envOf(project, 0);
    await seedKeys(environmentId, SDK_KEY.maxActivePerEnvironment);

    const res = await post(bodyOf(material(environmentId))).expect(422);
    expect(res.body.code).toBe("QUOTA_EXCEEDED");
    expect(await activeCount(environmentId)).toBe(
      SDK_KEY.maxActivePerEnvironment,
    );
  }, 120_000);

  it("khoá ĐÃ thu hồi không tính vào trần", async () => {
    const project = await throwawayProject("quota-revoked");
    const environmentId = envOf(project, 0);
    await seedKeys(environmentId, SDK_KEY.maxActivePerEnvironment);

    const victim = await admin.sdkKey.findFirstOrThrow({
      where: { environmentId },
      select: { id: true },
    });
    await del(victim.id, environmentId).expect(200);

    await post(bodyOf(material(environmentId))).expect(201);
    expect(await activeCount(environmentId)).toBe(
      SDK_KEY.maxActivePerEnvironment,
    );
  }, 120_000);

  /**
   * Ba lời gọi đồng thời vào environment còn ĐÚNG MỘT chỗ.
   *
   * Đây là hình dạng tối giản mà một phép đếm NGOÀI khoá luôn để lọt: cả ba đọc
   * 19, cả ba thấy còn chỗ, cả ba ghi — và environment kết thúc với 22 khoá sống.
   * Vì phép đếm nằm dưới `pg_advisory_xact_lock` theo environment, ba transaction
   * bị tuần tự hoá và hai bên sau đọc được đúng 20.
   *
   * Ba chứ không 25 để kết quả TẤT ĐỊNH: ba transaction xếp hàng xong trong hạn
   * `createTransaction.maxWait`, nên không ca nào rơi vào 503 vì hết khe pool. Ca
   * 25 lời gọi (AC-5.1 nguyên văn) ở test dưới, khẳng định theo BẤT BIẾN.
   */
  it("3 lời tạo đồng thời vào chỗ cuối ⇒ đúng một 201, hai 422", async () => {
    const project = await throwawayProject("race3");
    const environmentId = envOf(project, 0);
    await seedKeys(environmentId, SDK_KEY.maxActivePerEnvironment - 1);

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        post(bodyOf(material(environmentId))).then((r) => r.status),
      ),
    );

    expect(results.sort((a, b) => a - b)).toEqual([201, 422, 422]);
    expect(await activeCount(environmentId)).toBe(
      SDK_KEY.maxActivePerEnvironment,
    );
  }, 120_000);

  /**
   * AC-5.1 — 25 lời gọi đồng thời vào environment TRỐNG, khẳng định theo bất biến.
   *
   * Vì sao KHÔNG khẳng định "đúng 20 phản hồi 201", và cũng không khẳng định "có
   * ít nhất một 422" — đã ĐO, không phải phòng xa: 25 transaction bị advisory lock
   * tuần tự hoá, mỗi cái vài lượt đi về tới database ở Singapore, và pool của
   * Service 2 có 5 khe. Phần đuôi hết `createTransaction.maxWait` khi còn đang CHỜ
   * một khe, tức nó chưa bao giờ chạy tới phép đếm quota — nên nó nhận 503 chứ
   * không nhận 422. Chính vì thế AC-5.1 liệt kê 503 là phản hồi hợp lệ, và một
   * khẳng định "phải có 422" là khẳng định về lịch của hệ điều hành, không về code.
   *
   * Thứ test này canh, và là thứ KHÔNG được phép xảy ra:
   *
   *   - một phản hồi ngoài ba mã đó;
   *   - số khoá sống vượt trần (đây là bất biến: một phép đếm NGOÀI khoá cho tới
   *     25 khoá sống, và test đỏ ngay);
   *   - lệch giữa "số hàng đã ghi" và "số bên gọi được báo là đã ghi" — theo cả
   *     hai chiều.
   *
   * Và một chốt chống RỖNG: không phải mọi lời gọi đều 503. Thiếu nó thì một cơn
   * hết khe pool toàn phần làm test xanh mà chưa kiểm gì.
   */
  it("25 lời tạo đồng thời: không vượt trần, và số khoá sống = số 201 (AC-5.1)", async () => {
    const project = await throwawayProject("race25");
    const environmentId = envOf(project, 0);

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        post(bodyOf(material(environmentId))).then((r) => r.status),
      ),
    );

    for (const status of results) {
      expect([201, 422, 503]).toContain(status);
    }
    const created = results.filter((s) => s === 201).length;
    expect(await activeCount(environmentId)).toBe(created);
    expect(created).toBeLessThanOrEqual(SDK_KEY.maxActivePerEnvironment);
    expect(created).toBeGreaterThan(0);
  }, 180_000);
});

describe("thu hồi đi qua outbox, đúng một lần (L1, AC-4.6)", () => {
  /**
   * Ba điều kiện của L1 trên MỘT environment, đo qua HAI lần thu hồi.
   *
   * Hai lần chứ không một, và lý do là một phát hiện khi chạy: environment của một
   * project vừa tạo có `config_hash` là chuỗi RỖNG (mặc định của cột — chưa lần
   * ghi cấu hình nào tính nó). Lần thu hồi đầu vì thế tính hash THẬT lần đầu tiên,
   * nên hash "đổi" — đúng hành vi, nhưng không phải điều L1 nói. Câu L1 nói là:
   * một lần thu hồi KHÔNG đổi nội dung cấu hình, nên hash sau bằng hash trước.
   * Phép đo đúng vì thế phải bắt đầu từ một environment đã có hash đúng, và lần
   * thu hồi thứ nhất chính là thứ dựng nên trạng thái ấy.
   */
  it("thu hồi ⇒ version tiến 1, MỘT dòng sdkkey.revoked mỗi lần, config_hash KHÔNG đổi", async () => {
    const project = await throwawayProject("revoke-wire");
    const environmentId = envOf(project, 0);
    const first = await createKey(material(environmentId));
    const second = await createKey(material(environmentId));

    /** Lần thu hồi thứ nhất: tính `config_hash` của environment lần đầu tiên */
    await del(first, environmentId).expect(200);

    const before = await stateOf(environmentId);
    expect(before.configHash).not.toBe("");

    const res = await del(second, environmentId).expect(200);
    expect(res.body.changed).toBe(true);

    const after = await stateOf(environmentId);
    expect(after.configVersion).toBe(before.configVersion + 1);
    /**
     * Hash KHÔNG đổi là điều kiện của L1, không phải một chi tiết: chính sự trùng
     * nhau ấy là tín hiệu hub SSE dùng để gửi `flag_changed` rỗng thay cho một
     * snapshot đầy đủ tới mọi stream của environment.
     */
    expect(after.configHash).toBe(before.configHash);

    /** Mỗi lần thu hồi đúng MỘT dòng, và không dòng nào mang gì ngoài id khoá */
    expect(await outboxOf(environmentId)).toEqual([
      { changeType: "sdkkey.revoked", payload: { sdkKeyId: first } },
      { changeType: "sdkkey.revoked", payload: { sdkKeyId: second } },
    ]);
  }, 120_000);

  it("thu hồi lần hai ⇒ 200 changed:false, mốc CŨ, vẫn 1 audit và 1 dòng outbox", async () => {
    const project = await throwawayProject("revoke-twice");
    const environmentId = envOf(project, 0);
    const keyId = await createKey(material(environmentId));

    const first = await del(keyId, environmentId).expect(200);
    const version = (await stateOf(environmentId)).configVersion;

    const second = await del(keyId, environmentId).expect(200);
    expect(second.body.changed).toBe(false);
    expect(second.body.key.revokedAt).toBe(first.body.key.revokedAt);

    /** Lần thứ hai không tăng version: nó không đi vào `writeWithOutbox` nào */
    expect((await stateOf(environmentId)).configVersion).toBe(version);
    expect(await outboxOf(environmentId)).toHaveLength(1);
    expect(
      (await auditRows(keyId)).filter((r) => r.action === "sdkkey.revoke"),
    ).toHaveLength(1);
  }, 120_000);

  /**
   * Đua thật: hai lời thu hồi cùng lúc, cả hai thấy `revoked_at IS NULL`.
   *
   * Cả hai vào được `mutate` (chúng xếp hàng sau khoá hàng environment của bước
   * 1), nên bên thua PHẢI lùi bằng sentinel. Không lùi thì nó commit một
   * `config_version` thứ hai, một dòng outbox thứ hai và một hàng audit thứ hai
   * cho một thay đổi không xảy ra.
   */
  it("hai lời thu hồi đồng thời ⇒ cả hai 200, đúng 1 audit và 1 dòng outbox", async () => {
    const project = await throwawayProject("revoke-race");
    const environmentId = envOf(project, 0);
    const keyId = await createKey(material(environmentId));
    const before = await stateOf(environmentId);

    const results = await Promise.all([
      del(keyId, environmentId),
      del(keyId, environmentId),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.filter((r) => r.body.changed === true)).toHaveLength(1);
    /** Cùng một mốc cho cả hai: "đã thu hồi" là một trạng thái, không phải hai */
    expect(results[0].body.key.revokedAt).toBe(results[1].body.key.revokedAt);

    expect((await stateOf(environmentId)).configVersion).toBe(
      before.configVersion + 1,
    );
    expect(await outboxOf(environmentId)).toHaveLength(1);
    expect(
      (await auditRows(keyId)).filter((r) => r.action === "sdkkey.revoke"),
    ).toHaveLength(1);
  }, 120_000);
});

describe("audit trong transaction, không hash không plaintext (I40, R04)", () => {
  it("tạo và thu hồi ghi đúng hai hàng, mang đuôi và metadata", async () => {
    const project = await throwawayProject("audit");
    const environmentId = envOf(project, 0);
    const m = material(environmentId, "CLIENT", "khoá của QA");
    const keyId = await createKey(m);
    await del(keyId, environmentId).expect(200);

    const rows = await auditRows(keyId);
    expect(rows.map((r) => r.action)).toEqual([
      "sdkkey.create",
      "sdkkey.revoke",
    ]);
    for (const row of rows) {
      expect(row.actorUserId).toBe(ownerId);
      expect(row.environmentId).toBe(environmentId);
      expect(row.ipAddress).toBe(IP);
      expect(row.userAgent).toBe(UA);
    }
    expect(rows[0]?.after).toEqual({
      keyType: "CLIENT",
      keySuffix: m.keySuffix,
      label: "khoá của QA",
    });
    expect(rows[1]?.before).toMatchObject({ revokedAt: null });
    expect(rows[1]?.after).toMatchObject({ keySuffix: m.keySuffix });

    /**
     * Hash KHÔNG có trong audit — và đây không phải chuyện thẩm mỹ: `audit_logs`
     * là bảng append-only giữ vĩnh viễn mà VIEWER đọc được qua
     * `GET /projects/:id/audit`, còn `key_hash` là thứ duy nhất database dùng để
     * tra khoá. Chép nó sang một bảng nhiều người đọc hơn là hạ mức bảo vệ của
     * chính cột đó mà không được gì.
     */
    expect(JSON.stringify(rows)).not.toContain(m.keyHash);
    expect(JSON.stringify(rows)).not.toContain(m.token);
  }, 120_000);
});

describe("cô lập environment: route nội bộ không tin id trần (R05, I14)", () => {
  it("thu hồi khoá của env khác bằng environmentId của mình ⇒ 404, không đổi gì", async () => {
    const keyId = await createKey(material(envOf(A, 0)));
    const before = await stateOf(envOf(A, 1));

    /** Cùng project, environment khác — ô khó nhất của ma trận id chéo */
    await del(keyId, envOf(A, 1)).expect(404);
    /** Project khác hẳn */
    await del(keyId, envOf(B, 0)).expect(404);

    const row = await admin.sdkKey.findUniqueOrThrow({
      where: { id: keyId },
      select: { revokedAt: true },
    });
    expect(row.revokedAt).toBeNull();
    expect(await stateOf(envOf(A, 1))).toEqual(before);
    expect(
      (await auditRows(keyId)).filter((r) => r.action === "sdkkey.revoke"),
    ).toHaveLength(0);
  }, 120_000);

  it("environment không tồn tại ⇒ 404 cho cả tạo và thu hồi", async () => {
    const ghost = randomUUID();
    await post(bodyOf(material(ghost))).expect(404);
    await del(randomUUID(), ghost).expect(404);
  }, 120_000);
});

describe("hợp đồng thân và query strict (R36, §3.2)", () => {
  const cases: [string, object, number][] = [
    ["trường lạ", { extra: 1 }, 400],
    ["thiếu keyHash", { keyHash: undefined }, 400],
    ["hash 63 ký tự", { keyHash: "a".repeat(63) }, 400],
    ["hash chữ HOA", { keyHash: "A".repeat(64) }, 400],
    ["đuôi 5 ký tự", { keySuffix: "abcde" }, 400],
    ["đuôi không phải hex", { keySuffix: "zzzzzz" }, 400],
    ["loại khoá lạ", { keyType: "ADMIN" }, 400],
    ["label rỗng", { label: "" }, 400],
    ["label quá dài", { label: "x".repeat(SDK_KEY.labelMaxLength + 1) }, 400],
    ["environmentId không phải uuid", { environmentId: "khong-uuid" }, 400],
  ];

  it.each(cases)(
    "POST %s ⇒ %i",
    async (_name, patch, status) => {
      const body: Record<string, unknown> = {
        ...bodyOf(material(envOf(A, 0))),
        ...patch,
      };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete body[key];
      }
      await post(body).expect(status);
    },
    60_000,
  );

  it("DELETE thiếu environmentId ⇒ 400, không 404", async () => {
    await call(
      request(app).delete(`/internal/sdk-keys/${randomUUID()}`),
    ).expect(400);
  });

  it("DELETE có query lạ ⇒ 400", async () => {
    await call(
      request(app).delete(
        `/internal/sdk-keys/${randomUUID()}?environmentId=${envOf(A, 0)}&hack=1`,
      ),
    ).expect(400);
  });

  it("id không phải UUID ⇒ 400, không 500", async () => {
    await call(
      request(app).delete(
        `/internal/sdk-keys/khong-uuid?environmentId=${envOf(A, 0)}`,
      ),
    ).expect(400);
  });

  it("thiếu bí mật nội bộ ⇒ 401 cho cả hai route", async () => {
    await request(app)
      .post("/internal/sdk-keys")
      .send(bodyOf(material(envOf(A, 0))))
      .expect(401);
    await request(app)
      .delete(`/internal/sdk-keys/${randomUUID()}?environmentId=${envOf(A, 0)}`)
      .expect(401);
  });

  it("thiếu X-Udp-Actor-Id ⇒ 400 (hàng audit phải nói ai làm)", async () => {
    await request(app)
      .post("/internal/sdk-keys")
      .set(INTERNAL_SECRET_HEADER, env.INTERNAL_SERVICE_SECRET)
      .send(bodyOf(material(envOf(A, 0))))
      .expect(400);
  });
});

describe("INV-23.3 ở biên trong: Service 2 chưa từng thấy plaintext", () => {
  /**
   * Phép quét toàn database sau khi file này đã phát hành, thu hồi và đua hàng
   * chục khoá.
   *
   * Nó khẳng định điều mà chỉ hình dạng của hợp đồng mới cho phép: thân của
   * `POST /internal/sdk-keys` không có trường nào mang token, nên không có đường
   * nào để plaintext vào bảng nào của Service 2 — kể cả `config_change_log` (giữ
   * 7 ngày và đẩy xuống MỌI stream SSE của environment) hay `audit_logs`.
   *
   * Quét theo MẪU chung, không theo một token cụ thể: như vậy nó bắt cả khoá do
   * một đường khác làm rò, không chỉ khoá của ca test cuối.
   */
  it("không bảng nào của database chứa một chuỗi khớp mẫu plaintext", async () => {
    const project = await throwawayProject("scan");
    const m = material(envOf(project, 0));
    const keyId = await createKey(m);
    await del(keyId, envOf(project, 0)).expect(200);

    expect(await scanForSecret(admin, m.token)).toEqual([]);
    expect(
      await scanForSecret(admin, SDK_KEY_PLAINTEXT_PATTERN.source),
    ).toEqual([]);
  }, 180_000);
});

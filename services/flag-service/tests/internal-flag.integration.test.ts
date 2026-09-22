import { randomUUID } from "node:crypto";
import {
  ACTOR_HEADER,
  CLIENT_IP_HEADER,
  CLIENT_UA_HEADER,
  env,
} from "@udp/config";
import { createPrismaClient } from "@udp/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { stableOwner } from "@udp/test-support";

/**
 * `/internal/flags` qua HTTP thật.
 *
 * Trọng tâm là những tính chất mà một test "tạo được flag" không nói gì tới:
 * lời gọi thiếu bí mật bị chặn, tạo flag chạm MỌI environment, và mỗi lần ghi
 * đều đẩy `config_version` cùng `config_hash` theo đúng kỷ luật ADR-05.
 */

const app = createApp();
const SECRET = env.INTERNAL_SERVICE_SECRET;

/**
 * Fixture dựng bằng quyền OWNER.
 *
 * `udp_s2` không có quyền tạo `projects` hay `environments` (§1.2) — nó chỉ
 * được UPDATE hai cột của `environments`. Đó là thiết kế, không phải trở ngại:
 * test phải dựng bối cảnh bằng đúng vai có quyền làm việc đó.
 */
const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_flagtest_${randomUUID()}`,
});

let projectId: string;
let envIds: string[];
let actorId: string;

beforeAll(async () => {
  const owner = await stableOwner(admin);
  actorId = owner.id;

  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId: owner.id,
      name: `flagtest-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-flagtest-${suffix}-dev` },
          {
            name: "staging",
            rank: 1,
            k8sNamespace: `udp-flagtest-${suffix}-stg`,
          },
          {
            name: "prod",
            rank: 2,
            k8sNamespace: `udp-flagtest-${suffix}-prod`,
          },
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
});

afterAll(async () => {
  /**
   * Tat luat o dung mot dong: TypeScript coi bien nay la da gan chac chan vi
   * `beforeAll` co gan no, nhung neu chinh `beforeAll` nem thi `afterAll` van
   * chay voi bien chua gan — va bo phep kiem nay se che mat loi that bang mot
   * TypeError trong buoc don dep.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (projectId !== undefined) {
    await admin.configChangeLog.deleteMany({
      where: { environmentId: { in: envIds } },
    });
    await admin.auditLog.deleteMany({ where: { projectId: projectId } });
    await admin.project.delete({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

const post = (body: object): request.Test =>
  request(app)
    .post("/internal/flags")
    .set("X-Internal-Secret", SECRET)
    .set(ACTOR_HEADER, actorId)
    .send(body);

const newFlag = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  projectId,
  key: `probe-${randomUUID().slice(0, 8)}`,
  flagType: "BOOLEAN",
  ...over,
});

describe("guard của /internal/*", () => {
  it("thiếu bí mật thì 401", async () => {
    await request(app).post("/internal/flags").send(newFlag()).expect(401);
  });

  it("sai bí mật thì 401, và thông điệp KHÔNG phân biệt với thiếu", async () => {
    const wrong = await request(app)
      .post("/internal/flags")
      .set("X-Internal-Secret", "x".repeat(40))
      .send(newFlag())
      .expect(401);
    const missing = await request(app)
      .post("/internal/flags")
      .send(newFlag())
      .expect(401);

    // Phân biệt hai ca là nói cho người dò biết họ đã đi đúng nửa đường.
    expect(wrong.body.detail ?? wrong.body.title).toBe(
      missing.body.detail ?? missing.body.title,
    );
  });
});

describe("tạo flag", () => {
  it("sinh flag DRAFT, hai variant on/off, và hàng env config cho MỌI environment", async () => {
    const res = await post(newFlag()).expect(201);

    expect(res.body.flag.lifecycleStatus).toBe("DRAFT");
    expect(
      res.body.flag.variants.map((v: { key: string }) => v.key).sort(),
    ).toEqual(["off", "on"]);
    expect(res.body.flag.defaultVariantId).not.toBeNull();

    const configs = await admin.flagEnvConfig.findMany({
      where: { flagId: res.body.flag.id as string },
      select: { environmentId: true, isEnabled: true },
    });

    // Thiếu hàng ở một environment nào đó là dạng hỏng khó hiểu nhất: Portal
    // hiện flag, còn SDK ở chính environment đó trả FLAG_NOT_FOUND.
    expect(configs).toHaveLength(envIds.length);
    expect(configs.every((c) => !c.isEnabled)).toBe(true);
  });

  it("đẩy config_version và ghi config_hash cho MỌI environment", async () => {
    const before = await admin.environment.findMany({
      where: { id: { in: envIds } },
      select: { id: true, configVersion: true },
      orderBy: { id: "asc" },
    });

    await post(newFlag()).expect(201);

    const after = await admin.environment.findMany({
      where: { id: { in: envIds } },
      select: { id: true, configVersion: true, configHash: true },
      orderBy: { id: "asc" },
    });

    for (const [i, row] of after.entries()) {
      expect(row.configVersion).toBe((before[i]?.configVersion ?? -1) + 1);
      // Trước lần ghi đầu tiên cột này là chuỗi rỗng theo DEFAULT của schema;
      // sau đó nó phải là SHA-256 hex đủ 64 ký tự.
      expect(row.configHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("ghi actor từ header vào outbox", async () => {
    const res = await request(app)
      .post("/internal/flags")
      .set("X-Internal-Secret", SECRET)
      .set(ACTOR_HEADER, actorId)
      .send(newFlag())
      .expect(201);

    expect(res.body.flag.id).toBeTruthy();

    /**
     * Tìm dòng outbox bằng `(environmentId, configVersion)`, KHÔNG bằng
     * `orderBy: createdAt desc`.
     *
     * `created_at` khai `@default(now())` nhưng Prisma sinh giá trị đó ở phía
     * CLIENT và gửi xuống như bind parameter — `DEFAULT CURRENT_TIMESTAMP` của
     * cột không bao giờ chạy. Nên "mới nhất" theo cột đó là "theo đồng hồ của
     * tiến trình đã ghi", mà nhiều replica thì nhiều đồng hồ. Cặp
     * `(environmentId, configVersion)` là `@@unique`, nên nó chỉ đúng MỘT dòng
     * và không phụ thuộc đồng hồ của ai cả.
     */
    const envId = envIds[0]!;
    const current = await admin.environment.findUniqueOrThrow({
      where: { id: envId },
      select: { configVersion: true },
    });

    const log = await admin.configChangeLog.findUniqueOrThrow({
      where: {
        environmentId_configVersion: {
          environmentId: envId,
          configVersion: current.configVersion,
        },
      },
      select: { actorUserId: true, changeType: true },
    });

    expect(log.changeType).toBe("flag.created");
    expect(log.actorUserId).toBe(actorId);
  });

  it("trùng key trong cùng project thì 409 DUPLICATE_RESOURCE", async () => {
    const key = `dup-${randomUUID().slice(0, 8)}`;
    await post(newFlag({ key })).expect(201);

    const res = await post(newFlag({ key })).expect(409);
    expect(res.body.code).toBe("DUPLICATE_RESOURCE");
  });

  it("flag không phải BOOLEAN mà thiếu variants thì 400", async () => {
    await post(newFlag({ flagType: "STRING" })).expect(400);
  });
});

describe("sửa flag — optimistic lock", () => {
  it("mốc thời gian cũ thì 409 OPTIMISTIC_LOCK, mốc đúng thì 200", async () => {
    const created = await post(newFlag()).expect(201);
    const flagId = created.body.flag.id as string;
    const stale = new Date(Date.now() - 60_000).toISOString();

    const conflict = await request(app)
      .patch(`/internal/flags/${flagId}`)
      .set("X-Internal-Secret", SECRET)
      .set(ACTOR_HEADER, actorId)
      .send({ lastKnownUpdatedAt: stale, description: "sửa muộn" })
      .expect(409);
    expect(conflict.body.code).toBe("OPTIMISTIC_LOCK");
    // §8.4: kèm bản mới nhất để hiển thị diff — trước đây nó mất dọc đường
    expect(conflict.body.current.id).toBe(flagId);

    const fresh = await admin.featureFlag.findUniqueOrThrow({
      where: { id: flagId },
      select: { updatedAt: true },
    });

    await request(app)
      .patch(`/internal/flags/${flagId}`)
      .set("X-Internal-Secret", SECRET)
      .set(ACTOR_HEADER, actorId)
      .send({
        lastKnownUpdatedAt: fresh.updatedAt.toISOString(),
        description: "sửa đúng lúc",
      })
      .expect(200);
  });

  it("id không phải UUID thì 400, không phải 500", async () => {
    await request(app)
      .patch("/internal/flags/khong-phai-uuid")
      .set("X-Internal-Secret", SECRET)
      .set(ACTOR_HEADER, actorId)
      .send({ lastKnownUpdatedAt: new Date().toISOString() })
      .expect(400);
  });
});

describe("giá trị variant phải khớp kiểu flag (§2.2)", () => {
  it("flag STRING mang variant giá trị số ⇒ 400, không phải một lỗi TYPE_MISMATCH ở SDK sau này", async () => {
    await post(
      newFlag({
        flagType: "STRING",
        variants: [
          { key: "a", value: "x" },
          { key: "b", value: 42 },
        ],
      }),
    ).expect(400);
  });

  it("flag JSON mang variant là mảng ⇒ 400 — JSON là object (resolveObjectValue)", async () => {
    await post(
      newFlag({
        flagType: "JSON",
        variants: [
          { key: "a", value: { theme: "dark" } },
          { key: "b", value: ["không", "phải", "object"] },
        ],
      }),
    ).expect(400);
  });

  it("flag NUMBER mang giá trị thập phân ⇒ 201, và config_hash băm được (RFC 8785)", async () => {
    /**
     * Trước v4.1 đây là 500: `canonicalJson` từ chối mọi số không nguyên, và nó chạy
     * BÊN TRONG transaction ghi (bước 3 của ADR-05) — nên không tạo được flag giá
     * hoặc tỉ lệ nào. 201 ở đây chứng minh cả chuỗi: validate, ghi, băm, outbox.
     */
    await post(
      newFlag({
        flagType: "NUMBER",
        variants: [
          { key: "low", value: 0.15 },
          { key: "high", value: 0.3 },
        ],
      }),
    ).expect(201);

    const rows = await admin.environment.findMany({
      where: { id: { in: envIds } },
      select: { configHash: true },
    });
    for (const row of rows) expect(row.configHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("[v4.5] audit ghi TRONG transaction của S2", () => {
  const auditsOf = (targetId: string) =>
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
    });

  it("tạo flag ⇒ đúng MỘT hàng audit mang actor, IP và UA mà S1 chuyển tiếp; IP sai dạng bị bỏ, thay đổi vẫn commit", async () => {
    const res = await post(newFlag())
      .set(CLIENT_IP_HEADER, "203.0.113.7")
      .set(CLIENT_UA_HEADER, "portal-test")
      .expect(201);
    const audits = await auditsOf(res.body.flag.id as string);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "flag.create",
      actorUserId: actorId,
      ipAddress: "203.0.113.7",
      userAgent: "portal-test",
    });

    const bad = await post(newFlag()).set(CLIENT_IP_HEADER, "cafe").expect(201);
    const [row] = await auditsOf(bad.body.flag.id as string);
    expect(row?.ipAddress).toBeNull();
  });

  it("thiếu actor ⇒ 400 và không có thay đổi nào", async () => {
    const body = newFlag();
    await request(app)
      .post("/internal/flags")
      .set("X-Internal-Secret", SECRET)
      .send(body)
      .expect(400);
    expect(
      await admin.featureFlag.count({
        where: { projectId, key: body["key"] as string },
      }),
    ).toBe(0);
  });

  it("sửa bị lùi (409 OPTIMISTIC_LOCK) ⇒ KHÔNG có hàng audit; sửa được ⇒ before/after đúng trường đổi", async () => {
    const created = await post(newFlag()).expect(201);
    const id = created.body.flag.id as string;
    const patch = (body: object) =>
      request(app)
        .patch(`/internal/flags/${id}`)
        .set("X-Internal-Secret", SECRET)
        .set(ACTOR_HEADER, actorId)
        .send(body);

    await patch({
      lastKnownUpdatedAt: new Date(0).toISOString(),
      description: "cũ",
    }).expect(409);
    expect(
      (await auditsOf(id)).filter((a) => a.action === "flag.update"),
    ).toHaveLength(0);

    await patch({
      lastKnownUpdatedAt: created.body.flag.updatedAt as string,
      description: "mô tả mới",
    }).expect(200);
    const updates = (await auditsOf(id)).filter(
      (a) => a.action === "flag.update",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.before).toMatchObject({ description: null });
    expect(updates[0]?.after).toMatchObject({ description: "mô tả mới" });
  });

  it("409 OPTIMISTIC_LOCK mang `current.updatedAt` là mốc ISO thật — redact không nuốt Date", async () => {
    const created = await post(newFlag()).expect(201);
    const res = await request(app)
      .patch(`/internal/flags/${created.body.flag.id as string}`)
      .set("X-Internal-Secret", SECRET)
      .set(ACTOR_HEADER, actorId)
      .send({ lastKnownUpdatedAt: new Date(0).toISOString(), description: "x" })
      .expect(409);
    expect(res.body.current.updatedAt).toBe(created.body.flag.updatedAt);
  });
});

describe("[v4.5] flag đang rollout — không rời ACTIVE, không đổi stickiness", () => {
  it("ARCHIVED hoặc đổi stickiness khi còn session sống ⇒ 409 ROLLOUT_IN_PROGRESS + resourceId; hết session ⇒ được", async () => {
    const created = await post(newFlag()).expect(201);
    const flagId = created.body.flag.id as string;
    await admin.featureFlag.update({
      where: { id: flagId },
      data: { lifecycleStatus: "ACTIVE" },
    });
    const config = await admin.flagEnvConfig.findFirstOrThrow({
      where: { flagId },
      select: { id: true, environmentId: true },
    });
    const session = await admin.rolloutSession.create({
      data: {
        projectId,
        environmentId: config.environmentId,
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
    const stamp = async () =>
      (
        await admin.featureFlag.findUniqueOrThrow({
          where: { id: flagId },
          select: { updatedAt: true },
        })
      ).updatedAt.toISOString();
    const patch = async (body: object) =>
      request(app)
        .patch(`/internal/flags/${flagId}`)
        .set("X-Internal-Secret", SECRET)
        .set(ACTOR_HEADER, actorId)
        .send({ lastKnownUpdatedAt: await stamp(), ...body });

    for (const body of [
      { lifecycleStatus: "ARCHIVED" },
      { stickinessAttribute: "userId" },
    ]) {
      const res = await patch(body);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: "ROLLOUT_IN_PROGRESS",
        resourceId: session.id,
      });
    }
    await patch({ description: "vẫn sửa mô tả được" }).then((r) =>
      expect(r.status).toBe(200),
    );

    await admin.rolloutSession.update({
      where: { id: session.id },
      data: { status: "DONE" },
    });
    expect((await patch({ lifecycleStatus: "ARCHIVED" })).status).toBe(200);
  });
});

describe("[v4.5] máy trạng thái vòng đời (§6.7) và PATCH rỗng", () => {
  const patchOf = (id: string) => async (body: object) => {
    const { updatedAt } = await admin.featureFlag.findUniqueOrThrow({
      where: { id },
      select: { updatedAt: true },
    });
    return request(app)
      .patch(`/internal/flags/${id}`)
      .set("X-Internal-Secret", SECRET)
      .set(ACTOR_HEADER, actorId)
      .send({ lastKnownUpdatedAt: updatedAt.toISOString(), ...body });
  };

  it("DRAFT → ARCHIVED (bỏ dở) và ARCHIVED ⇄ ACTIVE được; về DRAFT ⇒ 422, không đổi gì", async () => {
    const created = await post(newFlag()).expect(201);
    const id = created.body.flag.id as string;
    const patch = patchOf(id);
    expect((await patch({ lifecycleStatus: "ARCHIVED" })).status).toBe(200);
    expect((await patch({ lifecycleStatus: "ACTIVE" })).status).toBe(200);
    const back = await patch({ lifecycleStatus: "DRAFT" });
    expect(back.status).toBe(422);
    expect(back.body.detail).toMatch(/ACTIVE → DRAFT/);
    const { lifecycleStatus } = await admin.featureFlag.findUniqueOrThrow({
      where: { id },
      select: { lifecycleStatus: true },
    });
    expect(lifecycleStatus).toBe("ACTIVE");
  });

  it("PATCH chỉ có lastKnownUpdatedAt ⇒ 400, không tốn version", async () => {
    const created = await post(newFlag()).expect(201);
    const versionsOf = async () =>
      (
        await admin.environment.findMany({
          where: { projectId },
          select: { configVersion: true },
          orderBy: { rank: "asc" },
        })
      ).map((e) => e.configVersion);
    const before = await versionsOf();
    expect((await patchOf(created.body.flag.id as string)({})).status).toBe(
      400,
    );
    expect(await versionsOf()).toEqual(before);
  });
});

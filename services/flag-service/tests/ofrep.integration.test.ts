import { randomUUID } from "node:crypto";
import { env, INTERNAL_SECRET_HEADER } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  createActiveFlag,
  internalCall,
  newSdkKeyToken,
  sdkKeyData,
  stableOwner,
} from "@udp/test-support";

/**
 * OFREP (§6.2, ADR-03) và Flag Evaluation Tester (§10.12) qua HTTP thật [v4.6].
 *
 * Điều mà một test "trả đúng giá trị" không nói: không gì về rule rời server tới
 * trình duyệt (I11), khoá của env nào chỉ thấy cấu hình của env đó (I14), ETag
 * không bao giờ xác nhận kết quả của một context khác, lỗi đi đúng hình openapi,
 * và flag DRAFT không tồn tại với SDK (§6.7) nhưng thử được ở Tester.
 */

const app = createApp();
const SECRET = env.INTERNAL_SERVICE_SECRET;
const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_ofreptest_${randomUUID()}`,
});

const CLIENT_DEV = newSdkKeyToken("CLIENT");
const CLIENT_PROD = newSdkKeyToken("CLIENT");
const SERVER_DEV = newSdkKeyToken("SERVER");
const SECRET_USER = `u-secret-${randomUUID().slice(0, 8)}`;

let actorId: string;
let projectId: string | undefined;
let envIds: string[] = [];
let devEnv: string;
let betaKey: string;
let betaId: string;
let draftId: string;
let draftKey: string;
let archivedKey: string;

const internal = (req: request.Test): request.Test =>
  internalCall(req, actorId);

const bulk = (key: string, body: unknown): request.Test =>
  request(app)
    .post("/ofrep/v1/evaluate/flags")
    .set("Authorization", `Bearer ${key}`)
    .send(body as object);

const single = (key: string, flag: string, body: unknown): request.Test =>
  request(app)
    .post(`/ofrep/v1/evaluate/flags/${flag}`)
    .set("Authorization", `Bearer ${key}`)
    .send(body as object);

async function configOf(flagId: string, envId: string): Promise<string> {
  const c = await admin.flagEnvConfig.findFirstOrThrow({
    where: { flagId, environmentId: envId },
    select: { id: true },
  });
  return c.id;
}

beforeAll(async () => {
  actorId = (await stableOwner(admin)).id;
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId: actorId,
      name: `ofrep-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-ofrep-${suffix}-dev` },
          { name: "prod", rank: 1, k8sNamespace: `udp-ofrep-${suffix}-prd` },
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
  devEnv = envIds[0] as string;
  const prodEnv = envIds[1] as string;

  await admin.sdkKey.createMany({
    data: [
      { token: CLIENT_DEV, environmentId: devEnv, keyType: "CLIENT" as const },
      {
        token: CLIENT_PROD,
        environmentId: prodEnv,
        keyType: "CLIENT" as const,
      },
      { token: SERVER_DEV, environmentId: devEnv, keyType: "SERVER" as const },
    ].map((k) =>
      sdkKeyData({ ...k, createdById: actorId, label: "ofrep test" }),
    ),
  });

  // beta: bật ở dev, rule USER_BASED cho SECRET_USER ⇒ on; prod để tắt
  betaKey = `beta-${suffix}`;
  const beta = await createActiveFlag(app, actorId, {
    projectId,
    key: betaKey,
    flagType: "BOOLEAN",
    defaultVariantKey: "off",
  });
  betaId = beta.body.flag.id as string;
  const on = (beta.body.flag.variants as { id: string; key: string }[]).find(
    (v) => v.key === "on",
  )?.id;
  const devConfig = await configOf(betaId, devEnv);
  await internal(request(app).patch(`/internal/flag-envs/${devConfig}`))
    .send({ isEnabled: true })
    .expect(200);
  const stamp = (
    await admin.flagEnvConfig.findUniqueOrThrow({
      where: { id: devConfig },
      select: { updatedAt: true },
    })
  ).updatedAt.toISOString();
  await internal(request(app).put(`/internal/flag-envs/${devConfig}/rules`))
    .send({
      lastKnownUpdatedAt: stamp,
      rules: [
        {
          ruleType: "USER_BASED",
          condition: { userIds: [SECRET_USER] },
          priority: 0,
          serve: { kind: "variant", variantId: on },
        },
      ],
    })
    .expect(200);

  // draft: tạo mà không kích hoạt, bật ở dev — SDK vẫn không thấy (§6.7)
  draftKey = `draft-${suffix}`;
  const draft = await internal(request(app).post("/internal/flags"))
    .send({ projectId, key: draftKey, flagType: "BOOLEAN" })
    .expect(201);
  draftId = draft.body.flag.id as string;
  await internal(
    request(app).patch(
      `/internal/flag-envs/${await configOf(draftId, devEnv)}`,
    ),
  )
    .send({ isEnabled: true })
    .expect(200);

  // archived: kích hoạt rồi lưu trữ ⇒ bia mộ
  archivedKey = `old-${suffix}`;
  const old = await createActiveFlag(app, actorId, {
    projectId,
    key: archivedKey,
    flagType: "BOOLEAN",
  });
  await internal(
    request(app).patch(`/internal/flags/${old.body.flag.id as string}`),
  )
    .send({
      lastKnownUpdatedAt: old.body.flag.updatedAt as string,
      lifecycleStatus: "ARCHIVED",
    })
    .expect(200);
}, 60_000);

afterAll(async () => {
  if (projectId !== undefined) {
    await admin.configChangeLog.deleteMany({
      where: { environmentId: { in: envIds } },
    });
    await admin.auditLog.deleteMany({ where: { projectId } });
    await admin.project.delete({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

interface OfrepItem {
  key: string;
  reason?: string;
  value?: unknown;
  variant?: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

describe("bulk — POST /ofrep/v1/evaluate/flags", () => {
  it("mọi flag không-DRAFT, theo đúng hình openapi; DEFAULT ⇒ STATIC; bia mộ ⇒ DISABLED không value", async () => {
    const res = await bulk(CLIENT_DEV, {
      context: { targetingKey: SECRET_USER },
    }).expect(200);
    const flags = res.body.flags as OfrepItem[];
    const byKey = new Map(flags.map((f) => [f.key, f]));

    expect(byKey.get(betaKey)).toEqual({
      key: betaKey,
      reason: "TARGETING_MATCH",
      value: true,
      variant: "on",
    });
    expect(byKey.get(archivedKey)).toEqual({
      key: archivedKey,
      reason: "DISABLED",
      metadata: { archived: true },
    });
    expect(byKey.has(draftKey)).toBe(false);
    expect(res.body.metadata).toEqual({
      configVersion: expect.any(Number) as number,
    });

    const other = await bulk(CLIENT_DEV, {
      context: { targetingKey: "someone-else" },
    }).expect(200);
    expect(
      (other.body.flags as OfrepItem[]).find((f) => f.key === betaKey),
    ).toEqual({ key: betaKey, reason: "STATIC", value: false, variant: "off" });
  });

  it("I11 — response không mang userId của rule, id rule, salt hay id environment", async () => {
    const res = await bulk(CLIENT_DEV, {
      context: { targetingKey: "someone-else" },
    }).expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SECRET_USER);
    expect(text).not.toMatch(/ruleId|bucketSalt|condition|userIds/);
    expect(text).not.toContain(devEnv);
  });

  it("ETag theo CẢ context: cùng context ⇒ 304; khác context mang tag cũ ⇒ 200", async () => {
    const first = await bulk(CLIENT_DEV, {
      context: { targetingKey: SECRET_USER },
    }).expect(200);
    const tag = first.get("ETag");
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);

    await bulk(CLIENT_DEV, { context: { targetingKey: SECRET_USER } })
      .set("If-None-Match", tag ?? "")
      .expect(304);
    const changed = await bulk(CLIENT_DEV, {
      context: { targetingKey: "someone-else" },
    })
      .set("If-None-Match", tag ?? "")
      .expect(200);
    expect(changed.get("ETag")).not.toBe(tag);
  });

  it("NFC: context NFD và NFC là một — cùng ETag, cùng kết quả", async () => {
    const name = "Nguyễn";
    const a = await bulk(CLIENT_DEV, {
      context: { targetingKey: name.normalize("NFC") },
    }).expect(200);
    const b = await bulk(CLIENT_DEV, {
      context: { targetingKey: name.normalize("NFD") },
    }).expect(200);
    expect(b.get("ETag")).toBe(a.get("ETag"));
    expect(b.body).toEqual(a.body);
  });

  it("I14 — khoá prod nhận cấu hình prod (flag tắt), không chịu rule của dev", async () => {
    const res = await bulk(CLIENT_PROD, {
      context: { targetingKey: SECRET_USER },
    }).expect(200);
    expect(
      (res.body.flags as OfrepItem[]).find((f) => f.key === betaKey),
    ).toEqual({ key: betaKey, reason: "DISABLED" });
  });

  it("người vô danh (không targetingKey) được đánh giá, không 400 — khớp đường local (§6.4)", async () => {
    const res = await bulk(CLIENT_DEV, { context: {} }).expect(200);
    expect(
      (res.body.flags as OfrepItem[]).find((f) => f.key === betaKey)?.reason,
    ).toBe("STATIC");
  });
});

describe("single — POST /ofrep/v1/evaluate/flags/:key", () => {
  it("200 đúng hình; flag DRAFT và flag không có ⇒ 404 FLAG_NOT_FOUND", async () => {
    const res = await single(CLIENT_DEV, betaKey, {
      context: { targetingKey: SECRET_USER },
    }).expect(200);
    expect(res.body).toEqual({
      key: betaKey,
      reason: "TARGETING_MATCH",
      value: true,
      variant: "on",
    });
    for (const key of [draftKey, "khong-co"]) {
      const missing = await single(CLIENT_DEV, key, {
        context: { targetingKey: "x" },
      }).expect(404);
      expect(missing.body).toEqual({ key, errorCode: "FLAG_NOT_FOUND" });
    }
  });
});

describe("lỗi theo hình openapi, xác thực, CORS", () => {
  it("body sai ⇒ 400 PARSE_ERROR (single có key, bulk không); vượt trần ⇒ 400 INVALID_CONTEXT", async () => {
    const b = await bulk(CLIENT_DEV, { nope: 1 }).expect(400);
    expect(b.body).toMatchObject({ errorCode: "PARSE_ERROR" });
    expect(b.body).not.toHaveProperty("key");

    const s = await single(CLIENT_DEV, betaKey, { nope: 1 }).expect(400);
    expect(s.body).toMatchObject({ key: betaKey, errorCode: "PARSE_ERROR" });

    const broken = await request(app)
      .post("/ofrep/v1/evaluate/flags")
      .set("Authorization", `Bearer ${CLIENT_DEV}`)
      .set("Content-Type", "application/json")
      .send("{not json")
      .expect(400);
    expect(broken.body).toMatchObject({ errorCode: "PARSE_ERROR" });

    const wide = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`a${String(i)}`, i]),
    );
    const tooWide = await bulk(CLIENT_DEV, { context: wide }).expect(400);
    expect(tooWide.body).toMatchObject({ errorCode: "INVALID_CONTEXT" });

    const huge = await bulk(CLIENT_DEV, {
      context: { blob: "x".repeat(20_000) },
    }).expect(400);
    expect(huge.body).toMatchObject({ errorCode: "INVALID_CONTEXT" });
  });

  it("không khoá, khoá SERVER ⇒ 401 — OFREP chỉ dành cho CLIENT key; 401 vẫn mang CORS để trình duyệt đọc được", async () => {
    const denied = await request(app)
      .post("/ofrep/v1/evaluate/flags")
      .send({ context: {} })
      .expect(401);
    expect(denied.get("Access-Control-Allow-Origin")).toBe("*");
    await bulk(SERVER_DEV, { context: {} }).expect(401);
  });

  it("CORS: preflight 204 ngay; response thật mang Allow-Origin *, không credential", async () => {
    const pre = await request(app)
      .options("/ofrep/v1/evaluate/flags")
      .set("Origin", "https://shop.example")
      .set("Access-Control-Request-Method", "POST")
      .expect(204);
    expect(pre.get("Access-Control-Allow-Origin")).toBe("*");
    expect(pre.get("Access-Control-Allow-Headers")).toMatch(/Authorization/);
    expect(pre.get("Access-Control-Allow-Credentials")).toBeUndefined();

    const res = await bulk(CLIENT_DEV, { context: {} }).expect(200);
    expect(res.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.get("Access-Control-Expose-Headers")).toMatch(/ETag/);

    // Chỉ /ofrep — bề mặt khác của S2 không phục vụ trình duyệt
    const cfg = await request(app)
      .get("/sdk/config")
      .set("Authorization", `Bearer ${SERVER_DEV}`);
    expect(cfg.get("Access-Control-Allow-Origin")).toBeUndefined();
  });
});

describe("Flag Evaluation Tester — POST /internal/flags/:id/evaluate", () => {
  const tester = (flagId: string, body: object): request.Test =>
    request(app)
      .post(`/internal/flags/${flagId}/evaluate`)
      .set(INTERNAL_SECRET_HEADER, SECRET)
      .send(body);

  it("trả evaluation kèm rule khớp lấy từ CÙNG snapshot", async () => {
    const res = await tester(betaId, {
      environmentId: devEnv,
      context: { targetingKey: SECRET_USER },
    }).expect(200);
    expect(res.body).toMatchObject({
      evaluation: { reason: "TARGETING_MATCH", variant: "on" },
      rule: { ruleType: "USER_BASED", priority: 0 },
      draft: false,
    });
    expect(res.body.rule.id).toBe(res.body.evaluation.ruleId);
  });

  it("flag DRAFT thử được — đánh dấu draft, dù SDK hôm nay chưa thấy nó", async () => {
    const res = await tester(draftId, {
      environmentId: devEnv,
      context: {},
    }).expect(200);
    expect(res.body).toMatchObject({
      evaluation: { reason: "DEFAULT" },
      draft: true,
    });
  });

  it("environment của project khác ⇒ 404; thiếu bí mật ⇒ 401", async () => {
    const stranger = await admin.environment.findFirst({
      where: { projectId: { not: projectId ?? "" } },
      select: { id: true },
    });
    if (stranger !== null) {
      await tester(betaId, {
        environmentId: stranger.id,
        context: {},
      }).expect(404);
    }
    await request(app)
      .post(`/internal/flags/${betaId}/evaluate`)
      .send({ environmentId: devEnv, context: {} })
      .expect(401);
  });
});

import { createHash, randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { changeFeedWatcher } from "../src/changefeed/index.js";
import { stableOwner } from "./helpers/fixture.js";

/**
 * `GET /sdk/config` qua HTTP thật.
 *
 * Trọng tâm KHÔNG phải "lấy được cấu hình" mà là ba ranh giới mà một test hạnh
 * phúc không nói gì tới:
 *
 *   - **I11 / ADR-03** — §9 viết "CHỈ cấp cho SERVER key. CLIENT key không bao
 *     giờ chạm endpoint này". Khoá CLIENT lọt vào đây là toàn bộ tập rule rời
 *     server xuống trình duyệt.
 *   - **I14** — environment suy ra TỪ KHOÁ. Khoá của project này không được thấy
 *     cấu hình của project kia.
 *   - **ETag/304** — thiếu ngoặc kép thì 304 không bao giờ xảy ra, và triệu
 *     chứng chỉ là băng thông, không phải lỗi.
 */

const app = createApp();

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_sdktest_${randomUUID()}`,
});

const sha256 = (v: string): string =>
  createHash("sha256").update(v).digest("hex");

const SERVER_KEY = `udp_sk_test_${randomUUID()}`;
const CLIENT_KEY = `udp_ck_test_${randomUUID()}`;
const REVOKED_KEY = `udp_sk_test_${randomUUID()}`;
const OTHER_KEY = `udp_sk_test_${randomUUID()}`;
/** Khoá của env `prod` trong CÙNG project với `SERVER_KEY` */
const PROD_KEY = `udp_sk_test_${randomUUID()}`;

let projectIds: string[] = [];
let envIds: string[] = [];
let ownFlagKey: string;
let otherFlagKey: string;
let mineDevEnv: string;

const makeProject = async (
  ownerId: string,
  tag: string,
  withProd = false,
): Promise<{
  projectId: string;
  envId: string;
  prodEnvId: string | undefined;
}> => {
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId,
      name: `sdktest-${tag}-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-sdk-${tag}-${suffix}` },
          ...(withProd
            ? [
                {
                  name: "prod",
                  rank: 1,
                  k8sNamespace: `udp-sdk-${tag}-${suffix}-prd`,
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

  const envId = project.environments[0]?.id;
  if (envId === undefined) throw new Error("fixture thiếu environment");
  return {
    projectId: project.id,
    envId,
    prodEnvId: project.environments[1]?.id,
  };
};

beforeAll(async () => {
  const owner = await stableOwner(admin);

  const mine = await makeProject(owner.id, "own", true);
  const theirs = await makeProject(owner.id, "other");
  if (mine.prodEnvId === undefined) throw new Error("fixture thiếu env prod");
  projectIds = [mine.projectId, theirs.projectId];
  envIds = [mine.envId, mine.prodEnvId, theirs.envId];
  mineDevEnv = mine.envId;

  await admin.sdkKey.createMany({
    data: [
      {
        environmentId: mine.envId,
        keyType: "SERVER",
        keyHash: sha256(SERVER_KEY),
        keySuffix: SERVER_KEY.slice(-6),
        label: "sdktest server",
        createdById: owner.id,
      },
      {
        environmentId: mine.envId,
        keyType: "CLIENT",
        keyHash: sha256(CLIENT_KEY),
        keySuffix: CLIENT_KEY.slice(-6),
        label: "sdktest client",
        createdById: owner.id,
      },
      {
        environmentId: mine.envId,
        keyType: "SERVER",
        keyHash: sha256(REVOKED_KEY),
        keySuffix: REVOKED_KEY.slice(-6),
        label: "sdktest revoked",
        createdById: owner.id,
        revokedAt: new Date(),
      },
      {
        environmentId: theirs.envId,
        keyType: "SERVER",
        keyHash: sha256(OTHER_KEY),
        keySuffix: OTHER_KEY.slice(-6),
        label: "sdktest other project",
        createdById: owner.id,
      },
      {
        environmentId: mine.prodEnvId,
        keyType: "SERVER",
        keyHash: sha256(PROD_KEY),
        keySuffix: PROD_KEY.slice(-6),
        label: "sdktest prod cùng project",
        createdById: owner.id,
      },
    ],
  });

  /** Mỗi project một flag riêng — đó là thứ để đo I14 */
  ownFlagKey = `own-${randomUUID().slice(0, 8)}`;
  otherFlagKey = `other-${randomUUID().slice(0, 8)}`;

  for (const [projectId, key] of [
    [mine.projectId, ownFlagKey],
    [theirs.projectId, otherFlagKey],
  ] as const) {
    await request(app)
      .post("/internal/flags")
      .set("X-Internal-Secret", env.INTERNAL_SERVICE_SECRET)
      .send({ projectId, key, flagType: "BOOLEAN" })
      .expect(201);
  }
});

afterAll(async () => {
  if (envIds.length > 0) {
    await admin.configChangeLog.deleteMany({
      where: { environmentId: { in: envIds } },
    });
    await admin.project.deleteMany({ where: { id: { in: projectIds } } });
  }
  await admin.$disconnect();
});

const get = (key?: string): request.Test => {
  const req = request(app).get("/sdk/config");
  return key === undefined ? req : req.set("Authorization", `Bearer ${key}`);
};

describe("guard của /sdk/config", () => {
  it("thiếu Authorization thì 401", async () => {
    await get().expect(401);
  });

  it("CLIENT key bị TỪ CHỐI — không rule nào rời server (ADR-03, I11)", async () => {
    /**
     * Đây là khoá HỢP LỆ, chưa thu hồi, đúng environment. Thứ duy nhất sai là
     * LOẠI. Một guard chỉ hỏi "khoá này có thật không" sẽ cho nó qua, và khi đó
     * toàn bộ rule targeting đi xuống trình duyệt — đúng thứ v4 viết lại ADR-03
     * để chấm dứt. Khoá CLIENT phải đi đường OFREP và nhận kết quả đã đánh giá.
     */
    await get(CLIENT_KEY).expect(401);
  });

  it("khoá đã thu hồi thì 401", async () => {
    await get(REVOKED_KEY).expect(401);
  });

  it("mọi ca hỏng dùng CHUNG một thông điệp", async () => {
    /**
     * Phân biệt "không có khoá này" với "khoá đã thu hồi" là một kênh dò: nó cho
     * biết chuỗi vừa thử TỪNG là khoá thật. `internal-auth.guard.ts` đã đặt khuôn
     * này; guard SDK chép nguyên.
     */
    const [missing, unknown, revoked, wrongType] = await Promise.all([
      get(),
      get(`udp_sk_khong_ton_tai_${randomUUID()}`),
      get(REVOKED_KEY),
      get(CLIENT_KEY),
    ]);

    const detailOf = (r: request.Response): unknown =>
      r.body.detail ?? r.body.title;

    expect(detailOf(unknown)).toBe(detailOf(missing));
    expect(detailOf(revoked)).toBe(detailOf(missing));
    expect(detailOf(wrongType)).toBe(detailOf(missing));
  });
});

describe("payload đúng hợp đồng §9", () => {
  it("SERVER key nhận đủ configVersion, configHash, environment, trackedFlags, segments", async () => {
    const res = await get(SERVER_KEY).expect(200);

    expect(typeof res.body.configVersion).toBe("number");
    expect(res.body.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.environment).toBe("dev");
    expect(Array.isArray(res.body.trackedFlags)).toBe(true);
    expect(Array.isArray(res.body.segments)).toBe(true);
    expect(Array.isArray(res.body.flags)).toBe(true);
  });

  it("KHÔNG rò id nội bộ nào ra dây", async () => {
    const res = await get(SERVER_KEY).expect(200);
    const body = JSON.stringify(res.body);

    expect(body).not.toContain("variantId");
    expect(body).not.toContain("defaultVariantId");
    expect(body).not.toContain("envDefaultVariantId");
  });
});

describe("I14 — environment suy ra TỪ KHOÁ", () => {
  it("khoá của project này KHÔNG thấy flag của project kia", async () => {
    const mine = await get(SERVER_KEY).expect(200);
    const theirs = await get(OTHER_KEY).expect(200);

    const keysOf = (r: request.Response): string[] =>
      (r.body.flags as { key: string }[]).map((f) => f.key);

    expect(keysOf(mine)).toContain(ownFlagKey);
    expect(keysOf(mine)).not.toContain(otherFlagKey);

    expect(keysOf(theirs)).toContain(otherFlagKey);
    expect(keysOf(theirs)).not.toContain(ownFlagKey);
  });

  it("khoá dev và khoá prod của CÙNG project thấy đúng environment của mình", async () => {
    /**
     * Ranh giới I14 hẹp nhất: cùng project, cùng flag, khác environment. Bật flag
     * ở dev thì khoá prod vẫn phải thấy prod — nếu environment suy từ project
     * thay vì từ khoá, hai khoá này sẽ thấy cùng một thứ.
     */
    const envConfig = await admin.flagEnvConfig.findFirstOrThrow({
      where: { environmentId: mineDevEnv, flag: { key: ownFlagKey } },
      select: { id: true },
    });
    await request(app)
      .patch(`/internal/flag-envs/${envConfig.id}`)
      .set("X-Internal-Secret", env.INTERNAL_SERVICE_SECRET)
      .send({ isEnabled: true })
      .expect(200);
    // Cache của tiến trình theo kịp lần ghi — watcher không chạy nền trong test
    await changeFeedWatcher.tick();

    const dev = await get(SERVER_KEY).expect(200);
    const prod = await get(PROD_KEY).expect(200);
    expect(dev.body.environment).toBe("dev");
    expect(prod.body.environment).toBe("prod");

    const enabledIn = (r: request.Response): unknown =>
      (r.body.flags as { key: string; isEnabled?: boolean }[]).find(
        (f) => f.key === ownFlagKey,
      )?.isEnabled;
    expect(enabledIn(dev)).toBe(true);
    expect(enabledIn(prod)).toBe(false);
  });
});

describe("ETag và 304", () => {
  it("ETag là config_version, CÓ ngoặc kép", async () => {
    const res = await get(SERVER_KEY).expect(200);
    /**
     * Ngoặc kép không phải trang trí: `ETag: 47` không phải entity-tag hợp lệ,
     * và client đúng chuẩn vẫn gửi lại `If-None-Match: "47"`. Khi đó server
     * không bao giờ thấy khớp, 304 không xảy ra, và polling fallback 30 giây
     * của SDK tải full snapshot vĩnh viễn — im lặng, không lỗi nào trong log.
     */
    expect(res.headers["etag"]).toBe(`"${String(res.body.configVersion)}"`);
  });

  it("If-None-Match khớp thì 304 và KHÔNG có body", async () => {
    const first = await get(SERVER_KEY).expect(200);
    // `!` duoc phep trong tests (eslint.config.mjs mien luat nay cho tests/**);
    // `noUncheckedIndexedAccess` khai header la `string | undefined`.
    const etag = first.headers["etag"]!;

    const second = await get(SERVER_KEY).set("If-None-Match", etag).expect(304);

    expect(second.text).toBeFalsy();
  });

  it("ETag cũ thì trả 200 kèm body mới", async () => {
    const res = await get(SERVER_KEY).set("If-None-Match", '"0"').expect(200);
    expect(res.body.flags).toBeDefined();
  });

  it("đặt Cache-Control private và Vary Authorization", async () => {
    /**
     * `/sdk/config` là MỘT url cho MỌI environment, và helmet không đặt hai
     * header này. Thiếu chúng, một cache dùng chung khoá theo URL có thể trả body
     * của `dev` cho một khoá `prod` — I14 vỡ mà không cần ai tấn công.
     */
    const res = await get(SERVER_KEY).expect(200);
    expect(res.headers["cache-control"]).toBe("private, no-cache");
    expect(res.headers["vary"]).toContain("Authorization");
  });
});

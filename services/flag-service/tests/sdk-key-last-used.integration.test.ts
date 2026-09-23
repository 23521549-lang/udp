import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient, observeQueries } from "@udp/db";
import {
  disposeProject,
  issueSdkKey,
  newSdkKeyToken,
  sdkKeyData,
  stableOwner,
} from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/core/db.js";

/**
 * [v4.9] `last_used_at` trên đường đọc NÓNG (§3.7, R34).
 *
 * Cột này chỉ để Portal hiển thị "khoá còn được dùng không", nên nó không được
 * phép làm `/sdk/config` chậm thêm một RTT hay đỏ thêm một lỗi. Hai lớp throttle
 * được kiểm riêng:
 *
 *   - **Lớp trong tiến trình** — 20 request ĐỒNG THỜI của cùng một khoá chỉ bắn
 *     MỘT câu UPDATE. Đếm bằng `observeQueries` trên đúng client của Service 2,
 *     nên không cần đoán bằng thời gian.
 *   - **Lớp `WHERE`** — khoá vừa được ghi (`last_used_at` mới) thì câu UPDATE có
 *     bắn cũng không đổi hàng nào. Đây là lớp throttle THẬT giữa nhiều replica.
 */

const app = createApp();
const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_lastused_${randomUUID()}`,
});

const suffix = randomUUID().slice(0, 8);
/** Mốc còn mới hơn `SDK_KEY.lastUsedThrottleMs` ⇒ không được ghi lại */
const RECENT_KEY = newSdkKeyToken("SERVER");
/** Mốc đã cũ ⇒ phải được ghi lại */
const OLD_KEY = newSdkKeyToken("SERVER");
const OLD_MARK = new Date(Date.now() - 5 * 60_000);

let projectId = "";
let environmentId = "";
let actorId = "";
let freshToken = "";
let updates = 0;
let unobserve: () => void = () => undefined;

const lastUsedOf = async (token: string): Promise<Date | null> => {
  const { keyHash } = sdkKeyData({
    token,
    environmentId,
    keyType: "SERVER",
    createdById: actorId,
  });
  const row = await admin.sdkKey.findUniqueOrThrow({
    where: { keyHash },
    select: { lastUsedAt: true },
  });
  return row.lastUsedAt;
};

const getConfig = (token: string) =>
  request(app).get("/sdk/config").set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  actorId = (await stableOwner(admin)).id;
  const project = await admin.project.create({
    data: {
      ownerId: actorId,
      name: `lastused-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [{ name: "dev", rank: 0, k8sNamespace: `udp-lu-${suffix}` }],
      },
    },
    select: { id: true, environments: { select: { id: true } } },
  });
  projectId = project.id;
  environmentId = project.environments[0]?.id ?? "";

  freshToken = await issueSdkKey(admin, {
    environmentId,
    keyType: "SERVER",
    createdById: actorId,
    label: "lastused fresh",
  });
  await admin.sdkKey.create({
    data: {
      ...sdkKeyData({
        token: RECENT_KEY,
        environmentId,
        keyType: "SERVER",
        createdById: actorId,
        label: "lastused recent",
      }),
      lastUsedAt: new Date(),
    },
  });
  await admin.sdkKey.create({
    data: {
      ...sdkKeyData({
        token: OLD_KEY,
        environmentId,
        keyType: "SERVER",
        createdById: actorId,
        label: "lastused old",
      }),
      lastUsedAt: OLD_MARK,
    },
  });

  unobserve = observeQueries(prisma, (observation) => {
    if (/update\s+sdk_keys/i.test(observation.query)) updates += 1;
  });
}, 60_000);

afterAll(async () => {
  unobserve();
  await disposeProject(admin, projectId);
  await admin.$disconnect();
});

describe("last_used_at của SDK key", () => {
  it("20 request đồng thời ⇒ ĐÚNG một câu UPDATE, và mốc được ghi", async () => {
    expect(await lastUsedOf(freshToken)).toBeNull();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => getConfig(freshToken)),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);

    /**
     * [v4.9] Chờ trên BỘ ĐẾM, không trên hàng.
     *
     * Hàng được commit ở phía Postgres, nên `admin` — một kết nối khác — thấy giá
     * trị mới ngay khi commit xong, tức có thể TRƯỚC khi phản hồi của câu
     * bắn-và-quên về tới client của Service 2 và sự kiện `query` được phát. Chờ
     * trên hàng rồi mới so bộ đếm là đua với đúng khoảng đó, và khoảng ấy rộng ra
     * khi tiến trình đang tải: đã thấy đỏ ở một lần chạy đủ bộ, xanh khi chạy
     * riêng cùng file. Cùng tập khẳng định, chỉ đổi thứ được chờ.
     */
    await vi.waitFor(() => {
      expect(updates).toBe(1);
    });
    expect(await lastUsedOf(freshToken)).not.toBeNull();
  });

  it("mốc còn mới ⇒ không ghi gì; mốc đã cũ ⇒ ghi lại", async () => {
    const recentBefore = await lastUsedOf(RECENT_KEY);
    const seen = updates;

    await getConfig(RECENT_KEY).expect(200);
    await getConfig(OLD_KEY).expect(200);

    /**
     * Chỉ khoá có mốc CŨ bắn UPDATE. Khẳng định đợi ĐÚNG một lần ghi nữa rồi so
     * mốc, nên không cần `sleep` để chứng minh lần kia KHÔNG xảy ra. Mốc của khoá
     * còn mới thì bất biến hai lần: không câu nào được bắn, và điều kiện `WHERE`
     * của câu đó cũng không cho đổi hàng (lớp giữ throttle giữa nhiều replica).
     *
     * [v4.9] Chờ trên bộ đếm, không trên hàng — xem ca trên.
     */
    await vi.waitFor(() => {
      expect(updates).toBe(seen + 1);
    });
    expect(await lastUsedOf(OLD_KEY)).not.toEqual(OLD_MARK);
    expect((await lastUsedOf(RECENT_KEY))?.getTime()).toBe(
      recentBefore?.getTime(),
    );
  });

  it("khoá đã thu hồi ⇒ 401 và KHÔNG ghi mốc (chỉ khoá hợp lệ mới chạm database)", async () => {
    const revoked = newSdkKeyToken("SERVER");
    await admin.sdkKey.create({
      data: {
        ...sdkKeyData({
          token: revoked,
          environmentId,
          keyType: "SERVER",
          createdById: actorId,
          label: "lastused revoked",
        }),
        revokedAt: new Date(),
      },
    });
    const seen = updates;

    await getConfig(revoked).expect(401);
    await getConfig(freshToken).expect(200);

    // Request thứ hai (khoá hợp lệ, vừa chạm) cũng không bắn UPDATE nào nữa:
    // cả hai lớp throttle đều đang giữ
    expect(updates).toBe(seen);
    expect(await lastUsedOf(revoked)).toBeNull();
  });
});

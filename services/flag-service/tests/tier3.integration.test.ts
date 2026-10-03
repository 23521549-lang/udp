import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CHANGE_FEED, env } from "@udp/config";
import {
  createPrismaClient,
  createSessionConnector,
  observeQueries,
} from "@udp/db";
import type { SdkConfigResponse } from "@udp/flag-evaluator";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  changeFeed,
  changeFeedWatcher,
  configCache,
  configChanges,
  pruneJob,
} from "../src/changefeed/index.js";
import { createCircuitBreaker } from "../src/changefeed/circuit-breaker.js";
import {
  createNotifyAccelerator,
  type NotifyAccelerator,
} from "../src/changefeed/notify.accelerator.js";
import { createVersionWatcher } from "../src/changefeed/version.watcher.js";
import { prisma, SERVICE_ROLE } from "../src/core/db.js";
import { sseHub } from "../src/sdk/index.js";
import {
  createActiveFlag,
  internalCall,
  newSdkKeyToken,
  sdkKeyData,
  stableOwner,
} from "@udp/test-support";
import { openSse, type SseReader } from "./helpers/sse-reader.js";

/**
 * Tầng 3 đầu–cuối trên database thật (ADR-05, §6.3):
 *
 *     ghi ⇒ NOTIFY trong transaction ⇒ LISTEN của udp_s2 (`DATABASE_URL_S2_DIRECT`)
 *         ⇒ wake ⇒ MỘT vòng poll ⇒ event SSE
 *
 * Watcher của tiến trình KHÔNG khởi động — không có vòng poll nền nào — nên event
 * tới trong < 1 giây mà không ai gọi `tick()` CHỈ có thể là nhờ NOTIFY. Cộng hai
 * bất biến trên cùng đường: I18 (outbox bị dọn ⇒ hổng ⇒ snapshot) và I19
 * (transaction dài không chặn đường lan truyền).
 */

/** User có thật (FK của audit và outbox) — route ghi của S2 bắt buộc actor [v4.5] */
let actorId = "";
const app = createApp();

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_tier3test_${randomUUID()}`,
});

const KEY = newSdkKeyToken("SERVER");

let server: Server | undefined;
let base = "";
let projectId: string | undefined;
let envId = "";
let accelerator: NotifyAccelerator | undefined;
const readers: SseReader[] = [];
/** Flag ACTIVE trong fixture, và mốc optimistic lock mới nhất của nó */
let flagId = "";
let flagStamp = "";
let writes = 0;

beforeAll(async () => {
  expect(
    env.CHANGEFEED_NOTIFY_ENABLED,
    "CHANGEFEED_NOTIFY_ENABLED=false — writer không NOTIFY, file này không có gì để đo",
  ).toBe(true);

  const listening = app.listen(0);
  server = listening;
  await new Promise<void>((resolve) => listening.once("listening", resolve));
  base = `http://127.0.0.1:${String((listening.address() as AddressInfo).port)}`;

  const owner = await stableOwner(admin);
  actorId = owner.id;
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId: owner.id,
      name: `tier3test-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-tier3-${suffix}-dev` },
        ],
      },
    },
    select: { id: true, environments: { select: { id: true } } },
  });
  projectId = project.id;
  const dev = project.environments[0]?.id;
  if (dev === undefined) throw new Error("fixture thiếu environment");
  envId = dev;

  await admin.sdkKey.create({
    data: sdkKeyData({
      token: KEY,
      environmentId: dev,
      keyType: "SERVER",
      createdById: owner.id,
      label: "tier3test",
    }),
  });

  // Flag ACTIVE có mặt trong snapshot ⇒ mỗi lần sửa nó đổi cả `config_hash`
  const flag = await createActiveFlag(app, actorId, {
    projectId,
    key: `t3-${randomUUID().slice(0, 8)}`,
    flagType: "BOOLEAN",
  });
  flagId = flag.body.flag.id as string;
  flagStamp = flag.body.flag.updatedAt as string;
  await write();
});

afterAll(async () => {
  for (const reader of readers) reader.close();
  await accelerator?.stop();
  changeFeedWatcher.stop();
  const listening = server;
  if (listening !== undefined) {
    listening.closeAllConnections();
    await new Promise<void>((resolve) => {
      listening.close(() => {
        resolve();
      });
    });
  }
  if (projectId !== undefined) {
    await admin.configChangeLog.deleteMany({
      where: { environmentId: envId },
    });
    await admin.auditLog.deleteMany({ where: { projectId: projectId } });
    await admin.project.delete({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

/**
 * Mốc ngay SAU commit — `/internal` chỉ trả lời khi transaction đã commit.
 *
 * [v4.9] Một lần ghi ở đây phải ĐỔI NỘI DUNG snapshot, không chỉ đổi
 * `config_version`. Bản trước tạo một flag DRAFT mỗi lần: version tiến mà
 * snapshot y nguyên (DRAFT không bao giờ xuống SDK, §6.7), nên `config_hash`
 * không đổi — và từ [v4.9] hub trả lời đúng điều đó bằng `flag_changed` rỗng
 * thay cho một snapshot đầy đủ (L1). Ba ca dưới đây đo ĐƯỜNG LAN TRUYỀN nên
 * chúng cần một thay đổi thật.
 *
 * Giá trị mới phải KHÁC MỌI giá trị trước, không chỉ khác giá trị liền trước:
 * ca I18 ghi hai lần rồi mới đọc một event, nên một phép bật/tắt hai trạng thái
 * sẽ tự triệt tiêu và hash lại về đúng chỗ cũ. `stickinessAttribute` nằm trong
 * snapshot (§9) và nhận chuỗi tự do, nên đếm tăng dần là đủ.
 */
async function write(): Promise<number> {
  writes += 1;
  const res = await internalCall(
    request(app).patch(`/internal/flags/${flagId}`),
    actorId,
  )
    .send({
      lastKnownUpdatedAt: flagStamp,
      stickinessAttribute: `sticky${String(writes)}`,
    })
    .expect(200);
  flagStamp = res.body.flag.updatedAt as string;
  return Date.now();
}

async function open(): Promise<SseReader> {
  const reader = await openSse(`${base}/sdk/stream`, {
    Authorization: `Bearer ${KEY}`,
  });
  readers.push(reader);
  return reader;
}

const bodyOf = <T>(data: string | undefined): T => {
  if (data === undefined) throw new Error("event không có data");
  return JSON.parse(data) as T;
};

describe("I18 — outbox bị dọn ⇒ hổng ⇒ snapshot, không phải delta sai", () => {
  it("lùi created_at quá hạn giữ, dọn bằng ĐÚNG job của S2 ⇒ stream nhận snapshot", async () => {
    /**
     * Chạy TRƯỚC khi tầng 3 bật: không có gì đánh thức watcher snapshot của tiến
     * trình, nên thứ duy nhất xử lý hai lần ghi dưới đây là watcher delta — đúng
     * đường mà hổng phải bị bắt.
     */
    const deltaWatcher = createVersionWatcher({
      feed: changeFeed,
      cache: configCache,
      breaker: createCircuitBreaker(),
      deltaMode: true,
      events: configChanges,
    });
    const s = await open();
    const held = bodyOf<SdkConfigResponse>((await s.next(5_000)).data);

    await write();
    await write();
    const gap = held.configVersion + 1;
    await admin.configChangeLog.updateMany({
      where: { environmentId: envId, configVersion: gap },
      data: {
        createdAt: new Date(
          Date.now() - (CHANGE_FEED.retentionDays + 1) * 86_400_000,
        ),
      },
    });
    expect(await pruneJob.runOnce()).toBeGreaterThanOrEqual(1);
    expect(
      await admin.configChangeLog.count({
        where: { environmentId: envId, configVersion: gap },
      }),
    ).toBe(0);

    await deltaWatcher.tick();
    const event = await s.next(5_000);
    expect(event.event).toBe("snapshot");
    expect(Number(event.id)).toBe(held.configVersion + 2);
    s.close();
  });
});

describe("tầng 3 — NOTIFY đánh thức, không cần vòng poll", () => {
  beforeAll(async () => {
    const listenUrl = env.DATABASE_URL_S2_DIRECT;
    if (listenUrl === undefined)
      throw new Error("thiếu DATABASE_URL_S2_DIRECT");

    let heard: () => void = () => undefined;
    const listening = new Promise<void>((resolve) => {
      heard = resolve;
    });
    accelerator = createNotifyAccelerator({
      connect: createSessionConnector(listenUrl),
      expectedRole: SERVICE_ROLE,
      holds: (environmentId) => configCache.holds(environmentId),
      // Lần đánh thức ĐẦU TIÊN xảy ra ngay sau khi LISTEN xong — tín hiệu "đã nghe"
      wake: () => {
        heard();
        changeFeedWatcher.wake();
      },
    });
    accelerator.start();
    await listening;
  });

  it("ghi ⇒ event SSE trong < 1 giây, không ai gọi tick()", async () => {
    const s = await open();
    await s.next(5_000);

    const committed = await write();
    expect((await s.next(1_000)).event).toBe("snapshot");
    expect(Date.now() - committed).toBeLessThan(1_000);
    s.close();
  });

  it("I19: transaction dài ĐANG MỞ không chặn lan truyền — cả đường NOTIFY lẫn đường tick", async () => {
    const s = await open();
    await s.next(5_000);

    let release: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened: () => void = () => undefined;
    const isOpen = new Promise<void>((resolve) => {
      opened = resolve;
    });
    // Giữ một xid suốt lúc kiểm ⇒ giữ `xmin` — đúng thứ làm con trỏ xid8 của v3.2 đứng im
    const longTx = admin.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT txid_current()::text AS xid`;
        opened();
        await holding;
      },
      { maxWait: 10_000, timeout: 60_000 },
    );

    try {
      await isOpen;

      // Đường NOTIFY
      let committed = await write();
      expect((await s.next(1_000)).event).toBe("snapshot");
      expect(Date.now() - committed).toBeLessThan(1_000);

      // Đường tick: tắt tầng 3 để chỉ còn vòng poll
      await accelerator?.stop();
      committed = await write();
      await changeFeedWatcher.tick();
      expect((await s.next(1_000)).event).toBe("snapshot");
      expect(Date.now() - committed).toBeLessThan(1_000);
    } finally {
      release();
      await longTx;
    }
    s.close();
  });
});

/**
 * Chốt cấu trúc của I19 [v4.2]: thời gian tường ở trên là NỘI DUNG bất biến
 * (transaction dài không chặn), còn đây là hàng rào chống hồi quy về số round
 * trip, thứ mà đồng hồ không bắt được khi RTT nhỏ (thêm một truy vấn ở 40ms vẫn
 * "< 1 giây"). Ở `CHANGEFEED_MODE=snapshot`, một `tick()` với đúng một
 * environment đổi dùng đúng 2 câu `SELECT` trên client của S2: một đọc
 * `config_version`/`config_hash` của mọi environment đang giữ (tầng 1), một câu
 * lệnh nạp snapshot. Ở chế độ `delta` tập truy vấn khác (`deltasSince` thay cho
 * snapshot), nên test chỉ có nghĩa ở chế độ mặc định.
 *
 * Điều kiện để phép đếm tất định: tầng 3 đã tắt, không còn stream nào (hub chỉ
 * có timer khi có stream), watcher không chạy nền, và environment đang được cache
 * giữ. Cửa sổ nghe chỉ bao quanh `tick()`.
 */
describe("chốt cấu trúc của I19 — một vòng tick ở chế độ snapshot dùng đúng 2 truy vấn", () => {
  beforeAll(async () => {
    expect(env.CHANGEFEED_MODE, "test này chỉ có nghĩa ở chế độ snapshot").toBe(
      "snapshot",
    );
    await accelerator?.stop();
    for (const reader of readers) reader.close();
    const deadline = Date.now() + 5_000;
    while (sseHub.size() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(sseHub.size(), "hub vẫn còn stream, phép đếm sẽ nhiễu").toBe(0);
    await configCache.get(envId, "SERVER");
  });

  it("statesOf + một câu lệnh snapshot, không hơn", async () => {
    await write();

    const seen: string[] = [];
    const stop = observeQueries(prisma, (q) => seen.push(q.query));
    try {
      await changeFeedWatcher.tick();
    } finally {
      stop();
    }

    const selects = seen.filter((q) =>
      /^\s*(\/\*[^]*?\*\/\s*)?SELECT/i.test(q),
    );
    expect(selects).toHaveLength(2);
    expect(selects[0]).toMatch(/FROM "public"\."environments"/);
    expect(selects[1]).toContain("udp:snapshot");
  });
});

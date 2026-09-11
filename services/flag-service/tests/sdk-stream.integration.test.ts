import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { env, SSE } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import {
  configHashOf,
  type SdkConfigResponse,
  type SdkStreamDelta,
  type Snapshot,
} from "@udp/flag-evaluator";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  changeFeed,
  configCache,
  configChanges,
} from "../src/changefeed/index.js";
import { createCircuitBreaker } from "../src/changefeed/circuit-breaker.js";
import { createVersionWatcher } from "../src/changefeed/version.watcher.js";
import { sseHub } from "../src/sdk/index.js";
import { stableOwner } from "./helpers/fixture.js";
import { openSse, type SseReader } from "./helpers/sse-reader.js";

/**
 * `GET /sdk/stream` qua HTTP THẬT — server lắng nghe cổng thật, client là `fetch`.
 *
 * Supertest không dùng được cho stream: nó chờ response KẾT THÚC. Luật con trỏ,
 * event và khoá được kiểm kỹ ở `sse.manager.test.ts`; ở đây là những thứ chỉ lộ
 * ra khi mọi tầng ráp lại: header thật qua helmet, guard thật, watcher thật trên
 * database thật, và `res` thật của Node — chính cái `res` mà `req.on('close')`
 * đã đo là bắn sớm.
 *
 * Watcher KHÔNG khởi động: mỗi test gọi `tick()` đúng lúc cần, nên thứ tự sự kiện
 * là tất định. Hai watcher — `snapshot` và `delta` — dùng CHUNG cache và kênh sự
 * kiện của tiến trình, đúng như production chỉ có một bộ.
 */

const app = createApp();
const SECRET = env.INTERNAL_SERVICE_SECRET;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_streamtest_${randomUUID()}`,
});

const watcherOf = (deltaMode: boolean) =>
  createVersionWatcher({
    feed: changeFeed,
    cache: configCache,
    breaker: createCircuitBreaker(),
    deltaMode,
    events: configChanges,
  });
const snapshotWatcher = watcherOf(false);
const deltaWatcher = watcherOf(true);

const sha256 = (v: string): string =>
  createHash("sha256").update(v).digest("hex");
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Chờ tới khi `ok()` đúng, hoặc ném sau `ms` — cho việc server làm SAU khi client đi */
async function waitUntil(
  ok: () => boolean,
  ms: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`Hết ${String(ms)}ms: ${what}`);
    await sleep(25);
  }
}

const DEV_KEY = `udp_sk_test_${randomUUID()}`;
const PROD_KEY = `udp_sk_test_${randomUUID()}`;
const CLIENT_KEY = `udp_ck_test_${randomUUID()}`;
const REVOKED_KEY = `udp_sk_test_${randomUUID()}`;
const DOOMED_KEY = `udp_sk_test_${randomUUID()}`;

let server: Server | undefined;
let base = "";
let projectId: string | undefined;
let envIds: string[] = [];
let devEnv = "";
let flagId = "";
const readers: SseReader[] = [];

beforeAll(async () => {
  const listening = app.listen(0);
  server = listening;
  await new Promise<void>((resolve) => listening.once("listening", resolve));
  base = `http://127.0.0.1:${String((listening.address() as AddressInfo).port)}`;

  const owner = await stableOwner(admin);
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId: owner.id,
      name: `streamtest-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-stream-${suffix}-dev` },
          { name: "prod", rank: 1, k8sNamespace: `udp-stream-${suffix}-prd` },
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
  const [dev, prod] = envIds;
  if (dev === undefined || prod === undefined) {
    throw new Error("fixture thiếu environment");
  }
  devEnv = dev;

  const key = (
    raw: string,
    environmentId: string,
    extra: { keyType?: "SERVER" | "CLIENT"; revokedAt?: Date } = {},
  ) => ({
    environmentId,
    keyType: extra.keyType ?? "SERVER",
    keyHash: sha256(raw),
    keySuffix: raw.slice(-6),
    label: "streamtest",
    createdById: owner.id,
    ...(extra.revokedAt === undefined ? {} : { revokedAt: extra.revokedAt }),
  });
  await admin.sdkKey.createMany({
    data: [
      key(DEV_KEY, dev),
      key(PROD_KEY, prod),
      key(CLIENT_KEY, dev, { keyType: "CLIENT" }),
      key(REVOKED_KEY, dev, { revokedAt: new Date() }),
      key(DOOMED_KEY, dev),
    ],
  });

  const created = await createFlag(`base-${suffix}`).expect(201);
  flagId = created.body.flag.id as string;
});

afterAll(async () => {
  for (const reader of readers) reader.close();
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
      where: { environmentId: { in: envIds } },
    });
    await admin.project.delete({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

function createFlag(key: string): request.Test {
  return request(app)
    .post("/internal/flags")
    .set("X-Internal-Secret", SECRET)
    .send({ projectId, key, flagType: "BOOLEAN" });
}

const configOf = (key: string): request.Test =>
  request(app).get("/sdk/config").set("Authorization", `Bearer ${key}`);

async function open(
  key: string | undefined,
  options: {
    since?: string;
    lastEventId?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<SseReader> {
  const url = new URL("/sdk/stream", base);
  if (options.since !== undefined) url.searchParams.set("since", options.since);
  const reader = await openSse(url.toString(), {
    ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }),
    ...(options.lastEventId === undefined
      ? {}
      : { "Last-Event-ID": options.lastEventId }),
    ...options.headers,
  });
  readers.push(reader);
  return reader;
}

const bodyOf = <T>(data: string | undefined): T => {
  if (data === undefined) throw new Error("event không có data");
  return JSON.parse(data) as T;
};

describe("guard của /sdk/stream", () => {
  it("thiếu khoá, khoá CLIENT, khoá đã thu hồi ⇒ 401 problem+json, không mở stream", async () => {
    for (const key of [undefined, CLIENT_KEY, REVOKED_KEY]) {
      const s = await open(key);
      expect(s.status).toBe(401);
      expect(s.headers.get("content-type")).toContain(
        "application/problem+json",
      );
    }
  });

  it("con trỏ sai dạng ⇒ 400", async () => {
    const s = await open(DEV_KEY, { since: "abc" });
    expect(s.status).toBe(400);
  });
});

describe("luật con trỏ qua HTTP thật", () => {
  it("không con trỏ ⇒ header chống đệm, retry:, rồi snapshot ĐÚNG BẰNG body /sdk/config", async () => {
    const config = await configOf(DEV_KEY).expect(200);
    const s = await open(DEV_KEY);

    expect(s.status).toBe(200);
    expect(s.headers.get("content-type")).toBe("text/event-stream");
    expect(s.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(s.headers.get("x-accel-buffering")).toBe("no");

    const event = await s.next(5_000);
    expect(event.event).toBe("snapshot");
    expect(Number(event.id)).toBe(config.body.configVersion);
    expect(bodyOf<SdkConfigResponse>(event.data)).toEqual(config.body);

    const retry = s.retries[0];
    expect(retry).toBeGreaterThanOrEqual(SSE.retryMs.min);
    expect(retry).toBeLessThanOrEqual(SSE.retryMs.max);
    s.close();
  });

  it("con trỏ = ETag có ngoặc kép, hay dạng W/ ⇒ chỉ header, không event", async () => {
    const etag = (await configOf(DEV_KEY).expect(200)).headers["etag"];
    if (etag === undefined) throw new Error("/sdk/config không trả ETag");
    expect(etag).toMatch(/^"\d+"$/);

    const quoted = await open(DEV_KEY, { since: etag });
    const weak = await open(DEV_KEY, { lastEventId: `W/${etag}` });
    expect([quoted.status, weak.status]).toEqual([200, 200]);
    await quoted.quiet(700);
    await weak.quiet(0);
    quoted.close();
    weak.close();
  });

  it("con trỏ cũ ⇒ snapshot mang version hiện tại", async () => {
    const config = await configOf(DEV_KEY).expect(200);
    const s = await open(DEV_KEY, { since: "0" });
    const event = await s.next(5_000);
    expect(event.event).toBe("snapshot");
    expect(Number(event.id)).toBe(config.body.configVersion);
    s.close();
  });
});

describe("đẩy thay đổi", () => {
  it("chế độ snapshot: ghi rồi một vòng poll ⇒ event snapshot mang version mới", async () => {
    const s = await open(DEV_KEY);
    const first = await s.next(5_000);

    const key = `snap-${randomUUID().slice(0, 8)}`;
    await createFlag(key).expect(201);
    await snapshotWatcher.tick();

    const event = await s.next(5_000);
    expect(event.event).toBe("snapshot");
    const body = bodyOf<SdkConfigResponse>(event.data);
    expect(Number(event.id)).toBe(body.configVersion);
    expect(body.configVersion).toBeGreaterThan(Number(first.id));
    expect(body.flags.map((f) => f.key)).toContain(key);
    s.close();
  });

  it("chế độ delta: flag_changed; áp changes lên snapshot cũ ⇒ đúng configHash (I15c qua dây)", async () => {
    const s = await open(DEV_KEY);
    const held = bodyOf<SdkConfigResponse>((await s.next(5_000)).data);

    await createFlag(`delta-${randomUUID().slice(0, 8)}`).expect(201);
    await deltaWatcher.tick();

    const event = await s.next(5_000);
    expect(event.event).toBe("flag_changed");
    const change = bodyOf<SdkStreamDelta>(event.data);
    expect(change.fromVersion).toBe(held.configVersion);
    expect(Number(event.id)).toBe(change.toVersion);
    expect(JSON.stringify(change)).not.toContain("rolloutSessionId");

    // Áp đúng như provider §6.8: thay entry theo `key`, không đọc lại gì
    let flags = held.flags;
    for (const item of change.changes) {
      expect(item.kind).toBe("flag");
      flags = [...flags.filter((f) => f.key !== item.flag.key), item.flag];
    }
    const applied: Snapshot = {
      flags,
      segments: held.segments,
      trackedFlags: held.trackedFlags,
    };
    expect(configHashOf(applied)).toBe(change.configHash);
    s.close();
  });

  it("I14: khoá dev và prod CÙNG project — thay đổi chỉ ở dev không tới stream prod", async () => {
    const dev = await open(DEV_KEY);
    const prod = await open(PROD_KEY);
    expect(
      bodyOf<SdkConfigResponse>((await dev.next(5_000)).data).environment,
    ).toBe("dev");
    expect(
      bodyOf<SdkConfigResponse>((await prod.next(5_000)).data).environment,
    ).toBe("prod");

    const envConfig = await admin.flagEnvConfig.findFirstOrThrow({
      where: { flagId, environmentId: devEnv },
      select: { id: true },
    });
    await request(app)
      .patch(`/internal/flag-envs/${envConfig.id}`)
      .set("X-Internal-Secret", SECRET)
      .send({ isEnabled: true })
      .expect(200);
    await snapshotWatcher.tick();

    const event = await dev.next(5_000);
    expect(bodyOf<SdkConfigResponse>(event.data).environment).toBe("dev");
    await prod.quiet(1_000);
    dev.close();
    prod.close();
  });

  it("GET mang body rỗng (`Content-Length: 0`): vẫn nhận sự kiện, và client ngắt thì hub trả chỗ", async () => {
    /**
     * Đã đo: GET mang `Content-Type: application/json` VÀ `Content-Length: 0` thì
     * `express.json()` đọc xong body rỗng và `req` bắn `close` sau +1ms, trong khi
     * stream vẫn mở nguyên (`res` chỉ đóng khi client ngắt). Hub nghe `req` thay
     * vì `res` thì hỏng theo MỘT trong hai kiểu, tuỳ nó gắn listener trước hay sau
     * lúc đó:
     *   - trước ⇒ gỡ stream ngay: kết nối còn, nhịp tim còn, không sự kiện nào tới;
     *   - sau — đúng hình dạng hôm nay, vì guard tra khoá mất ~50ms — ⇒ `close` đã
     *     qua, listener không bao giờ chạy: client đi rồi mà stream và chỗ của
     *     khoá bị giữ VĨNH VIỄN, tới lúc khoá chạm trần là 429 mãi.
     * Test này bắt cả hai (đã thử bằng đột biến). Thiếu `Content-Length` thì `req`
     * không bắn sớm và cả hai kiểu đều lọt.
     */
    await waitUntil(
      () => sseHub.size() === 0,
      2_000,
      "stream của test trước chưa được gỡ",
    );
    const s = await open(DEV_KEY, {
      headers: { "Content-Type": "application/json", "Content-Length": "0" },
    });
    await s.next(5_000);
    await sleep(300);

    await createFlag(`json-${randomUUID().slice(0, 8)}`).expect(201);
    await snapshotWatcher.tick();
    expect((await s.next(5_000)).event).toBe("snapshot");
    expect(sseHub.size()).toBe(1);

    s.close();
    await waitUntil(
      () => sseHub.size() === 0,
      2_000,
      "client đã ngắt mà hub vẫn giữ stream — chỗ của khoá bị giữ mãi",
    );
  });
});

describe("thu hồi khoá (§12 T7)", () => {
  it("stream đang mở của khoá bị thu hồi đóng trong ≤ revocationCheckMs", async () => {
    const s = await open(DOOMED_KEY);
    await s.next(5_000);

    const revokedAt = Date.now();
    await admin.sdkKey.update({
      where: { keyHash: sha256(DOOMED_KEY) },
      data: { revokedAt: new Date() },
    });

    const outcome = await Promise.race([
      s.closed.then(() => "closed" as const),
      sleep(SSE.revocationCheckMs + 3_000).then(() => "still-open" as const),
    ]);
    expect(outcome).toBe("closed");
    expect(Date.now() - revokedAt).toBeLessThanOrEqual(
      SSE.revocationCheckMs + 2_000,
    );
  });
});

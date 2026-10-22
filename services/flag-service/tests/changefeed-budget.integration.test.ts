import { randomUUID } from "node:crypto";
import { CHANGE_FEED, CONDITION_LIMITS, env } from "@udp/config";
import { createPrismaClient, type Prisma } from "@udp/db";
import { SDK_STREAM_EVENTS, type SdkStreamDelta } from "@udp/flag-evaluator";
import { createScratchProject } from "@udp/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  postgresChangeFeed,
  TOO_LARGE,
} from "../src/changefeed/change-feed.interface.js";
import { changeOf } from "../src/changefeed/outbox.poller.js";
import { prisma } from "../src/core/db.js";
import { formatEvent } from "../src/sdk/sse.protocol.js";

/**
 * [v4.9] Ngân sách byte của MỘT lô delta (V22, C-02) trên database THẬT.
 *
 * Phần không thể kiểm bằng feed giả nằm đúng ở đây: ngân sách được cưỡng chế
 * TRONG câu lệnh, nên thứ phải đúng là SQL — window function cộng dồn
 * `octet_length(payload::text)`, và `payload` của dòng vượt ngân sách không bao
 * giờ đi qua dây. Đọc bằng client của `udp_s2` (đúng role mà poller chạy), ghi
 * bằng owner.
 *
 * Đây cũng là nửa còn lại của R7-10: `payload` trả về phải là OBJECT như
 * `findMany` (không phải chuỗi JSON), và `configVersion` phải là `number`.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 2,
  cacheKey: `__udp_prisma_cfbudget_${randomUUID()}`,
});

const feed = postgresChangeFeed(prisma);

/** ~3,1 MB mỗi dòng: ba dòng vượt trần 8 MiB, một dòng thì không */
const BIG_USER_IDS = 12_000;
let envId = "";
let dispose: (() => Promise<void>) | undefined;

/** Payload `segment.updated` cỡ thật — `userIds` ở trần độ dài của §2.2 */
const bigSegmentPayload = (seed: string): Prisma.InputJsonValue => ({
  segment: {
    id: randomUUID(),
    all: [],
    userIds: Array.from({ length: BIG_USER_IDS }, (_, i) =>
      `${seed}-${String(i).padStart(6, "0")}`.padEnd(
        CONDITION_LIMITS.userIdMaxLength,
        "x",
      ),
    ),
  },
});

beforeAll(async () => {
  const scratch = await createScratchProject(admin, "cfbudget");
  envId = scratch.environmentId;
  dispose = scratch.dispose;
  await admin.configChangeLog.createMany({
    data: [1, 2, 3].map((version) => ({
      environmentId: envId,
      changeType: "segment.updated",
      configVersion: version,
      payload: bigSegmentPayload(`s${String(version)}`),
    })),
  });
}, 120_000);

afterAll(async () => {
  await dispose?.();
  await admin.$disconnect();
});

describe("deltasSince — ngân sách byte của một lô (V22)", () => {
  it("một dòng trong ngân sách ⇒ trả payload, object như findMany, version là number (R7-10)", async () => {
    const batch = await feed.deltasSince(
      envId,
      0,
      1,
      CHANGE_FEED.maxDeltaBytes,
    );

    expect(batch).not.toBe(TOO_LARGE);
    if (batch === TOO_LARGE) return;
    expect(batch).toHaveLength(1);

    const [row] = batch;
    expect(typeof row?.configVersion).toBe("number");
    expect(row?.configVersion).toBe(1);
    expect(row?.changeType).toBe("segment.updated");
    // OBJECT, không phải chuỗi JSON: poller đọc thẳng `payload.segment`
    const payload = row?.payload as { segment: { userIds: unknown } };
    expect(Array.isArray(payload.segment.userIds)).toBe(true);
    expect(payload.segment.userIds).toHaveLength(BIG_USER_IDS);
  }, 60_000);

  it("ba dòng ~3 MB ⇒ TOO_LARGE, và không payload nào đi qua dây", async () => {
    const batch = await feed.deltasSince(
      envId,
      0,
      100,
      CHANGE_FEED.maxDeltaBytes,
    );
    expect(batch).toBe(TOO_LARGE);
  }, 60_000);

  it("chunk flag_changed của hub luôn ≤ maxDeltaBytes (C-02)", async () => {
    /**
     * Ngân sách được đặt ở feed và KHÔNG kiểm lại ở hub (R8), nên điều phải đúng
     * là bất đẳng thức: một lô lọt ngân sách thì khối `flag_changed` dựng từ nó
     * cũng nằm trong ngân sách. Nó đúng vì `payload::text` của jsonb có khoảng
     * trắng mà `JSON.stringify` không sinh, và phần vỏ event chỉ chừng trăm byte.
     */
    const batch = await feed.deltasSince(
      envId,
      0,
      2,
      CHANGE_FEED.maxDeltaBytes,
    );
    expect(batch).not.toBe(TOO_LARGE);
    if (batch === TOO_LARGE) return;
    expect(batch).toHaveLength(2);

    const changes = batch.map((record) => changeOf(record));
    expect(changes.every((c) => c !== null && typeof c !== "string")).toBe(
      true,
    );

    const data: SdkStreamDelta = {
      fromVersion: 0,
      toVersion: 2,
      configHash: "a".repeat(64),
      changes: changes.filter(
        (c): c is Exclude<typeof c, null | string> =>
          c !== null && typeof c !== "string",
      ),
    };
    const chunk = Buffer.from(
      formatEvent({
        id: data.toVersion,
        name: SDK_STREAM_EVENTS.flagChanged,
        data,
      }),
    );

    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThanOrEqual(CHANGE_FEED.maxDeltaBytes);
  }, 60_000);
});

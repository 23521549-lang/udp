import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { configHashOf, type Snapshot } from "@udp/flag-evaluator";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { stableOwner } from "./helpers/fixture.js";
import { prismaEntryLoader } from "../src/changefeed/snapshot.cache.js";

/**
 * Hợp đồng trên dây của ADR-05.
 *
 * Hai tính chất ở đây là NỀN của cả ba tầng lan truyền, và trước đợt này cả hai
 * đều sai — im lặng, vì chưa có bên thứ hai nào để lộ ra:
 *
 * 1. Thứ đem đi băm phải là thứ SDK NHẬN. `config_hash` là hợp đồng liên tiến
 *    trình: SDK dựng lại snapshot từ delta rồi tính lại hash và so với con số S2
 *    ghi, và I15c nói "cùng từng bit". Snapshot mang một trường không có trên dây
 *    là SDK không bao giờ tính ra được con số đó.
 * 2. `payload` của outbox phải là DELTA, không phải thông báo. §2.2 khai nó là
 *    "delta đầy đủ để replica cập nhật cache mà không phải đọc lại toàn bộ".
 *
 * Snapshot đọc qua `prismaEntryLoader` — ĐÚNG đường production dùng — chứ không
 * gọi thẳng `snapshotOf`. Gọi thẳng là hai truy vấn rời ở mức `ReadCommitted`,
 * nên một lần ghi chen vào giữa cho ra snapshot trộn hai trạng thái và hash lệch
 * với `config_hash`. Khẳng định một tính chất bằng một đường mà production không
 * đi thì test vừa không chứng minh được điều cần, vừa chập chờn dưới tải song
 * song — đã thấy đúng hình dạng đó khi chạy `pnpm -r test`.
 */

const app = createApp();
const SECRET = env.INTERNAL_SERVICE_SECRET;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_wiretest_${randomUUID()}`,
});

/** Đọc `(version, hash, snapshot)` trong MỘT ảnh chụp — y như `/sdk/config` */
const readEntry = prismaEntryLoader(admin);

let projectId: string;
let envId: string;
let envIds: string[];

beforeAll(async () => {
  const owner = await stableOwner(admin);
  const suffix = randomUUID().slice(0, 8);

  const project = await admin.project.create({
    data: {
      ownerId: owner.id,
      name: `wiretest-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-wiretest-${suffix}-dev` },
          { name: "prod", rank: 1, k8sNamespace: `udp-wiretest-${suffix}-prd` },
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
  const first = envIds[0];
  if (first === undefined)
    throw new Error("fixture không tạo được environment");
  envId = first;
});

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (projectId !== undefined) {
    await admin.configChangeLog.deleteMany({
      where: { environmentId: { in: envIds } },
    });
    await admin.project.delete({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

const createFlag = (key: string): request.Test =>
  request(app)
    .post("/internal/flags")
    .set("X-Internal-Secret", SECRET)
    .send({ projectId, key, flagType: "BOOLEAN" });

/** Đúng tập khoá §9 khai cho `SdkConfigResponse.flags[]` và `.rules[]` */
const FLAG_KEYS = [
  "defaultVariantKey",
  "isEnabled",
  "key",
  "rules",
  "stickinessAttribute",
  "type",
  "variants",
];
const RULE_KEYS = [
  "bucketSalt",
  "condition",
  "id",
  "priority",
  "serve",
  "type",
];

describe("snapshot mang ĐÚNG hình dạng dây (§9)", () => {
  it("không có trường nào ngoài tập §9 khai — kể cả id nội bộ", async () => {
    await createFlag(`shape-${randomUUID().slice(0, 8)}`).expect(201);

    const { snapshot } = await readEntry(envId);
    expect(snapshot.flags.length).toBeGreaterThan(0);

    for (const entry of snapshot.flags) {
      if ("archived" in entry) {
        expect(Object.keys(entry).sort()).toEqual(["archived", "key"]);
        continue;
      }

      /**
       * Đây là phép kiểm bắt được lỗi đã có: bản trước mang `variants[].id`,
       * `defaultVariantId` và `envDefaultVariantId` — ba trường không bao giờ
       * rời server (ADR-03, I11), nên SDK không có cách nào dựng lại chúng để
       * tính ra cùng một hash.
       */
      expect(Object.keys(entry).sort()).toEqual(FLAG_KEYS);
      expect(Array.isArray(entry.variants)).toBe(false);

      for (const rule of entry.rules) {
        expect(Object.keys(rule).sort()).toEqual(RULE_KEYS);
        expect(JSON.stringify(rule.serve)).not.toContain("variantId");
      }
    }
  });

  it("snapshot có mặt `segments` và `trackedFlags` — hai trường đi vào hash", async () => {
    const { snapshot } = await readEntry(envId);
    expect(Array.isArray(snapshot.segments)).toBe(true);
    expect(Array.isArray(snapshot.trackedFlags)).toBe(true);
  });
});

describe("config_hash là hash của snapshot trên dây", () => {
  it("hash tính lại từ snapshot khớp con số S2 đã ghi", async () => {
    await createFlag(`hash-${randomUUID().slice(0, 8)}`).expect(201);

    const entry = await readEntry(envId);
    expect(configHashOf(entry.snapshot)).toBe(entry.configHash);
  });
});

describe("payload của outbox là DELTA, không phải thông báo", () => {
  it("áp delta lên snapshot cũ cho ra đúng hash mà S2 ghi cho version mới", async () => {
    /**
     * Đây là I15c thu nhỏ, và là phép thử NGƯỢC của lỗi vừa sửa.
     *
     * Với payload cũ — `{key, flagType}` cho `flag.created` — không có cách nào
     * dựng ra entry đầy đủ: hai UUID variant do server sinh không suy ra được từ
     * payload. Hash tính ra sẽ lệch ở MỌI lần tạo flag, và ba lần lệch liên tiếp
     * là ngắt mạch tầng 2 vĩnh viễn.
     */
    const before = (await readEntry(envId)).snapshot;

    const key = `delta-${randomUUID().slice(0, 8)}`;
    await createFlag(key).expect(201);

    const after = await admin.environment.findUniqueOrThrow({
      where: { id: envId },
      select: { configVersion: true, configHash: true },
    });

    const log = await admin.configChangeLog.findFirstOrThrow({
      where: { environmentId: envId, configVersion: after.configVersion },
      select: { changeType: true, payload: true },
    });
    expect(log.changeType).toBe("flag.created");

    /**
     * Thu hẹp `JsonValue` trước khi ép kiểu, chứ không ép hai lần qua `unknown`:
     * `payload` là JSONB nên kiểu của nó gồm cả mảng và giá trị nguyên thuỷ. Nếu
     * một ngày nào đó delta được ghi ra dưới hình dạng khác, dòng này báo ngay
     * thay vì để `delta.flag` thành `undefined` và mọi assertion bên dưới im lặng
     * so `undefined` với `undefined`.
     */
    const payload = log.payload;
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw new Error(`payload không phải object: ${JSON.stringify(payload)}`);
    }

    /**
     * Qua `unknown` là BẮT BUỘC, không phải lười: `JsonObject` khai giá trị là
     * `JsonValue`, còn `SnapshotEntry` mang `unknown` ở đúng những chỗ ứng với
     * JSONB (`condition`, giá trị variant). Hai kiểu đó không đủ chồng lấn nên
     * `tsc` từ chối ép một nhịp. `shared-types/evaluation.ts` đã gặp và ghi lại
     * đúng hành vi này của TypeScript ở chiều ngược lại.
     */
    const delta = payload as unknown as { flag: Snapshot["flags"][number] };
    expect(delta.flag.key).toBe(key);

    /** Áp delta = thay entry cùng `key`. Không đọc lại gì từ database. */
    const applied: Snapshot = {
      ...before,
      flags: [...before.flags.filter((f) => f.key !== key), delta.flag],
    };

    expect(configHashOf(applied)).toBe(after.configHash);
  });

  it("delta mang đủ variant và default để dựng lại entry", async () => {
    const key = `full-${randomUUID().slice(0, 8)}`;
    await createFlag(key).expect(201);

    const log = await admin.configChangeLog.findFirstOrThrow({
      where: { environmentId: envId, changeType: "flag.created" },
      orderBy: { configVersion: "desc" },
      select: { payload: true },
    });

    const delta = log.payload as { flag: Record<string, unknown> };
    expect(delta.flag["variants"]).toEqual({ on: true, off: false });
    expect(delta.flag["defaultVariantKey"]).toBe("on");
  });
});

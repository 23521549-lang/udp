import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { configHashOf } from "@udp/flag-evaluator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  snapshotFromRow,
  snapshotOf,
  snapshotRowOf,
  snapshotRowSchema,
  trackedStateOf,
  type SnapshotRow,
} from "../src/index.js";

/**
 * Đường nạp snapshot mới (một câu lệnh SQL) so với đường cũ (9 truy vấn Prisma).
 *
 * Hai lớp kiểm, mỗi lớp một câu hỏi:
 *
 * 1. **Golden hash** — oracle thật sự của đợt đổi này. Trước khi xoá code cũ,
 *    `prismaEntryLoader` CŨ đã tính `config_hash` cho một fixture "ác ý" có UUID
 *    cố định (số thập phân, 1e21, số quá 2^53, -0, JSON lồng, chuỗi NFD, hai
 *    rule cùng priority, flag ARCHIVED, flag không có env config, segment rỗng).
 *    Con số đó ghi cứng ở đây. Test tái tạo đúng fixture rồi bắt đường MỚI ra
 *    đúng từng byte. Không có lớp này thì I15c xanh giả bằng cấu trúc: delta và
 *    snapshot đều đi qua mapping mới, cùng lệch thì cùng khớp.
 * 2. **`snapshotFromRow` thuần** — mọi quyết định về hình dạng dây kiểm bằng
 *    fixture, không cần database.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 3,
  cacheKey: `__udp_prisma_snapshotrow_${randomUUID()}`,
});

/** Nạp như bộ nạp cache của S2 làm: một câu lệnh, rồi dựng */
async function readEntry(environmentId: string) {
  const row = await snapshotRowOf(admin, environmentId);
  if (row === undefined) throw new Error("environment không tồn tại");
  return { environmentName: row.name, snapshot: snapshotFromRow(row) };
}

/** UUID cố định — hash phụ thuộc id của rule và segment, nên fixture phải tất định */
const U = (n: number): string =>
  `00000000-0000-4000-8000-00000000e${n.toString(16).padStart(3, "0")}`;

const PROJECT = U(1);
const ENV_DEV = U(2);
const ENV_EMPTY = U(3);

/**
 * Do `prismaEntryLoader` CŨ (commit 596b4a7, 9 truy vấn Prisma) tính bằng
 * `configHashOf` ngày 12/09/2026 trên chính fixture dưới đây. Sửa hai con số này
 * là tuyên bố "hash của mọi environment đang chạy đổi" — SDK sẽ rơi tầng và
 * ngắt mạch ở mọi nơi, nên chỉ được sửa cùng một quyết định có chủ đích như thế.
 */
const GOLDEN_DEV =
  "f44bcc2369dc660991a6920648cf615d02934a1b3ede0153962f69bc736a426c";
const GOLDEN_EMPTY =
  "66eee209a9660bdae3f02531e8f3d315cd4afaa384387ad1bb730c67ea492bed";

beforeAll(async () => {
  const owner = await admin.user.findFirstOrThrow({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  // Lượt trước có thể chết giữa chừng; id cố định nên phải dọn trước khi tạo
  await admin.project.deleteMany({ where: { id: PROJECT } });

  await admin.project.create({
    data: {
      id: PROJECT,
      ownerId: owner.id,
      name: "golden-e8",
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          {
            id: ENV_DEV,
            name: "dev",
            rank: 0,
            k8sNamespace: "udp-golden-e8-dev",
          },
          {
            id: ENV_EMPTY,
            name: "empty",
            rank: 1,
            k8sNamespace: "udp-golden-e8-empty",
          },
        ],
      },
      segments: {
        create: [
          {
            id: U(4),
            name: "beta",
            conditions: [{ attribute: "plan", operator: "eq", value: "beta" }],
          },
          { id: U(5), name: "khong", conditions: [] },
        ],
      },
    },
  });

  const flagA = await admin.featureFlag.create({
    data: {
      id: U(10),
      projectId: PROJECT,
      key: "bien-so",
      flagType: "NUMBER",
      lifecycleStatus: "ACTIVE",
      stickinessAttribute: "userId",
      variants: {
        create: [
          { id: U(11), key: "nho", value: 0.1 },
          { id: U(12), key: "lon", value: 1e21 },
          { id: U(13), key: "qua-53", value: 9007199254740993 },
          { id: U(14), key: "am-khong", value: -0 },
          {
            id: U(15),
            key: "long",
            value: { a: [1, { b: null }], "ký tự": "Việt" },
          },
        ],
      },
    },
  });
  await admin.featureFlag.update({
    where: { id: flagA.id },
    data: { defaultVariantId: U(11) },
  });
  await admin.flagEnvConfig.create({
    data: {
      id: U(20),
      flagId: flagA.id,
      environmentId: ENV_DEV,
      isEnabled: true,
      defaultVariantId: U(12),
      rules: {
        create: [
          {
            id: U(21),
            ruleType: "USER_BASED",
            priority: 1,
            bucketSalt: "salt-1",
            condition: { attribute: "userId", operator: "in", values: ["u1"] },
            serve: { kind: "variant", variantId: U(13) },
          },
          {
            id: U(22),
            ruleType: "ALL",
            priority: 1,
            bucketSalt: "salt-2",
            condition: {},
            serve: {
              kind: "distribution",
              weights: [
                { variantId: U(11), weight: 30000 },
                { variantId: U(12), weight: 70000 },
              ],
            },
          },
        ],
      },
    },
  });

  const flagB = await admin.featureFlag.create({
    data: {
      id: U(30),
      projectId: PROJECT,
      key: "luu-tru",
      flagType: "BOOLEAN",
      lifecycleStatus: "ARCHIVED",
      variants: {
        create: [
          { id: U(31), key: "on", value: true },
          { id: U(32), key: "off", value: false },
        ],
      },
    },
  });
  await admin.featureFlag.update({
    where: { id: flagB.id },
    data: { defaultVariantId: U(32) },
  });

  const flagC = await admin.featureFlag.create({
    data: {
      id: U(40),
      projectId: PROJECT,
      key: "khong-config",
      flagType: "STRING",
      lifecycleStatus: "ACTIVE",
      // Giá trị là "e" + U+0301 (NFD, dấu kết hợp vô hình trong code); canonicalJson chuẩn hoá NFC
      variants: { create: [{ id: U(41), key: "mac-dinh", value: "é" }] },
    },
  });
  await admin.featureFlag.update({
    where: { id: flagC.id },
    data: { defaultVariantId: U(41) },
  });
});

afterAll(async () => {
  await admin.project.deleteMany({ where: { id: PROJECT } });
  await admin.$disconnect();
});

describe("golden hash — đường mới ra đúng từng byte con số đường cũ đã tính", () => {
  it("environment có đủ mọi giá trị biên", async () => {
    const entry = await readEntry(ENV_DEV);
    expect(configHashOf(entry.snapshot)).toBe(GOLDEN_DEV);
    expect(entry.environmentName).toBe("dev");
  });

  it("environment không có env config nào — flag vẫn có mặt, tắt, không rule", async () => {
    const entry = await readEntry(ENV_EMPTY);
    expect(configHashOf(entry.snapshot)).toBe(GOLDEN_EMPTY);
  });

  it("I14 — rule của environment này không rò sang environment kia", async () => {
    const dev = await readEntry(ENV_DEV);
    const empty = await readEntry(ENV_EMPTY);
    const at = (flags: typeof dev.snapshot.flags): number => {
      const f = flags.find((x) => x.key === "bien-so");
      if (f === undefined || "archived" in f) throw new Error("thiếu flag");
      return f.rules.length;
    };
    expect(at(dev.snapshot.flags)).toBe(2);
    expect(at(empty.snapshot.flags)).toBe(0);
  });

  it("environment không tồn tại ⇒ ném, không trả snapshot rỗng", async () => {
    await expect(snapshotOf(admin, randomUUID())).rejects.toThrow(
      /không tồn tại/,
    );
  });
});

describe("trackedFlags [v4.3] — tập tracked đọc trong cùng câu lệnh snapshot", () => {
  /** Chạy trong transaction rồi lùi: fixture golden không bị đổi */
  class Rollback extends Error {}

  it("sắp theo COLLATE \"C\" — trùng phép so của JS ngay cả khi key có dấu '-', và delta là cả tập", async () => {
    // en_US bỏ qua dấu '-' nên sắp "ab" trước "a-c"; JS và COLLATE "C" thì ngược lại
    const keys = ["ab", "a-c"];
    let seen:
      { tracked: string[]; delta: unknown; hashOk: boolean } | undefined;

    await admin
      .$transaction(async (tx) => {
        for (const key of keys) {
          const flag = await tx.featureFlag.create({
            data: {
              projectId: PROJECT,
              key,
              flagType: "BOOLEAN",
              lifecycleStatus: "ACTIVE",
              variants: { create: [{ key: "on", value: true }] },
            },
            select: { id: true, variants: { select: { id: true } } },
          });
          const variantId = flag.variants[0]!.id;
          await tx.featureFlag.update({
            where: { id: flag.id },
            data: { defaultVariantId: variantId },
          });
          const config = await tx.flagEnvConfig.create({
            data: { flagId: flag.id, environmentId: ENV_DEV },
            select: { id: true },
          });
          await tx.$executeRaw`UPDATE flag_env_configs SET is_tracked = true WHERE id = ${config.id}::uuid`;
        }
        const snapshot = await snapshotOf(tx, ENV_DEV);
        const state = await trackedStateOf(tx, ENV_DEV);
        seen = {
          tracked: snapshot.trackedFlags,
          delta: state.delta,
          hashOk: state.configHash === configHashOf(snapshot),
        };
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });

    const jsSorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(seen?.tracked).toEqual(jsSorted);
    expect(seen?.tracked).toEqual(["a-c", "ab"]);
    expect(seen?.delta).toEqual({ trackedFlags: ["a-c", "ab"] });
    expect(seen?.hashOk).toBe(true);
  });

  it("không track gì thì tập rỗng — golden hash ở trên chính là ca này", async () => {
    const snapshot = await snapshotOf(admin, ENV_DEV);
    expect(snapshot.trackedFlags).toEqual([]);
  });
});

/** Hàng tối thiểu hợp lệ để test thuần biến tấu */
const baseRow = (): SnapshotRow => ({
  name: "dev",
  configVersion: 7,
  configHash: "",
  segments: [],
  trackedFlags: [],
  flags: [
    {
      key: "f",
      flagType: "BOOLEAN",
      lifecycleStatus: "ACTIVE",
      stickinessAttribute: "targetingKey",
      defaultVariantId: U(1),
      variants: [
        { id: U(1), key: "on", value: true },
        { id: U(2), key: "off", value: false },
      ],
      envConfig: null,
    },
  ],
});

describe("snapshotFromRow — hình dạng dây quyết định ở hàm thuần", () => {
  it("flag không có env config: tắt, không rule, default của flag", () => {
    const snap = snapshotFromRow(baseRow());
    expect(snap.flags).toEqual([
      {
        key: "f",
        type: "BOOLEAN",
        isEnabled: false,
        stickinessAttribute: "targetingKey",
        variants: { on: true, off: false },
        defaultVariantKey: "on",
        rules: [],
      },
    ]);
    expect(snap.trackedFlags).toEqual([]);
  });

  it("trackedFlags của hàng đi thẳng lên dây, không sắp lại ở JS", () => {
    const row = { ...baseRow(), trackedFlags: ["a-c", "ab"] };
    expect(snapshotFromRow(row).trackedFlags).toEqual(["a-c", "ab"]);
  });

  it("hash phủ trackedFlags — ghim bằng số tính ngày 22/09/2026, thứ tự không đổi hash", () => {
    // I15c: SDK tự tính lại hash, nên con số này là hợp đồng liên tiến trình
    const hashOf = (trackedFlags: string[]): string =>
      configHashOf(snapshotFromRow({ ...baseRow(), trackedFlags }));
    expect(hashOf([])).toBe(
      "df8b06c0faa7f5e60b5b1e282c16b82188abe3e9e6a606edd4dd3420600b74cc",
    );
    expect(hashOf(["a-c", "ab"])).toBe(
      "6dfe07b0c4333a2b6c3106f20d372f2c7fba8aeaf8b43c263daae17305ff26ed",
    );
    expect(hashOf(["ab", "a-c"])).toBe(hashOf(["a-c", "ab"]));
  });

  it("default của environment thắng default của flag", () => {
    const row = baseRow();
    row.flags[0]!.envConfig = {
      isEnabled: true,
      defaultVariantId: U(2),
      rules: [],
    };
    const flag = snapshotFromRow(row).flags[0]!;
    expect("archived" in flag).toBe(false);
    if ("archived" in flag) return;
    expect(flag.defaultVariantKey).toBe("off");
    expect(flag.isEnabled).toBe(true);
  });

  it("ARCHIVED thành bia mộ, không mang gì khác", () => {
    const row = baseRow();
    row.flags[0]!.lifecycleStatus = "ARCHIVED";
    expect(snapshotFromRow(row).flags).toEqual([{ key: "f", archived: true }]);
  });

  it("serve dịch id → key và giữ NGUYÊN thứ tự weights", () => {
    const row = baseRow();
    row.flags[0]!.envConfig = {
      isEnabled: true,
      defaultVariantId: null,
      rules: [
        {
          id: U(9),
          ruleType: "ALL",
          priority: 3,
          bucketSalt: "s",
          condition: {},
          serve: {
            kind: "distribution",
            weights: [
              { variantId: U(2), weight: 70000 },
              { variantId: U(1), weight: 30000 },
            ],
          },
        },
      ],
    };
    const flag = snapshotFromRow(row).flags[0]!;
    if ("archived" in flag) throw new Error("không phải bia mộ");
    expect(flag.rules[0]?.serve).toEqual({
      kind: "distribution",
      weights: [
        { variantKey: "off", weight: 70000 },
        { variantKey: "on", weight: 30000 },
      ],
    });
  });

  it("NÉM khi rule trỏ variant không thuộc flag — hàng rào UDP01 đã bị vượt", () => {
    const row = baseRow();
    row.flags[0]!.envConfig = {
      isEnabled: true,
      defaultVariantId: null,
      rules: [
        {
          id: U(9),
          ruleType: "ALL",
          priority: 1,
          bucketSalt: "s",
          condition: {},
          serve: { kind: "variant", variantId: U(99) },
        },
      ],
    };
    expect(() => snapshotFromRow(row)).toThrow(/UDP01/);
  });

  it("NÉM khi không có variant mặc định ở cả flag lẫn environment", () => {
    const row = baseRow();
    row.flags[0]!.defaultVariantId = null;
    expect(() => snapshotFromRow(row)).toThrow(/variant mặc định/);
  });

  it("NÉM khi conditions của segment không phải mảng", () => {
    const row = baseRow();
    row.segments = [{ id: U(5), conditions: { not: "array" } }];
    expect(() => snapshotFromRow(row)).toThrow(/không phải mảng/);
  });
});

describe("snapshotRowSchema — hàng SQL phải nổ ở đây, không nổ trong SDK", () => {
  it("từ chối hàng thiếu trường hoặc sai kiểu", () => {
    expect(() => snapshotRowSchema.parse({})).toThrow();
    const row = baseRow();
    expect(() =>
      snapshotRowSchema.parse({ ...row, configVersion: "7" }),
    ).toThrow();
    expect(() =>
      snapshotRowSchema.parse({ ...row, flags: [{ key: "f" }] }),
    ).toThrow();
  });

  it("nhận hàng hợp lệ và giữ nguyên giá trị JSON", () => {
    const row = baseRow();
    expect(snapshotRowSchema.parse(row)).toEqual(row);
  });
});

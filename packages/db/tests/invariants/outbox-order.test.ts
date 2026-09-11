import { randomUUID } from "node:crypto";
import {
  CONFIG_CHANGE_CHANNEL,
  parseConfigChangeNotice,
  type ConfigChangeNotice,
} from "@udp/shared-types/change-feed";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient, writeWithOutbox } from "../../src/index.js";
import type { PrismaClient } from "../../src/index.js";
import { openClient } from "../helpers/db.js";

/**
 * Kỷ luật ghi của ADR-05 — bốn bước, và thứ tự là toàn bộ giá trị của nó.
 *
 * Ba tính chất được kiểm ở đây, mỗi cái ứng với một cách hỏng đã biết:
 *
 *   - `config_hash` tính SAU thay đổi. Đặt nó cùng bước với `config_version` là
 *     băm trạng thái cũ, nên hash sai ở MỌI lần ghi; replica so mỗi 60 giây sẽ
 *     lệch liên tục rồi ngắt mạch tầng delta vĩnh viễn.
 *   - Một lần ghi chạm N environment thì cấp N version độc lập, khoá theo thứ
 *     tự tất định để hai lần ghi đồng thời không deadlock.
 *   - Thất bại KHÔNG để lại hổng: version đã cấp trong transaction rollback thì
 *     chưa từng tồn tại (I15b).
 */

const url = process.env["DATABASE_URL_DIRECT"];
if (url === undefined) throw new Error("DATABASE_URL_DIRECT chưa được đặt");

let prisma: PrismaClient;
let projectId: string;
let envIds: string[];

beforeAll(async () => {
  prisma = createPrismaClient({
    connectionString: url,
    max: 3,
    cacheKey: `__udp_prisma_outbox_${randomUUID()}`,
  });

  /**
   * Fixture dựng bằng quyền OWNER, không phải `udp_s2`.
   *
   * Đúng như thực tế: §1.2 không cho S2 tạo project hay environment — nó chỉ
   * được UPDATE hai cột `config_version`/`config_hash`. Việc canh GRANT là của
   * I22; test này canh THỨ TỰ GHI, nên dùng owner để dựng bối cảnh.
   */
  /**
   * User CŨ NHẤT, không phải user bất kỳ: `pnpm -r test` chạy core-backend song
   * song trên cùng database, và nó tạo rồi dọn user tạm. Nhặt nhầm user tạm làm
   * chủ thì project fixture biến mất giữa chừng — xem `flag-service/tests/helpers`.
   */
  const owner = await prisma.user.findFirstOrThrow({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const project = await prisma.project.create({
    data: {
      ownerId: owner.id,
      name: `outbox-${randomUUID().slice(0, 8)}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          {
            name: "dev",
            rank: 0,
            k8sNamespace: `udp-outbox-${randomUUID().slice(0, 8)}-dev`,
          },
          {
            name: "prod",
            rank: 1,
            k8sNamespace: `udp-outbox-${randomUUID().slice(0, 8)}-prod`,
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
   * Tat luat o dung mot dong. TypeScript coi `projectId` la da gan chac chan vi
   * `beforeAll` co gan no — nhung neu chinh `beforeAll` nem (khong noi duoc
   * database, seed thieu) thi `afterAll` VAN chay voi bien chua gan, va bo phep
   * kiem nay di se che mat loi that bang mot TypeError trong buoc don dep.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (projectId !== undefined) {
    await prisma.configChangeLog.deleteMany({
      where: { environmentId: { in: envIds } },
    });
    await prisma.project.delete({ where: { id: projectId } });
  }
  await prisma.$disconnect();
});

describe("ADR-05 — thứ tự bốn bước của outbox writer", () => {
  it("hash được tính SAU thay đổi, không phải cùng lúc với version", async () => {
    const order: string[] = [];

    await writeWithOutbox(prisma, {
      environmentIds: envIds,
      changeType: "flag.created",
      notify: false,
      mutate: async (tx) => {
        order.push("mutate");
        await tx.featureFlag.create({
          data: {
            projectId,
            key: `probe-${randomUUID().slice(0, 8)}`,
            flagType: "BOOLEAN",
          },
        });
      },
      stateOf: (_tx, environmentId) => {
        order.push(`hash:${environmentId.slice(0, 4)}`);
        return Promise.resolve({
          configHash: "a".repeat(64),
          delta: { probe: true },
        });
      },
    });

    // Điều duy nhất test này khẳng định về thứ tự, và là điều plan gốc làm sai:
    // mọi lời gọi hash phải đứng SAU lời gọi mutate.
    expect(order[0]).toBe("mutate");
    expect(order.filter((s) => s.startsWith("hash"))).toHaveLength(
      envIds.length,
    );
  });

  it("mỗi environment nhận đúng một version, và outbox mang đúng số đó", async () => {
    const before = await prisma.environment.findMany({
      where: { id: { in: envIds } },
      select: { id: true, configVersion: true },
      orderBy: { id: "asc" },
    });

    const hash = "b".repeat(64);
    await writeWithOutbox(prisma, {
      environmentIds: envIds,
      changeType: "envconfig.toggled",
      notify: false,
      mutate: () => Promise.resolve(),
      stateOf: (_tx, environmentId) =>
        Promise.resolve({ configHash: hash, delta: { environmentId } }),
    });

    const after = await prisma.environment.findMany({
      where: { id: { in: envIds } },
      select: { id: true, configVersion: true, configHash: true },
      orderBy: { id: "asc" },
    });

    for (const [i, row] of after.entries()) {
      expect(row.configVersion).toBe((before[i]?.configVersion ?? -1) + 1);
      expect(row.configHash).toBe(hash);

      const log = await prisma.configChangeLog.findFirst({
        where: { environmentId: row.id, configVersion: row.configVersion },
        select: { changeType: true },
      });
      expect(log?.changeType).toBe("envconfig.toggled");
    }
  });

  it("thất bại giữa chừng KHÔNG để lại hổng trong config_version", async () => {
    const before = await prisma.environment.findMany({
      where: { id: { in: envIds } },
      select: { id: true, configVersion: true },
      orderBy: { id: "asc" },
    });

    await expect(
      writeWithOutbox(prisma, {
        environmentIds: envIds,
        changeType: "flag.updated",
        notify: false,
        mutate: () => Promise.reject(new Error("hỏng giữa chừng")),
        stateOf: () =>
          Promise.resolve({ configHash: "c".repeat(64), delta: {} }),
      }),
    ).rejects.toThrow("hỏng giữa chừng");

    const after = await prisma.environment.findMany({
      where: { id: { in: envIds } },
      select: { id: true, configVersion: true },
      orderBy: { id: "asc" },
    });

    // Version đã cấp trong một transaction rollback thì chưa từng tồn tại —
    // đó chính là nửa sau của I15b, "không có hổng vĩnh viễn".
    for (const [i, row] of after.entries()) {
      expect(row.configVersion).toBe(before[i]?.configVersion);
    }
  });
});

describe("ADR-05 — không lần ghi nào được lọt khỏi outbox", () => {
  it("danh sách environment rỗng bị TỪ CHỐI — và mutate KHÔNG được chạy", async () => {
    /**
     * Trước chốt này, mảng rỗng vẫn chạy `mutate` mà không khoá, không tăng
     * version, không ghi outbox. Khẳng định `mutate` không chạy mới là thứ quan trọng:
     * chỉ khẳng định "có ném" thì một bản cài đặt ném SAU khi đã ghi cũng qua.
     */
    const calls: string[] = [];

    await expect(
      writeWithOutbox(prisma, {
        environmentIds: [],
        changeType: "flag.updated",
        notify: false,
        mutate: () => {
          calls.push("mutate");
          return Promise.resolve();
        },
        stateOf: () =>
          Promise.resolve({ configHash: "d".repeat(64), delta: {} }),
      }),
    ).rejects.toThrow(/rỗng/);

    expect(calls).toEqual([]);
  });
});

describe("tầng 3 — NOTIFY phát TRONG transaction ghi (ADR-05)", () => {
  /**
   * Bên nghe mở kết nối session riêng — đúng hình dạng kênh LISTEN của Service 2.
   * Lọc theo environment của CHÍNH file này: mọi writer khác trên cùng database
   * cũng phát trên kênh này, và `pnpm -r test` chạy nhiều package song song.
   */
  let listener: Client;
  const notices: ConfigChangeNotice[] = [];

  beforeAll(async () => {
    listener = await openClient();
    listener.on("notification", (message) => {
      const notice =
        message.payload === undefined
          ? null
          : parseConfigChangeNotice(message.payload);
      if (notice !== null && envIds.includes(notice.environmentId)) {
        notices.push(notice);
      }
    });
    await listener.query(
      `LISTEN ${listener.escapeIdentifier(CONFIG_CHANGE_CHANNEL)}`,
    );
  });

  afterAll(async () => {
    // Cùng lý do với afterAll ở trên: beforeAll ném thì listener chưa gán
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    await listener?.end();
  });

  beforeEach(() => {
    notices.length = 0;
  });

  /** Chờ tới khi đủ `expected` notice hoặc hết `waitMs` — notice tới sau commit ~150ms */
  const settle = async (expected: number, waitMs: number): Promise<void> => {
    const deadline = Date.now() + waitMs;
    while (notices.length < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const noop = {
    mutate: () => Promise.resolve(),
    stateOf: () => Promise.resolve({ configHash: "e".repeat(64), delta: {} }),
  };

  it("ghi chạm hai environment ⇒ đúng hai notice, mang đúng version vừa cấp", async () => {
    await writeWithOutbox(prisma, {
      environmentIds: envIds,
      changeType: "envconfig.toggled",
      notify: true,
      ...noop,
    });
    const after = await prisma.environment.findMany({
      where: { id: { in: envIds } },
      select: { id: true, configVersion: true },
    });

    await settle(envIds.length, 3_000);
    // Chờ thêm một nhịp: một notice THỪA cũng là lỗi, không chỉ thiếu
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(
      notices
        .map((n) => `${n.environmentId}:${String(n.configVersion)}`)
        .sort(),
    ).toEqual(after.map((e) => `${e.id}:${String(e.configVersion)}`).sort());
  });

  it("notify: false ⇒ không notice nào — writer tự quyết, không có mặc định ngầm", async () => {
    await writeWithOutbox(prisma, {
      environmentIds: envIds,
      changeType: "envconfig.toggled",
      notify: false,
      ...noop,
    });
    await settle(1, 1_500);
    expect(notices).toEqual([]);
  });

  it("mutate ném ⇒ không notice nào — transaction rollback không đánh thức ai", async () => {
    await expect(
      writeWithOutbox(prisma, {
        environmentIds: envIds,
        changeType: "flag.updated",
        notify: true,
        mutate: () => Promise.reject(new Error("hỏng giữa chừng")),
        stateOf: noop.stateOf,
      }),
    ).rejects.toThrow("hỏng giữa chừng");
    await settle(1, 1_500);
    expect(notices).toEqual([]);
  });
});

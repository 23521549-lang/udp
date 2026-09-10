import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, writeWithOutbox } from "../../src/index.js";
import type { PrismaClient } from "../../src/index.js";

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
  const owner = await prisma.user.findFirstOrThrow({ select: { id: true } });
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

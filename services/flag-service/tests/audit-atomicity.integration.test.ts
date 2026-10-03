import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAudit } from "../src/core/audit.js";
import { writeConfigChange } from "../src/core/outbox.js";
import { stableOwner } from "@udp/test-support";

/**
 * I40 [v4.5] — audit ghi CÙNG transaction với thay đổi nó mô tả.
 *
 * Test qua HTTP không chứng minh được điều này: mọi lỗi nghiệp vụ (409, 422) ném
 * TRƯỚC `recordAudit`, nên audit ghi ngoài transaction cũng cho cùng kết quả. Ở
 * đây một bước SAU hàng audit hỏng (bước tính `config_hash`), và đo trực tiếp:
 * hàng audit phải biến mất cùng thay đổi, `config_version` đứng yên. Chạy dưới
 * role `udp_s2` thật (client của `core/db`), đúng quyền của đường ghi thật.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 2,
  cacheKey: `__udp_prisma_audit_atomicity_${randomUUID()}`,
});

const suffix = randomUUID().slice(0, 8);
let projectId: string | undefined;
let envId: string;
let actorId: string;

beforeAll(async () => {
  actorId = (await stableOwner(admin)).id;
  const project = await admin.project.create({
    data: {
      ownerId: actorId,
      name: `audit-atomicity-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-auditatom-${suffix}` },
        ],
      },
    },
    select: { id: true, environments: { select: { id: true } } },
  });
  projectId = project.id;
  envId = project.environments[0]!.id;
});

afterAll(async () => {
  if (projectId !== undefined) {
    await admin.auditLog.deleteMany({ where: { projectId } });
    await admin.project.delete({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

describe("I40 — audit lùi cùng thay đổi", () => {
  it("bước sau hàng audit hỏng ⇒ không còn hàng audit, config_version đứng yên", async () => {
    const targetId = randomUUID();
    const versionOf = async () =>
      (
        await admin.environment.findUniqueOrThrow({
          where: { id: envId },
          select: { configVersion: true },
        })
      ).configVersion;
    const before = await versionOf();

    await expect(
      writeConfigChange({
        environmentIds: [envId],
        changeType: "flag.updated",
        actorUserId: actorId,
        mutate: async (tx) => {
          await recordAudit(tx, projectId as string, {
            actorUserId: actorId,
            action: "flag.update",
            targetType: "FeatureFlag",
            targetId,
          });
        },
        stateOf: () => {
          throw new Error("hỏng SAU hàng audit");
        },
      }),
    ).rejects.toThrow("hỏng SAU hàng audit");

    expect(await admin.auditLog.count({ where: { targetId } })).toBe(0);
    expect(await versionOf()).toBe(before);
  });

  /**
   * [v4.9] Cùng khuôn, nhưng cho `flag.archive` và `change_type = 'flag.archived'`
   * — ba action mới của V11 đi qua ĐÚNG đường ghi này, nên chốt I40 phải nói về
   * chúng, không chỉ về `flag.update`.
   */
  it("flag.archive lùi cùng thay đổi khi bước sau hỏng", async () => {
    const targetId = randomUUID();
    const versionOf = async () =>
      (
        await admin.environment.findUniqueOrThrow({
          where: { id: envId },
          select: { configVersion: true },
        })
      ).configVersion;
    const before = await versionOf();

    await expect(
      writeConfigChange({
        environmentIds: [envId],
        changeType: "flag.archived",
        actorUserId: actorId,
        mutate: async (tx) => {
          await recordAudit(tx, projectId as string, {
            actorUserId: actorId,
            action: "flag.archive",
            targetType: "FeatureFlag",
            targetId,
          });
        },
        stateOf: () => {
          throw new Error("hỏng SAU hàng audit archive");
        },
      }),
    ).rejects.toThrow("hỏng SAU hàng audit archive");

    expect(await admin.auditLog.count({ where: { targetId } })).toBe(0);
    expect(
      await admin.configChangeLog.count({
        where: { environmentId: envId, changeType: "flag.archived" },
      }),
    ).toBe(0);
    expect(await versionOf()).toBe(before);
  });
});

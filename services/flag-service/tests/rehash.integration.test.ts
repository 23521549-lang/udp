import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { configHashOf } from "@udp/flag-evaluator";
import { snapshotOf } from "@udp/flag-snapshot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { rehashEnvironment } from "../src/changefeed/rehash.js";
import { prisma } from "../src/core/db.js";
import { createActiveFlag, stableOwner } from "@udp/test-support";

/**
 * Script rehash [v4.6] — bước sau migration đổi định dạng snapshot. Chạy dưới
 * `udp_s2` (client của `core/db`) như lúc triển khai: đặt lại mốc `config_hash`
 * bằng đúng hash của snapshot hiện tại, KHÔNG tăng `config_version`.
 */

const app = createApp();
const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 2,
  cacheKey: `__udp_prisma_rehash_${randomUUID()}`,
});
let projectId: string | undefined;
let envId: string;

beforeAll(async () => {
  const actorId = (await stableOwner(admin)).id;
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId: actorId,
      name: `rehash-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [
          { name: "dev", rank: 0, k8sNamespace: `udp-rehash-${suffix}` },
        ],
      },
    },
    select: { id: true, environments: { select: { id: true } } },
  });
  projectId = project.id;
  envId = project.environments[0]?.id ?? "";
  await createActiveFlag(app, actorId, {
    projectId,
    key: `rh-${suffix}`,
    flagType: "BOOLEAN",
  });
});

afterAll(async () => {
  if (projectId !== undefined) {
    await admin.configChangeLog.deleteMany({ where: { environmentId: envId } });
    await admin.auditLog.deleteMany({ where: { projectId } });
    await admin.project.delete({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

describe("rehashEnvironment", () => {
  it("mốc rỗng (sau migration) ⇒ đúng hash của snapshot hiện tại, version đứng yên", async () => {
    await admin.environment.update({
      where: { id: envId },
      data: { configHash: "" },
    });
    const before = await admin.environment.findUniqueOrThrow({
      where: { id: envId },
      select: { configVersion: true },
    });

    const hash = await rehashEnvironment(prisma, envId);

    const after = await admin.environment.findUniqueOrThrow({
      where: { id: envId },
      select: { configVersion: true, configHash: true },
    });
    expect(hash).toBe(configHashOf(await snapshotOf(admin, envId)));
    expect(after).toEqual({
      configVersion: before.configVersion,
      configHash: hash,
    });
  });
});

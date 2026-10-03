import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { stableOwner } from "@udp/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma as s1 } from "../src/core/db.js";
import { sweepProjectTtl } from "../src/jobs/project-ttl.job.js";

/**
 * Lịch TTL (§4.4 lớp 3, Plan #29 AC-5) trên database THẬT, đồng hồ tiêm vào. Chạy bằng
 * `udp_s1` như worker thật: một GRANT thiếu là đỏ ở đây, không ở production.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_ttl_test_admin",
});

const NOW = new Date("2026-10-01T12:00:00Z");
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const created: string[] = [];
let ownerId: string;

async function project(args: {
  expiresAt: Date;
  expiryAction: "WARN" | "TEARDOWN";
  productionDeployed?: boolean;
}): Promise<string> {
  const p = await admin.project.create({
    data: {
      ownerId,
      name: `ttl-${String(created.length)}-${String(Date.now())}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      status: "ACTIVE",
      expiresAt: args.expiresAt,
      expiryAction: args.expiryAction,
      environments: {
        create: [
          {
            name: "production",
            k8sNamespace: `ttl-prod-${String(Date.now())}-${String(created.length)}`,
            isProduction: true,
            rank: 3,
          },
        ],
      },
    },
    select: { id: true, environments: { select: { id: true } } },
  });
  created.push(p.id);
  const envId = p.environments[0]?.id;
  if (args.productionDeployed === true && envId !== undefined) {
    await admin.deploymentEvent.create({
      data: {
        projectId: p.id,
        environmentId: envId,
        deploymentId: p.id,
        eventType: "DEPLOY_SUCCESS",
        triggeredBy: "MANUAL",
      },
    });
  }
  return p.id;
}

const actions = (projectId: string, action: string) =>
  admin.auditLog.findMany({
    where: { projectId, action },
    select: { actorType: true, after: true },
  });

const sweep = () =>
  sweepProjectTtl({
    prisma: s1,
    enqueue: null,
    now: () => NOW,
    only: created,
  });

beforeAll(async () => {
  ownerId = (await stableOwner(admin)).id;
});

afterAll(async () => {
  await admin.deploymentEvent.deleteMany({
    where: { projectId: { in: created } },
  });
  await admin.auditLog.deleteMany({ where: { projectId: { in: created } } });
  await admin.project.deleteMany({ where: { id: { in: created } } });
  await admin.$disconnect();
});

describe("lịch TTL", () => {
  it("còn 20 giờ ⇒ cảnh báo mốc 24 giờ ĐÚNG MỘT LẦN qua hai lượt, actor SYSTEM", async () => {
    const id = await project({
      expiresAt: hoursFromNow(20),
      expiryAction: "WARN",
    });
    await sweep();
    await sweep();
    const warns = await actions(id, "project.ttl.warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      actorType: "SYSTEM",
      after: { threshold: 24 },
    });
  });

  it("quá hạn mà WARN ⇒ ghi hết hạn một lần, KHÔNG xoá", async () => {
    const id = await project({
      expiresAt: hoursFromNow(-2),
      expiryAction: "WARN",
    });
    await sweep();
    await sweep();
    expect(await actions(id, "project.ttl.expired")).toHaveLength(1);
    const row = await admin.project.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    expect(row.status).toBe("ACTIVE");
  });

  it("TEARDOWN nhưng production đã deploy ⇒ bị chặn, ghi lý do, không xoá", async () => {
    const id = await project({
      expiresAt: hoursFromNow(-2),
      expiryAction: "TEARDOWN",
      productionDeployed: true,
    });
    const outcome = await sweep();
    expect(outcome.blocked).toContain(id);
    expect(outcome.tornDown).not.toContain(id);
    expect(await actions(id, "project.ttl.teardown-blocked")).toHaveLength(1);
  });

  it("TEARDOWN không có production đã deploy ⇒ audit TRƯỚC, xoá mềm", async () => {
    const id = await project({
      expiresAt: hoursFromNow(-2),
      expiryAction: "TEARDOWN",
    });
    const outcome = await sweep();
    expect(outcome.tornDown).toContain(id);
    expect(await actions(id, "project.ttl.teardown")).toHaveLength(1);
    const row = await admin.project.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    expect(row.status).toBe("DELETED");
    expect((await sweep()).tornDown).not.toContain(id);
  });
});

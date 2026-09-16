import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claim,
  loadSession,
  releaseLease,
  renewLease,
  setLastDecision,
  updateIfVersion,
} from "../src/rollout-session/repositories.js";
import { s3 } from "./helpers/controller.js";
import {
  admin,
  dropProject,
  newProject,
  newSession,
  newTarget,
  sessionState,
  type Target,
} from "./helpers/fixture.js";

/**
 * Lease và optimistic lock của ADR-05 trên database THẬT, dưới role `udp_s3`
 * thật (I16, I17, I22).
 *
 * Vì sao không mock: ba bảo đảm ở đây (một lease một lúc, 0 hàng khi version
 * lệch, S3 chỉ ghi được đúng cột) đều là hành vi của Postgres — `FOR UPDATE SKIP
 * LOCKED`, `WHERE version = $n`, GRANT theo cột — không phải của mã JS.
 */

let project: Awaited<ReturnType<typeof newProject>>;
let target: Target;

const A = "worker-a";
const B = "worker-b";

/** Lease hết hạn bằng cách lùi `claimed_until` — owner được đổi, S3 thì không cần */
async function expireLease(sessionId: string): Promise<void> {
  await admin.$executeRaw`
    UPDATE rollout_sessions SET claimed_until = now() - interval '1 second'
     WHERE id = ${sessionId}::uuid`;
}

async function finish(sessionId: string): Promise<void> {
  await admin.$executeRaw`
    UPDATE rollout_sessions SET status = 'DONE', claimed_by = NULL, claimed_until = NULL
     WHERE id = ${sessionId}::uuid`;
}

beforeAll(async () => {
  project = await newProject();
  target = await newTarget(project, 0);
});

afterAll(async () => {
  await dropProject(project.projectId);
  await admin.$disconnect();
});

describe("I16 — mỗi session chỉ một worker giữ lease", () => {
  it("claim thứ hai nhận 0 hàng khi lease còn; hết hạn thì worker khác nhận, version tăng", async () => {
    const id = await newSession(target);
    const first = await claim(s3, id, A, 60);
    expect(first?.claimedBy).toBe(A);
    expect(first?.version).toBe(1);

    expect(await claim(s3, id, B, 60)).toBeUndefined();

    expect(await renewLease(s3, id, A, 60)).toBe(true);
    expect(await renewLease(s3, id, B, 60)).toBe(false);

    await expireLease(id);
    expect(await renewLease(s3, id, A, 60)).toBe(false);
    const second = await claim(s3, id, B, 60);
    expect(second?.claimedBy).toBe(B);
    expect(second?.version).toBe(2);

    // Nhả chỉ của chính mình: A nhả không đụng lease của B
    await releaseLease(s3, id, A);
    expect((await sessionState(id)).claimedBy).toBe(B);
    await releaseLease(s3, id, B);
    expect((await sessionState(id)).claimedBy).toBeNull();
    await finish(id);
  });

  it("claim gồm cả PAUSED (I27) nhưng không gồm DONE/FAILED", async () => {
    const paused = await newSession(target, { status: "PAUSED" });
    expect((await claim(s3, paused, A, 60))?.status).toBe("PAUSED");
    await finish(paused);
    expect(await claim(s3, paused, A, 60)).toBeUndefined();
  });
});

describe("I17 — version là fencing token của mọi lần ghi", () => {
  it("updateIfVersion ghi đúng 1 hàng với version đã claim và 0 hàng với version cũ", async () => {
    const id = await newSession(target);
    const row = await claim(s3, id, A, 60);
    if (row === undefined) throw new Error("claim thất bại");

    expect(
      await updateIfVersion(s3, id, row.version, {
        status: "IN_PROGRESS",
        currentTrafficPercentage: 10,
        lastStepAt: new Date(),
      }),
    ).toBe(true);
    const after = await sessionState(id);
    expect(after).toMatchObject({
      status: "IN_PROGRESS",
      currentTrafficPercentage: 10,
      version: row.version + 1,
    });

    // Worker "ngủ quên" mang version cũ ⇒ 0 hàng, database không đổi
    expect(
      await updateIfVersion(s3, id, row.version, { status: "FAILED" }),
    ).toBe(false);
    expect((await sessionState(id)).status).toBe("IN_PROGRESS");
    await finish(id);
  });

  it("setLastDecision chỉ ghi khi lease còn của mình và KHÔNG đẩy version", async () => {
    const id = await newSession(target);
    const row = await claim(s3, id, A, 60);
    if (row === undefined) throw new Error("claim thất bại");
    const decision = {
      decision: "HOLD" as const,
      reason: "test",
      at: Date.now(),
      breach: false,
      breachStreak: 0,
      breachAt: null,
      metricSnapshot: null,
    };
    expect(await setLastDecision(s3, id, B, decision)).toBe(false);
    expect(await setLastDecision(s3, id, A, decision)).toBe(true);
    const loaded = await loadSession(s3, id);
    expect(loaded?.lastDecision?.reason).toBe("test");
    expect(loaded?.version).toBe(row.version);

    await expireLease(id);
    expect(await setLastDecision(s3, id, A, decision)).toBe(false);
    await finish(id);
  });
});

describe("I22 — udp_s3 chỉ ghi được đúng cột đã cấp", () => {
  it("Prisma update() trên rollout_sessions bị 42501 vì @updatedAt — SQL thô là đường duy nhất", async () => {
    const id = await newSession(target);
    await expect(
      s3.rolloutSession.update({
        where: { id },
        data: { status: "IN_PROGRESS" },
      }),
    ).rejects.toThrow(/42501|permission denied/);
    expect((await sessionState(id)).status).toBe("PENDING");
    await finish(id);
  });

  it("udp_s3 không sửa được cấu hình rollout (step_percent) lẫn bảng users", async () => {
    const id = await newSession(target);
    await expect(
      s3.$executeRaw`UPDATE rollout_sessions SET step_percent = 50 WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/permission denied/);
    await expect(s3.$queryRaw`SELECT id FROM users LIMIT 1`).rejects.toThrow(
      /permission denied/,
    );
    await finish(id);
  });
});

import { randomUUID } from "node:crypto";
import { directDatabaseUrl, env } from "@udp/config";
import {
  createPrismaClient,
  DB_TLS_OPTIONS,
  sanitizeConnectionString,
} from "@udp/db";
import { stableOwner } from "@udp/test-support";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUES, startJobQueue, type JobQueue } from "../src/jobs/boss.js";
import { reconcileJobs } from "../src/jobs/reconcile.js";

/**
 * Hàng đợi pg-boss trên database THẬT (Plan #28 AC-2): gửi idempotent theo id, đối soát
 * hai lệch của ADR-02 đk 4, và cờ "lượt cuối" mà worker cần. Schema riêng cho test để không
 * lẫn với schema vận hành.
 */

const SCHEMA = "pgboss_test";
const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_job_queue_test_admin",
});

let queue: JobQueue;
/** Một pg-boss thứ hai, chỉ để test làm điều worker thật làm (fail một job) */
let raw: PgBoss;
let projectId: string;

beforeAll(async () => {
  queue = await startJobQueue({
    connectionString: directDatabaseUrl,
    schema: SCHEMA,
    retryLimit: 0,
    expireInSeconds: 60,
    heartbeatSeconds: 10,
    pollingIntervalSeconds: 0.5,
  });
  raw = new PgBoss({
    connectionString: sanitizeConnectionString(directDatabaseUrl),
    ssl: DB_TLS_OPTIONS,
    schema: SCHEMA,
  });
  raw.on("error", () => undefined);
  await raw.start();
  const owner = await stableOwner(admin);
  projectId = randomUUID();
  await admin.project.create({
    data: {
      id: projectId,
      ownerId: owner.id,
      name: "job queue P28",
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
    },
  });
}, 60_000);

afterAll(async () => {
  await queue.stop();
  await raw.stop({ graceful: false });
  await admin.provisioningJob.deleteMany({ where: { projectId } });
  await admin.project.deleteMany({ where: { id: projectId } });
  await admin.$disconnect();
});

async function job(
  state: "QUEUED" | "CLUSTER",
  ageSeconds = 0,
): Promise<string> {
  // Mỗi phép một job; unique index "một job đang chạy mỗi project" ⇒ dọn trước
  await admin.provisioningJob.deleteMany({ where: { projectId } });
  const id = randomUUID();
  await admin.provisioningJob.create({
    data: { id, projectId, jobType: "PROVISION", state, payload: {} },
  });
  await admin.$executeRaw`
    UPDATE provisioning_jobs
       SET created_at = now() - make_interval(secs => ${ageSeconds})
     WHERE id = ${id}::uuid`;
  return id;
}

describe("gửi job", () => {
  it("gửi hai lần cùng id ⇒ một job pg-boss", async () => {
    const id = randomUUID();
    await queue.enqueueJob(id);
    await queue.enqueueJob(id);
    expect(await raw.findJobs(QUEUES.jobs, { id })).toHaveLength(1);
    expect(await queue.stateOf(id)).toBe("created");
    await raw.deleteJob(QUEUES.jobs, id);
  });
});

describe("đối soát (ADR-02 đk 4)", () => {
  it("hàng QUEUED cũ mà pg-boss chưa từng nhận ⇒ gửi lại; hàng QUEUED mới thì chưa", async () => {
    const fresh = await job("QUEUED", 0);
    let outcome = await reconcileJobs(admin, queue);
    expect(outcome.resent).not.toContain(fresh);

    const old = await job("QUEUED", 120);
    outcome = await reconcileJobs(admin, queue);
    expect(outcome.resent).toContain(old);
    expect(await queue.stateOf(old)).toBe("created");
    await raw.deleteJob(QUEUES.jobs, old);
  });

  it("pg-boss đã bỏ cuộc mà job còn ở CLUSTER, không ai giữ lease ⇒ gửi job BÙ TRỪ, không tự đánh FAILED", async () => {
    const id = await job("CLUSTER");
    await queue.enqueueJob(id);
    const [fetched] = await raw.fetch(QUEUES.jobs);
    expect(fetched?.id).toBe(id);
    await raw.fail(QUEUES.jobs, id);
    expect(await queue.stateOf(id)).toBe("failed");

    const outcome = await reconcileJobs(admin, queue);
    expect(outcome.compensating).toContain(id);
    const compensation = await raw.findJobs(QUEUES.compensate, { key: id });
    expect(compensation).toHaveLength(1);
    const row = await admin.provisioningJob.findUniqueOrThrow({
      where: { id },
      select: { state: true },
    });
    expect(row.state).toBe("CLUSTER");
    await raw.deleteJob(
      QUEUES.compensate,
      compensation.map((c) => c.id),
    );
  });

  it("job đang có lease còn hạn thì đối soát KHÔNG đụng", async () => {
    const id = await job("CLUSTER");
    await admin.$executeRaw`
      UPDATE provisioning_jobs
         SET claimed_by = 'w', claimed_until = now() + interval '5 minutes'
       WHERE id = ${id}::uuid`;
    const outcome = await reconcileJobs(admin, queue);
    expect(outcome.compensating).not.toContain(id);
  });
});

describe("worker nhận việc", () => {
  it("handler nhận đúng jobId; retryLimit 0 ⇒ lượt đầu cũng là lượt CUỐI", async () => {
    const id = randomUUID();
    const seen = new Promise<{ jobId: string; final: boolean }>((resolve) => {
      void queue.workJobs((jobId, attempt) => {
        resolve({ jobId, final: attempt.final });
        return Promise.resolve();
      });
    });
    await queue.enqueueJob(id);
    await expect(seen).resolves.toEqual({ jobId: id, final: true });
  });
});

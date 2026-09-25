import { hostname } from "node:os";
import { directDatabaseUrl, env, JOB_LEASE, JOB_QUEUE } from "@udp/config";
import { assertServiceIdentity, prisma } from "./core/db.js";
import { createApp } from "./app.js";
import { defaultAppDeps } from "./core/app-deps.js";
import { createEgressFetch } from "./core/egress/egress.js";
import { startJobQueue, type JobQueue } from "./jobs/boss.js";
import { sweepDrift } from "./jobs/drift-scan.job.js";
import { createJobKit, type JobKitDeps } from "./jobs/job-kit.js";
import { createJobWorker } from "./jobs/job-worker.js";
import { sweepOrphans } from "./jobs/orphan-scan.job.js";
import { sweepProjectTtl } from "./jobs/project-ttl.job.js";
import { reconcileJobs } from "./jobs/reconcile.js";
import {
  createClusterRuntime,
  egressTransport,
} from "./modules/cluster/cluster-runtime.js";
import { assertRegistryCoveredByCatalog } from "./modules/domain/domain-catalog.sync.js";
import { logger } from "@udp/http";

/**
 * Khẳng định danh tính kết nối TRƯỚC khi mở cổng.
 *
 * Nếu chuỗi kết nối rơi về user owner — quên đặt `DATABASE_URL_S1`, hoặc copy
 * nhầm — thì ma trận writer §1.2 mất hiệu lực hoàn toàn mà không có gì báo:
 * owner có toàn quyền nên mọi GRANT theo cột trở nên vô nghĩa, ứng dụng chạy
 * bình thường, và test vẫn xanh vì chúng dùng `SET ROLE` riêng. Sập lúc boot
 * với một câu rõ ràng là cách duy nhất để chuyện đó không im lặng.
 */
try {
  await assertServiceIdentity();
  logger.info({ role: "udp_s1" }, "Danh tính kết nối database đã xác nhận");
} catch (err) {
  // Bắt để ra MỘT dòng log đọc được, thay vì một unhandled rejection kèm stack
  // mà người trực đêm phải tự dịch.
  logger.fatal({ err }, "Không khởi động: danh tính kết nối database sai");
  process.exit(1);
}

/**
 * [v4.11] Registry Domain Adapter khớp catalog TRƯỚC khi mở cổng (Plan #27 QĐ-2): một
 * adapter khai domain mà catalog không biết (hay đã gỡ) sẽ hiện trên Portal rồi vỡ ở lần
 * ghi `domain_configs` đầu tiên vì khoá ngoại. Sập lúc boot là chỗ đúng để thấy nó.
 */
const deps = defaultAppDeps();
try {
  await assertRegistryCoveredByCatalog(prisma, await deps.domainRegistry());
} catch (err) {
  logger.fatal(
    { err },
    "Không khởi động: registry Domain Adapter lệch catalog",
  );
  process.exit(1);
}

/**
 * [v4.11] Hàng đợi + worker provisioning trong CHÍNH tiến trình này (Plan #28 QĐ-2). Hàng
 * đợi đi qua `DATABASE_URL_DIRECT` (ADR-02 đk 1: pooler transaction mode phá advisory lock);
 * worker ghi nghiệp vụ bằng `udp_s1` như mọi đường khác của Service 1.
 */
async function startJobs(): Promise<JobQueue> {
  const queue = await startJobQueue({
    connectionString: directDatabaseUrl,
    schema: env.PGBOSS_SCHEMA,
    retryLimit: env.JOB_RETRY_LIMIT,
    expireInSeconds: env.JOB_EXPIRE_MINUTES * 60,
    heartbeatSeconds: JOB_LEASE.renewIntervalMs / 1_000,
    pollingIntervalSeconds: JOB_QUEUE.pollingIntervalSeconds,
  });
  const workerDeps: JobKitDeps = {
    prisma,
    platform: deps.cloud,
    domainRegistry: deps.domainRegistry,
    clusters: createClusterRuntime(egressTransport),
    egressFetch: createEgressFetch(),
    workerId: `${hostname()}-${String(process.pid)}`,
    lease: {
      leaseMs: JOB_LEASE.durationSeconds * 1_000,
      renewIntervalMs: JOB_LEASE.renewIntervalMs,
      errorRetryMs: JOB_LEASE.renewErrorRetryMs,
    },
  };
  const worker = createJobWorker(workerDeps);
  const kit = createJobKit(workerDeps);
  await queue.workJobs((jobId, attempt) => worker.run(jobId, attempt));
  await queue.workCompensation((jobId) => worker.compensate(jobId));
  await queue.schedule("reconcile", JOB_QUEUE.reconcileCron, async () => {
    const outcome = await reconcileJobs(prisma, queue);
    if (outcome.resent.length + outcome.compensating.length > 0) {
      logger.warn(outcome, "Đối soát job đã chữa lệch");
    }
  });
  await queue.schedule("projectTtl", JOB_QUEUE.projectTtlCron, async () => {
    const outcome = await sweepProjectTtl({
      prisma,
      enqueue: queue.enqueueJob,
    });
    logger.info(outcome, "Lượt TTL project");
  });
  await queue.schedule("orphanScan", JOB_QUEUE.orphanScanCron, async () => {
    const outcome = await sweepOrphans(kit);
    if (outcome.resolved.length + outcome.unresolved.length > 0) {
      logger.warn(outcome, "Quét hàng sổ CREATING treo");
    }
  });
  await queue.schedule("driftScan", JOB_QUEUE.driftScanCron, async () => {
    const outcome = await sweepDrift(kit);
    logger.info(
      { scanned: outcome.scanned.length, skipped: outcome.skipped },
      "Lượt quét drift",
    );
  });
  return queue;
}

const queue = await startJobs().catch((err: unknown) => {
  logger.fatal({ err }, "Không khởi động: hàng đợi job không lên được");
  process.exit(1);
});

const app = createApp({
  ...deps,
  provisioning: { ...deps.provisioning, enqueue: queue.enqueueJob },
});
const server = app.listen(env.CORE_BACKEND_PORT, () => {
  logger.info(
    { port: env.CORE_BACKEND_PORT, env: env.NODE_ENV },
    "udp-core-backend đã khởi động",
  );
});

/**
 * Tắt êm.
 *
 * Không có phần này, khi Kubernetes gửi SIGTERM lúc rollout, tiến trình chết
 * ngay và những request đang xử lý dở bị đứt giữa chừng — với UDP thì đó có
 * thể là một job provisioning vừa tạo VPC nhưng chưa kịp ghi vào sổ tài nguyên.
 */
const shutdown = (signal: string) => {
  logger.info({ signal }, "Nhận tín hiệu dừng, đang đóng...");

  const forceExit = setTimeout(() => {
    logger.error("Không đóng kịp trong 10 giây, thoát cưỡng bức");
    process.exit(1);
  }, 10_000);

  /**
   * Callback của `server.close` khai kiểu `(err?) => void`. Truyền một hàm
   * `async` vào đó là gửi một Promise cho bên KHÔNG await nó: nếu
   * `$disconnect()` ném lúc tắt máy, đó là một unhandled rejection ngay trong
   * đường tắt êm — vốn là đường phải im lặng nhất.
   */
  server.close(() => {
    // Hàng đợi trước: `stop` êm chờ job đang chạy nhả lease, rồi mới đóng database
    void queue
      .stop()
      .then(() => prisma.$disconnect())
      .catch((err: unknown) => {
        logger.error({ err }, "Lỗi khi đóng kết nối database");
      })
      .finally(() => {
        clearTimeout(forceExit);
        logger.info("Đã đóng sạch");
        process.exit(0);
      });
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

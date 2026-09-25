import { PgBoss, type JobWithMetadata } from "pg-boss";
import { DB_TLS_OPTIONS, sanitizeConnectionString } from "@udp/db";
import { logger } from "@udp/http";

/**
 * Hàng đợi job của Service 1 (ADR-02, §3.1 `jobs/boss.ts`) — MỘT cổng hẹp quanh pg-boss.
 *
 * Năm điều kiện của ADR-02, và chỗ mỗi điều kiện sống:
 *
 *  1. Polling, không LISTEN/NOTIFY (`useListenNotify` mặc định tắt), qua
 *     `DATABASE_URL_DIRECT` — pooler transaction mode làm hỏng LISTEN và advisory lock.
 *  2. Heartbeat của CHÍNH pg-boss (`heartbeatSeconds` của queue: pg-boss tự `touch` trong lúc
 *     handler chạy), không reaper tự viết. `expireInSeconds` là trần cứng của một lượt,
 *     lớn hơn thời gian provisioning dài nhất (`JOB_EXPIRE_MINUTES`).
 *  3. Schema riêng (`PGBOSS_SCHEMA`) — Prisma chỉ quản `public`, không báo drift.
 *  4. `ProvisioningJob` là nguồn sự thật; đối soát ở `reconcile.ts`.
 *  5. Lease + fencing trên `ProvisioningJob` — ở worker, không ở đây.
 *
 * Gửi job KHÔNG đi cùng transaction nghiệp vụ (Plan #28 QĐ-1): hàng `ProvisioningJob`
 * QUEUED là outbox; `id` của job pg-boss = id của hàng, nên gửi lại là không làm gì.
 */

export const QUEUES = {
  /** Mọi `ProvisioningJob` (PROVISION, TEARDOWN, …) — worker rẽ theo `job_type` */
  jobs: "udp-jobs",
  /** Bù trừ một job mà lượt cuối không tự bù được (worker chết) — do đối soát gửi */
  compensate: "udp-compensate",
} as const;

/**
 * Lịch biểu định kỳ — mỗi lịch một hàng riêng của pg-boss (`schedule` + `work`), không
 * `setInterval` tự viết: nhiều bản sao Service 1 thì pg-boss cho đúng MỘT bản chạy mỗi lượt.
 */
export const SCHEDULES = {
  /** Đối soát ProvisioningJob ↔ pg-boss (ADR-02 đk 4) */
  reconcile: "udp-job-reconcile",
  /** TTL của project (§4.4 lớp 3) */
  projectTtl: "udp-project-ttl",
  /** Hàng sổ CREATING treo, tài nguyên mang tag mà sổ không biết (§4.4 lớp 4) */
  orphanScan: "udp-orphan-scan",
  /** Quét drift domain của project ACTIVE (§8.6 nhánh A) */
  driftScan: "udp-drift-scan",
} as const;

export type ScheduleName = keyof typeof SCHEDULES;

export type BossJobState =
  "created" | "retry" | "active" | "completed" | "cancelled" | "failed";

/** Ngữ cảnh một lượt chạy mà worker cần để quyết định nhánh thất bại */
export interface Attempt {
  signal: AbortSignal;
  /** Lượt CUỐI theo `retryLimit` của pg-boss: thất bại ở đây phải bù trừ, không ném để thử lại */
  final: boolean;
}

export interface JobQueue {
  /** Gửi một `ProvisioningJob` sang hàng đợi — idempotent theo id */
  enqueueJob(jobId: string): Promise<void>;
  /** Gửi job bù trừ — idempotent theo `ProvisioningJob` (một job bù trừ đang chờ là đủ) */
  enqueueCompensation(jobId: string): Promise<void>;
  /** Trạng thái của job pg-boss cùng id; `null` = pg-boss chưa từng nhận (hoặc đã dọn) */
  stateOf(jobId: string): Promise<BossJobState | null>;
  workJobs(
    handler: (jobId: string, attempt: Attempt) => Promise<void>,
  ): Promise<void>;
  workCompensation(
    handler: (jobId: string, signal: AbortSignal) => Promise<void>,
  ): Promise<void>;
  /** Một việc định kỳ theo lịch của pg-boss (cron, múi giờ UTC) */
  schedule(
    name: ScheduleName,
    cron: string,
    handler: () => Promise<void>,
  ): Promise<void>;
  stop(): Promise<void>;
}

export interface JobQueueOptions {
  connectionString: string;
  schema: string;
  /** pg-boss `retryLimit` là nguồn sự thật về số lần thử (§2.2: `attempt` chỉ hiển thị) */
  retryLimit: number;
  expireInSeconds: number;
  heartbeatSeconds: number;
  pollingIntervalSeconds: number;
  applicationName?: string;
}

interface ProvisionData {
  jobId: string;
}

export async function startJobQueue(
  options: JobQueueOptions,
): Promise<JobQueue> {
  const boss = new PgBoss({
    /**
     * Cùng đường TLS với mọi kết nối khác của repo (`@udp/db`): gỡ `sslmode` khỏi chuỗi
     * (nó THẮNG object `ssl`) và ghim CA của Supabase — không hạ `rejectUnauthorized`.
     */
    connectionString: sanitizeConnectionString(options.connectionString),
    ssl: DB_TLS_OPTIONS,
    schema: options.schema,
    application_name: options.applicationName ?? "udp-core-backend-jobs",
    max: 4,
  });
  // Không bắt lỗi nền thì một lần rớt kết nối thành unhandled 'error' và giết tiến trình
  boss.on("error", (err: unknown) => {
    logger.error({ err }, "pg-boss lỗi nền");
  });
  await boss.start();
  await boss.createQueue(QUEUES.jobs, {
    retryLimit: options.retryLimit,
    retryBackoff: true,
    retryDelay: 30,
    expireInSeconds: options.expireInSeconds,
    heartbeatSeconds: options.heartbeatSeconds,
  });
  await boss.createQueue(QUEUES.compensate, {
    retryLimit: options.retryLimit,
    retryBackoff: true,
    retryDelay: 30,
    expireInSeconds: options.expireInSeconds,
    heartbeatSeconds: options.heartbeatSeconds,
  });

  return {
    enqueueJob: async (jobId) => {
      await boss.send(QUEUES.jobs, { jobId } satisfies ProvisionData, {
        id: jobId,
      });
    },

    enqueueCompensation: async (jobId) => {
      await boss.send(QUEUES.compensate, { jobId } satisfies ProvisionData, {
        singletonKey: jobId,
      });
    },

    stateOf: async (jobId) => {
      const [job] = await boss.findJobs(QUEUES.jobs, { id: jobId });
      return job?.state ?? null;
    },

    workJobs: async (handler) => {
      await boss.work(
        QUEUES.jobs,
        {
          pollingIntervalSeconds: options.pollingIntervalSeconds,
          localConcurrency: 1,
          includeMetadata: true,
        },
        async ([job]: JobWithMetadata<ProvisionData>[]) => {
          if (job === undefined) return;
          await handler(job.data.jobId, {
            signal: job.signal,
            final: job.retryCount >= job.retryLimit,
          });
        },
      );
    },

    workCompensation: async (handler) => {
      await boss.work<ProvisionData>(
        QUEUES.compensate,
        {
          pollingIntervalSeconds: options.pollingIntervalSeconds,
          localConcurrency: 1,
        },
        async ([job]) => {
          if (job !== undefined) await handler(job.data.jobId, job.signal);
        },
      );
    },

    schedule: async (name, cron, handler) => {
      const queue = SCHEDULES[name];
      // Lượt lỡ không bù: lượt sau quét lại từ đầu trên trạng thái mới nhất
      await boss.createQueue(queue, { retryLimit: 0 });
      await boss.work(
        queue,
        { pollingIntervalSeconds: options.pollingIntervalSeconds },
        async () => {
          await handler();
        },
      );
      await boss.schedule(queue, cron);
    },

    stop: () => boss.stop({ graceful: true }),
  };
}

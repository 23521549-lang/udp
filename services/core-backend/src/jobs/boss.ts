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
  provision: "udp-provision",
  /** Bù trừ một job mà lượt cuối không tự bù được (worker chết) — do đối soát gửi */
  compensate: "udp-compensate",
  reconcile: "udp-job-reconcile",
} as const;

export type BossJobState =
  "created" | "retry" | "active" | "completed" | "cancelled" | "failed";

/** Ngữ cảnh một lượt chạy mà worker cần để quyết định nhánh thất bại */
export interface Attempt {
  signal: AbortSignal;
  /** Lượt CUỐI theo `retryLimit` của pg-boss: thất bại ở đây phải bù trừ, không ném để thử lại */
  final: boolean;
}

export interface JobQueue {
  /** Gửi job PROVISION cho một `ProvisioningJob` — idempotent theo id */
  enqueueProvision(jobId: string): Promise<void>;
  /** Gửi job bù trừ — idempotent theo `ProvisioningJob` (một job bù trừ đang chờ là đủ) */
  enqueueCompensation(jobId: string): Promise<void>;
  /** Trạng thái của job pg-boss cùng id; `null` = pg-boss chưa từng nhận (hoặc đã dọn) */
  stateOf(jobId: string): Promise<BossJobState | null>;
  workProvision(
    handler: (jobId: string, attempt: Attempt) => Promise<void>,
  ): Promise<void>;
  workCompensation(
    handler: (jobId: string, signal: AbortSignal) => Promise<void>,
  ): Promise<void>;
  /** Đối soát định kỳ (ADR-02 đk 4) — lịch của pg-boss, không `setInterval` tự viết */
  scheduleReconcile(cron: string, handler: () => Promise<void>): Promise<void>;
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
  await boss.createQueue(QUEUES.provision, {
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
  await boss.createQueue(QUEUES.reconcile, { retryLimit: 0 });

  return {
    enqueueProvision: async (jobId) => {
      await boss.send(QUEUES.provision, { jobId } satisfies ProvisionData, {
        id: jobId,
      });
    },

    enqueueCompensation: async (jobId) => {
      await boss.send(QUEUES.compensate, { jobId } satisfies ProvisionData, {
        singletonKey: jobId,
      });
    },

    stateOf: async (jobId) => {
      const [job] = await boss.findJobs(QUEUES.provision, { id: jobId });
      return job?.state ?? null;
    },

    workProvision: async (handler) => {
      await boss.work(
        QUEUES.provision,
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

    scheduleReconcile: async (cron, handler) => {
      await boss.work(
        QUEUES.reconcile,
        { pollingIntervalSeconds: options.pollingIntervalSeconds },
        async () => {
          await handler();
        },
      );
      await boss.schedule(QUEUES.reconcile, cron);
    },

    stop: () => boss.stop({ graceful: true }),
  };
}

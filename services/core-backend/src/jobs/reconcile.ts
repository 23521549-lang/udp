import type { PrismaClient } from "@udp/db";
import type { JobQueue } from "./boss.js";

/**
 * Đối soát `ProvisioningJob` ↔ pg-boss (ADR-02 điều kiện 4, §8.1 "Đối soát bắt buộc").
 * `ProvisioningJob` là nguồn sự thật nghiệp vụ; pg-boss chỉ là cơ chế thực thi. Hai lệch
 * có thật, và mỗi lệch một cách chữa:
 *
 *  1. **Hàng QUEUED mà pg-boss chưa từng nhận** — tiến trình chết giữa commit và `send`
 *     (Plan #28 QĐ-1: hàng QUEUED là outbox). Chữa: gửi lại; id trùng là không làm gì.
 *  2. **pg-boss đã bỏ cuộc (`failed`/`cancelled`) mà `ProvisioningJob` chưa kết thúc và
 *     không ai giữ lease** — worker chết ở lượt cuối nên không tự bù trừ được. Đánh
 *     FAILED ngay là bỏ tài nguyên đã tạo lại tiêu tiền. Chữa: gửi job BÙ TRỪ.
 *
 * Đối soát KHÔNG tự đổi `state` của job nào: mọi chuyển trạng thái đi qua worker có lease
 * (fencing), để không có hai bên cùng viết một hàng.
 */

export interface ReconcileOutcome {
  resent: string[];
  compensating: string[];
}

/** Hàng QUEUED trẻ hơn mốc này có thể đang giữa commit và `send` — chưa phải lệch */
export const RESEND_AFTER_MS = 60_000;

const NON_TERMINAL_RUNNING = [
  "NETWORK",
  "CLUSTER",
  "CLUSTER_ACCESS",
  "DOMAINS",
  "CANCEL_REQUESTED",
  "COMPENSATING",
] as const;

export async function reconcileJobs(
  prisma: PrismaClient,
  queue: Pick<JobQueue, "stateOf" | "enqueueJob" | "enqueueCompensation">,
): Promise<ReconcileOutcome> {
  const outcome: ReconcileOutcome = { resent: [], compensating: [] };

  // Mốc thời gian theo đồng hồ của database — cùng thước với lease
  const queued = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM provisioning_jobs
     WHERE state = 'QUEUED'
       AND created_at < now() - make_interval(secs => ${RESEND_AFTER_MS / 1000})`;
  for (const { id } of queued) {
    const state = await queue.stateOf(id);
    if (state === null) {
      await queue.enqueueJob(id);
      outcome.resent.push(id);
    } else if (state === "failed" || state === "cancelled") {
      // Chưa ai chạm tài nguyên nào nhưng pg-boss đã bỏ: bù trừ cũng là đường kết thúc đúng
      await queue.enqueueCompensation(id);
      outcome.compensating.push(id);
    }
  }

  const abandoned = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM provisioning_jobs
     WHERE state::text = ANY(${[...NON_TERMINAL_RUNNING]}::text[])
       AND (claimed_until IS NULL OR claimed_until < now())`;
  for (const { id } of abandoned) {
    const state = await queue.stateOf(id);
    if (state === "failed" || state === "cancelled" || state === null) {
      await queue.enqueueCompensation(id);
      outcome.compensating.push(id);
    }
  }
  return outcome;
}

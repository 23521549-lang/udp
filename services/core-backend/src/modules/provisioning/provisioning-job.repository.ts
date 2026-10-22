import { FenceLostError, type Fence } from "@udp/adapter-core/runner";
import type { JobState, Prisma, PrismaClient } from "@udp/db";

/**
 * [v4.10] Lease + fencing trên `ProvisioningJob` (ADR-02 điều kiện 5).
 *
 * Tình huống thật cần chặn, chép nguyên từ ADR-02: worker A mất kết nối database 5 phút
 * nhưng **vẫn gọi được AWS**; pg-boss giao job cho B; A tỉnh lại và tạo tiếp tài nguyên.
 * Kết quả là hai cluster EKS trên tài khoản BYOC của người dùng, và không có gì trong sổ
 * nói rằng đã có hai.
 *
 * **Hai cơ chế khác nhau, đừng trộn.** `provisioned_resources` KHÔNG có cột `version`,
 * và nó không cần: sổ tài nguyên tự bảo vệ bằng `idempotency_key UNIQUE` cộng máy trạng
 * thái cưỡng chế trong câu `UPDATE` (xem `prisma-ledger.ts`). Fencing bảo vệ **quyền
 * được hành động**: nó là thứ chặn một worker đã mất lease khỏi gọi tiếp lên cloud, chứ
 * không phải thứ chặn hai hàng sổ trùng nhau. Nhầm hai việc này dẫn tới thiết kế thêm
 * một cột `version` vào sổ, và cột đó bảo vệ một thứ đã được bảo vệ rồi.
 */

/** Một lượt giữ job: `version` ở đây chính là fence token */
export interface JobLease {
  jobId: string;
  workerId: string;
  /** `version` tại thời điểm giành được lease — mọi lần ghi sau đều so với số này */
  version: number;
  claimedUntil: Date;
}

export interface ClaimOptions {
  prisma: PrismaClient;
  jobId: string;
  workerId: string;
  /** Độ dài lease; pg-boss `heartbeatSeconds` ≈ 300 nên mặc định khớp nó */
  leaseMs?: number;
}

/** Mặc định khớp `heartbeatSeconds` ≈ 300 của pg-boss (ADR-02 điều kiện 2) */
export const DEFAULT_LEASE_MS = 300_000;

/**
 * Giành lease.
 *
 * Điều kiện `WHERE` có ba nhánh, và cả ba đều cần:
 *
 *  - `claimed_until IS NULL`: job chưa ai giữ.
 *  - `claimed_until < now`: lease cũ đã hết hạn, ai cũng được lấy.
 *  - `claimed_by = workerId`: chính worker này giành lại sau một lần mất kết nối ngắn.
 *    Thiếu nhánh này thì một worker bị ngắt 2 giây phải chờ hết lease của **chính nó**.
 *
 * `version` tăng đúng một, và số MỚI là fence token. Hai worker cùng giành thì Postgres
 * tuần tự hoá, người thứ hai thấy `claimed_until` đã ở tương lai và nhận 0 hàng.
 *
 * [v4.11] Hai điều kiện thêm (Plan #28 QĐ-2):
 *
 *  - **Đồng hồ của DATABASE** (`now()`), không của tiến trình: hai bản sao Service 1 lệch
 *    đồng hồ vài chục giây là hai ý kiến khác nhau về "lease đã hết hạn chưa" — đúng kẽ
 *    hở mà lease sinh ra để đóng. Một thước cho mọi worker là thước của database.
 *  - **Job chưa kết thúc**: giành lease một job `DONE`/`FAILED`/`COMPENSATION_FAILED` là
 *    mời một worker chạy lại provisioning đã xong.
 */
export async function claim(options: ClaimOptions): Promise<JobLease | null> {
  const { prisma, jobId, workerId } = options;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const rows = await prisma.$queryRaw<
    { version: number; claimed_until: Date }[]
  >`
    UPDATE provisioning_jobs
       SET claimed_by = ${workerId},
           claimed_until = now() + make_interval(secs => ${leaseMs / 1000}),
           version = version + 1,
           heartbeat_at = now(),
           updated_at = now()
     WHERE id = ${jobId}::uuid
       AND state NOT IN ('DONE', 'FAILED', 'COMPENSATION_FAILED')
       AND (claimed_until IS NULL OR claimed_until < now() OR claimed_by = ${workerId})
 RETURNING version, claimed_until`;
  const row = rows[0];
  return row === undefined
    ? null
    : {
        jobId,
        workerId,
        version: row.version,
        claimedUntil: row.claimed_until,
      };
}

/**
 * Gia hạn lease, KHÔNG tăng `version`.
 *
 * Tăng `version` ở đây sẽ làm fence token đổi mỗi 30 giây, nên worker phải theo dõi một
 * con số đang trôi và mọi lần `assert()` sau đó phải đọc lại token của chính mình —
 * tức fence không còn phân biệt được "tôi đã mất lease" với "tôi vừa gia hạn".
 *
 * Trả `false` khi không gia hạn được: lease đã bị người khác lấy, hoặc `version` đã đổi.
 * Người gọi coi đó là mất lease, không phải một lần thử lại.
 */
export async function renew(
  prisma: PrismaClient,
  lease: JobLease,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<boolean> {
  /**
   * `claimed_until > now()`: gia hạn một lease ĐÃ hết là giành lại nó mà không qua `claim`
   * — trong khoảnh khắc đó một worker khác có thể vừa giành được (và `version` sẽ chặn nó
   * ở lần ghi kế, nhưng lời gọi cloud giữa hai thời điểm thì không ai chặn).
   */
  const count = await prisma.$executeRaw`
    UPDATE provisioning_jobs
       SET claimed_until = now() + make_interval(secs => ${leaseMs / 1000}),
           heartbeat_at = now()
     WHERE id = ${lease.jobId}::uuid
       AND version = ${lease.version}
       AND claimed_by = ${lease.workerId}
       AND claimed_until > now()`;
  return count === 1;
}

/** Trạng thái kết thúc — không ai giành lease được nữa, và không còn gì để chạy */
export const TERMINAL_STATES: readonly JobState[] = [
  "DONE",
  "FAILED",
  "COMPENSATION_FAILED",
];

/**
 * Trạng thái đang chạy mà người dùng còn hủy được (§9 `POST .../cancel`) — CHỈ của job PROVISION:
 * hủy là nhánh bù trừ hợp tác của nó. [v4.11, Plan #40] Job khác (TEARDOWN, DOMAIN_APPLY,
 * ENVIRONMENT_APPLY) không đọc `CANCEL_REQUESTED`; nhận lệnh hủy rồi chạy tiếp tới cuối là nói dối.
 */
export const CANCELLABLE_STATES: readonly JobState[] = [
  "QUEUED",
  "NETWORK",
  "CLUSTER",
  "CLUSTER_ACCESS",
  "DOMAINS",
];

/** Người dùng đã yêu cầu hủy trong lúc worker đang chạy — nhánh bù trừ, không phải mất lease */
export class JobCancelledError extends Error {
  readonly code = "JOB_CANCELLED";
  constructor(readonly jobId: string) {
    super(`job ${jobId} đã được yêu cầu hủy`);
    this.name = "JobCancelledError";
  }
}

export interface Transition {
  state: JobState;
  lastError?: Prisma.InputJsonValue;
  /** Tiến về phía trước: không được đè một `CANCEL_REQUESTED` vừa ghi */
  forward?: boolean;
  /** Trạng thái kết thúc: nhả lease trong cùng lần ghi */
  release?: boolean;
  /** Ghi nghiệp vụ đi kèm, CÙNG transaction — fencing sai thì không ghi gì cả */
  effects?: (tx: Prisma.TransactionClient) => Promise<void>;
}

/**
 * Đổi `state` của job — mọi lần ghi đều `WHERE version = $expected` (ADR-02 điều kiện 5).
 *
 * `version` tăng một sau mỗi lần đổi state, nên fence token của người gọi **hết giá
 * trị**: đó là chủ ý. Một worker đổi state xong phải dùng token mới; nếu nó tiếp tục
 * dùng token cũ thì lần `assert()` kế tiếp đỏ, và đó đúng là hành vi cần có vì token cũ
 * không còn chứng minh được gì.
 *
 * [v4.11] Ghi nghiệp vụ của một bước (`cluster_access`, trạng thái project, sự kiện deploy)
 * đi cùng transaction với lần đổi state: worker mất lease giữa hai lần ghi là trạng thái
 * nửa vời mà không ai sửa. `forward` chặn đè yêu cầu hủy: hủy không tăng `version` (để
 * không biến thành "mất lease"), nên chính điều kiện `state` mới là thứ giữ nó lại.
 */
export async function transition(
  prisma: PrismaClient,
  lease: JobLease,
  t: Transition,
): Promise<JobLease> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.provisioningJob.updateMany({
      where: {
        id: lease.jobId,
        version: lease.version,
        ...(t.forward === true ? { state: { not: "CANCEL_REQUESTED" } } : {}),
      },
      data: {
        state: t.state,
        version: { increment: 1 },
        ...(t.lastError === undefined ? {} : { lastError: t.lastError }),
        ...(t.release === true ? { claimedBy: null, claimedUntil: null } : {}),
      },
    });
    if (count !== 1) {
      const row = await tx.provisioningJob.findUnique({
        where: { id: lease.jobId },
        select: { version: true, state: true },
      });
      if (row?.version === lease.version && row.state === "CANCEL_REQUESTED") {
        throw new JobCancelledError(lease.jobId);
      }
      throw new FenceLostError(
        `không đổi được job ${lease.jobId} sang ${t.state}: version ${String(lease.version)} đã cũ`,
      );
    }
    await t.effects?.(tx);
    return { ...lease, version: lease.version + 1 };
  });
}

/** Đổi `state` không kèm ghi nào khác; `null` = fencing từ chối */
export async function setState(
  prisma: PrismaClient,
  lease: JobLease,
  state: JobState,
  lastError?: Prisma.InputJsonValue,
): Promise<JobLease | null> {
  try {
    return await transition(prisma, lease, {
      state,
      ...(lastError === undefined ? {} : { lastError }),
    });
  } catch (e) {
    if (e instanceof FenceLostError) return null;
    throw e;
  }
}

/**
 * Yêu cầu hủy — KHÔNG tăng `version`: worker đang giữ lease vẫn là người duy nhất được ghi,
 * nó thấy yêu cầu ở lần chuyển state kế tiếp (hay ở chốt đầu mỗi step) và tự đi nhánh bù
 * trừ. Trả `false` khi job đã qua điểm hủy được (đang bù trừ hay đã kết thúc).
 */
export async function requestCancel(
  prisma: PrismaClient,
  jobId: string,
): Promise<boolean> {
  const { count } = await prisma.provisioningJob.updateMany({
    where: {
      id: jobId,
      jobType: "PROVISION",
      state: { in: [...CANCELLABLE_STATES] },
    },
    data: { state: "CANCEL_REQUESTED" },
  });
  return count === 1;
}

/** Đọc `state` hiện tại — chốt hủy hợp tác của worker */
export async function currentState(
  prisma: PrismaClient,
  jobId: string,
): Promise<JobState | null> {
  const row = await prisma.provisioningJob.findUnique({
    where: { id: jobId },
    select: { state: true },
  });
  return row?.state ?? null;
}

/** Nhả lease — job vẫn giữ `state`, chỉ không còn ai giữ nó */
export async function release(
  prisma: PrismaClient,
  lease: JobLease,
): Promise<boolean> {
  const { count } = await prisma.provisioningJob.updateMany({
    where: { id: lease.jobId, version: lease.version },
    data: { claimedBy: null, claimedUntil: null, version: { increment: 1 } },
  });
  return count === 1;
}

/**
 * Hiện thực cổng `Fence` — điểm crash K9.
 *
 * Nó ĐỌC THẬT mỗi lần, không nhớ kết quả. Một bộ nhớ đệm ở đây, dù chỉ một giây, chính
 * là cái lỗ mà fence sinh ra để bịt: lập luận "lease còn hiệu lực tới `claimed_until`
 * nên trong khoảng đó không cần đọc" giả định không ai cướp lease trước hạn — mà tình
 * huống fence xử lý đúng là tình huống giả định đó vỡ.
 *
 * Giá: runner gọi `assert()` ở sáu chốt mỗi step, tức 6 × 13 = 78 lượt đọc khoá chính
 * cho một lượt provision (≈ 4 s ở RTT 50 ms đã đo ở R24-10). Đó là giá đúng để trả khi
 * cái được bảo vệ là "không tạo cluster EKS thứ hai trên tài khoản của người dùng".
 * Nếu trần thời gian của P10 bị ảnh hưởng, đường sửa là tách project test — không phải
 * làm fence yếu đi.
 */
export function createPrismaFence(
  prisma: PrismaClient,
  lease: JobLease,
): Fence {
  return {
    async assert(): Promise<void> {
      const [row] = await prisma.$queryRaw<
        {
          version: number;
          claimed_by: string | null;
          claimed_until: Date | null;
          alive: boolean;
        }[]
      >`
        SELECT version, claimed_by, claimed_until,
               COALESCE(claimed_until > now(), false) AS alive
          FROM provisioning_jobs
         WHERE id = ${lease.jobId}::uuid`;
      if (row === undefined) {
        throw new FenceLostError(`job ${lease.jobId} không còn tồn tại`);
      }
      if (row.version !== lease.version || row.claimed_by !== lease.workerId) {
        throw new FenceLostError(
          `lease của ${lease.workerId} đã mất: version ${String(lease.version)} → ` +
            `${String(row.version)}, người giữ ${String(row.claimed_by)}`,
        );
      }
      /**
       * HẠN cũng là một điều kiện, không chỉ `version` và người giữ.
       *
       * Thiếu nó, một worker ngủ quá hạn lease của chính mình vẫn đi tiếp gọi cloud, chỉ
       * vì chưa ai kịp giành job. Đó đúng là nửa đầu của kịch bản ADR-02 — A mất kết nối
       * 5 phút nhưng vẫn gọi được AWS — và nửa đó không cần B xuất hiện mới thành lỗi:
       * job đang bỏ ngỏ cho người khác lấy, nên A phải dừng NGAY khi hết hạn, không phải
       * khi có người lấy. Đây là chỗ duy nhất trong hệ thống hỏi câu đó.
       */
      // [v4.11] Hạn so với đồng hồ của DATABASE — cùng thước với `claim` và `renew`
      if (!row.alive) {
        throw new FenceLostError(
          `lease của ${lease.workerId} đã hết hạn lúc ` +
            `${row.claimed_until?.toISOString() ?? "không rõ"}`,
        );
      }
    },
  };
}

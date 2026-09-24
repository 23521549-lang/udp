import { FenceLostError, type Fence } from "@udp/adapter-core/runner";
import type { JobState, PrismaClient } from "@udp/db";

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
  now?: Date;
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
 * `version` tăng đúng một, và số MỚI là fence token. Vì `UPDATE` này lọc theo
 * `version = $expected` ở các hàm dưới chứ không ở đây, chỗ này dùng `updateMany` với
 * điều kiện lease: hai worker cùng giành thì Postgres tuần tự hoá, người thứ hai thấy
 * `claimed_until` đã ở tương lai và nhận 0 hàng.
 */
export async function claim(options: ClaimOptions): Promise<JobLease | null> {
  const { prisma, jobId, workerId } = options;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? new Date();
  const claimedUntil = new Date(now.getTime() + leaseMs);

  const { count } = await prisma.provisioningJob.updateMany({
    where: {
      id: jobId,
      OR: [
        { claimedUntil: null },
        { claimedUntil: { lt: now } },
        { claimedBy: workerId },
      ],
    },
    data: {
      claimedBy: workerId,
      claimedUntil,
      version: { increment: 1 },
      heartbeatAt: now,
    },
  });
  if (count !== 1) return null;

  const row = await prisma.provisioningJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { version: true },
  });
  return { jobId, workerId, version: row.version, claimedUntil };
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
  now = new Date(),
): Promise<boolean> {
  const { count } = await prisma.provisioningJob.updateMany({
    where: {
      id: lease.jobId,
      version: lease.version,
      claimedBy: lease.workerId,
    },
    data: {
      claimedUntil: new Date(now.getTime() + leaseMs),
      heartbeatAt: now,
    },
  });
  return count === 1;
}

/**
 * Đổi `state` của job — mọi lần ghi đều `WHERE version = $expected` (ADR-02 điều kiện 5).
 *
 * `version` tăng một sau mỗi lần đổi state, nên fence token của người gọi **hết giá
 * trị**: đó là chủ ý. Một worker đổi state xong phải dùng token mới; nếu nó tiếp tục
 * dùng token cũ thì lần `assert()` kế tiếp đỏ, và đó đúng là hành vi cần có vì token cũ
 * không còn chứng minh được gì.
 */
export async function setState(
  prisma: PrismaClient,
  lease: JobLease,
  state: JobState,
  lastError?: unknown,
): Promise<JobLease | null> {
  const { count } = await prisma.provisioningJob.updateMany({
    where: { id: lease.jobId, version: lease.version },
    data: {
      state,
      version: { increment: 1 },
      ...(lastError === undefined
        ? {}
        : { lastError: lastError as never }),
    },
  });
  if (count !== 1) return null;
  return { ...lease, version: lease.version + 1 };
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
      const row = await prisma.provisioningJob.findUnique({
        where: { id: lease.jobId },
        select: { version: true, claimedBy: true },
      });
      if (row === null) {
        throw new FenceLostError(
          `job ${lease.jobId} không còn tồn tại`,
        );
      }
      if (row.version !== lease.version || row.claimedBy !== lease.workerId) {
        throw new FenceLostError(
          `lease của ${lease.workerId} đã mất: version ${String(lease.version)} → ` +
            `${String(row.version)}, người giữ ${String(row.claimedBy)}`,
        );
      }
    },
  };
}

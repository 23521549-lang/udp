import { randomUUID } from "node:crypto";
import { FenceLostError } from "@udp/adapter-core/runner";
import { env } from "@udp/config";
import { createPrismaClient, type PrismaClient } from "@udp/db";
import { stableOwner } from "@udp/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma as s1 } from "../src/core/db.js";
import {
  claim,
  createPrismaFence,
  DEFAULT_LEASE_MS,
  release,
  renew,
  setState,
  type JobLease,
} from "../src/modules/provisioning/provisioning-job.repository.js";

/**
 * [v4.10] Lease + fencing trên `ProvisioningJob` — điểm crash K9 của §4.5.
 *
 * Tình huống được kiểm ở đây là tình huống ADR-02 điều kiện 5 viết ra: worker A mất kết
 * nối database nhưng **vẫn gọi được AWS**, pg-boss giao job cho B, A tỉnh lại và tạo
 * tiếp. Mọi phép dưới đây là một mảnh của câu trả lời, và cái đắt nhất nếu thiếu là
 * mảnh cuối: A phải bị chặn ở lần `assert()` kế tiếp, không phải ở một lần ghi nào đó
 * xa hơn.
 *
 * Nối bằng `udp_s1` (không phải owner) vì §1.2 nói Service 1 ghi `provisioning_jobs`, và
 * một phép chạy bằng owner sẽ xanh kể cả khi GRANT thiếu.
 */

const admin: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_lease_test_admin",
});

const PROJECT = "33333333-3333-4333-8333-333333333333";
const WORKER_A = "worker-a";
const WORKER_B = "worker-b";

/** Một job mới cho mỗi phép — `idx_one_active_job_per_project` chỉ cho một job sống */
async function freshJob(): Promise<string> {
  await admin.provisioningJob.deleteMany({ where: { projectId: PROJECT } });
  const job = await admin.provisioningJob.create({
    data: {
      id: randomUUID(),
      projectId: PROJECT,
      jobType: "PROVISION",
      payload: {},
    },
    select: { id: true },
  });
  return job.id;
}

beforeAll(async () => {
  const owner = await stableOwner(admin);
  await admin.provisioningJob.deleteMany({ where: { projectId: PROJECT } });
  await admin.project.deleteMany({ where: { id: PROJECT } });
  await admin.project.create({
    data: {
      id: PROJECT,
      ownerId: owner.id,
      name: "lease fencing P9",
      creationMode: "CREATE_NEW",
      languageRuntime: "node20",
      resourceQuota: {},
    },
  });
});

afterAll(async () => {
  await admin.provisioningJob.deleteMany({ where: { projectId: PROJECT } });
  await admin.project.deleteMany({ where: { id: PROJECT } });
  await admin.$disconnect();
});

describe("lease", () => {
  it("giành được job chưa ai giữ, và version tăng đúng một", async () => {
    const jobId = await freshJob();
    const before = await admin.provisioningJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { version: true },
    });

    const lease = await claim({ prisma: s1, jobId, workerId: WORKER_A });
    expect(lease).not.toBeNull();
    expect((lease as JobLease).version).toBe(before.version + 1);
    expect((lease as JobLease).claimedUntil.getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("worker thứ hai KHÔNG giành được job đang có lease còn hiệu lực", async () => {
    const jobId = await freshJob();
    const first = await claim({ prisma: s1, jobId, workerId: WORKER_A });
    expect(first).not.toBeNull();

    const second = await claim({ prisma: s1, jobId, workerId: WORKER_B });
    expect(second).toBeNull();
  });

  /**
   * Lease HẾT HẠN thì ai cũng lấy được — đây là đường sống của hệ thống.
   *
   * Không có nhánh này, một worker chết hẳn sẽ khoá project vĩnh viễn: job không bao giờ
   * được giao lại, và tài nguyên đã tạo nằm đó tiêu tiền mà không ai dọn được.
   */
  it("lease đã hết hạn thì worker khác giành được", async () => {
    const jobId = await freshJob();
    // Lease 1 ms theo đồng hồ của DATABASE; chờ nó qua hẳn
    const first = await claim({
      prisma: s1,
      jobId,
      workerId: WORKER_A,
      leaseMs: 1,
    });
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 50));

    const second = await claim({ prisma: s1, jobId, workerId: WORKER_B });
    expect(second).not.toBeNull();
    expect((second as JobLease).workerId).toBe(WORKER_B);
  });

  /**
   * Chính worker đó giành lại được lease của mình.
   *
   * Thiếu nhánh này thì một worker bị ngắt kết nối 2 giây phải chờ hết lease của **chính
   * nó** (mặc định 300 giây) trước khi làm tiếp — và trong 300 giây đó không ai khác
   * giành được, nên job chỉ đứng im.
   */
  it("worker đang giữ lease giành lại được lease của chính nó", async () => {
    const jobId = await freshJob();
    const first = await claim({ prisma: s1, jobId, workerId: WORKER_A });
    const again = await claim({ prisma: s1, jobId, workerId: WORKER_A });
    expect(again).not.toBeNull();
    expect((again as JobLease).version).toBe((first as JobLease).version + 1);
  });

  it("gia hạn KHÔNG tăng version — fence token phải đứng yên", async () => {
    const jobId = await freshJob();
    const lease = (await claim({
      prisma: s1,
      jobId,
      workerId: WORKER_A,
    })) as JobLease;

    expect(await renew(s1, lease)).toBe(true);
    const after = await admin.provisioningJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { version: true, claimedUntil: true },
    });
    expect(after.version).toBe(lease.version);
    expect(after.claimedUntil?.getTime()).toBeGreaterThan(
      lease.claimedUntil.getTime() - 1,
    );
  });

  it("gia hạn thất bại khi version đã đổi", async () => {
    const jobId = await freshJob();
    const lease = (await claim({
      prisma: s1,
      jobId,
      workerId: WORKER_A,
    })) as JobLease;
    await claim({ prisma: s1, jobId, workerId: WORKER_A });

    expect(await renew(s1, lease)).toBe(false);
  });
});

describe("[v4.11] đồng hồ database và trạng thái (Plan #28 QĐ-2)", () => {
  it("job đã kết thúc KHÔNG giành được — không chạy lại provisioning đã xong", async () => {
    for (const state of ["DONE", "FAILED", "COMPENSATION_FAILED"] as const) {
      const jobId = await freshJob();
      await admin.provisioningJob.update({
        where: { id: jobId },
        data: { state },
      });
      expect(await claim({ prisma: s1, jobId, workerId: WORKER_A })).toBeNull();
    }
  });

  it("lease đã hết thì không gia hạn được, và fence từ chối", async () => {
    const jobId = await freshJob();
    const lease = (await claim({
      prisma: s1,
      jobId,
      workerId: WORKER_A,
      leaseMs: 1,
    })) as JobLease;
    await new Promise((r) => setTimeout(r, 50));
    expect(await renew(s1, lease)).toBe(false);
    await expect(createPrismaFence(s1, lease).assert()).rejects.toThrow(
      /hết hạn/,
    );
  });
});

describe("fencing", () => {
  it("mọi lần ghi state đều WHERE version = expected, và version tăng", async () => {
    const jobId = await freshJob();
    const lease = (await claim({
      prisma: s1,
      jobId,
      workerId: WORKER_A,
    })) as JobLease;

    const next = await setState(s1, lease, "NETWORK");
    expect(next).not.toBeNull();
    expect((next as JobLease).version).toBe(lease.version + 1);

    /** Token CŨ không ghi được nữa — đây là toàn bộ nội dung của fencing */
    expect(await setState(s1, lease, "CLUSTER")).toBeNull();
    const row = await admin.provisioningJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { state: true },
    });
    expect(row.state).toBe("NETWORK");
  });

  it("assert() im lặng khi lease còn của mình", async () => {
    const jobId = await freshJob();
    const lease = (await claim({
      prisma: s1,
      jobId,
      workerId: WORKER_A,
    })) as JobLease;
    await expect(
      createPrismaFence(s1, lease).assert(),
    ).resolves.toBeUndefined();
  });

  /**
   * Kịch bản ADR-02 nguyên văn, dựng lại từng bước.
   *
   * Đây là phép quan trọng nhất của cả tệp: nó không kiểm một hàm mà kiểm rằng **thứ tự
   * các sự kiện** của điểm crash K9 dẫn tới đúng kết cục. A giữ lease, A "mất kết nối"
   * (không làm gì), lease hết hạn, B giành, và A tỉnh lại — lần `assert()` đầu tiên của
   * A phải ném `FenceLostError`, và nó là lỗi CHÍ TỬ nên runner không bắt.
   */
  it("worker mất lease bị chặn ở lần assert() kế tiếp (K9)", async () => {
    const jobId = await freshJob();
    /** Lease ngắn THẬT, không phải một lease đã hết hạn từ đầu */
    const leaseA = (await claim({
      prisma: s1,
      jobId,
      workerId: WORKER_A,
      leaseMs: 1_500,
    })) as JobLease;

    const fenceA = createPrismaFence(s1, leaseA);

    /** (1) Còn hạn, còn của mình ⇒ đi tiếp */
    await expect(fenceA.assert()).resolves.toBeUndefined();

    /**
     * (2) HẾT HẠN mà CHƯA ai giành ⇒ vẫn phải dừng.
     *
     * Đây là nửa đầu của kịch bản ADR-02, và là nửa dễ bỏ sót: job đang bỏ ngỏ cho người
     * khác lấy, nên A phải dừng ngay khi hết hạn chứ không phải khi có người lấy. Một
     * fence chỉ so `version` sẽ cho A đi tiếp gọi cloud trong suốt khoảng trống này.
     */
    await new Promise<void>((resolve) => setTimeout(resolve, 1_600));
    const stillHolder = await admin.provisioningJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { claimedBy: true, version: true },
    });
    expect(stillHolder.claimedBy).toBe(WORKER_A);
    expect(stillHolder.version).toBe(leaseA.version);
    await expect(fenceA.assert()).rejects.toThrow(FenceLostError);

    /** (3) B giành được vì lease đã hết hạn, và `version` đổi */
    const leaseB = await claim({ prisma: s1, jobId, workerId: WORKER_B });
    expect(leaseB).not.toBeNull();
    expect((leaseB as JobLease).version).toBe(leaseA.version + 1);

    /** (4) A vẫn bị chặn, giờ vì `version` đã đổi chứ không vì hạn */
    await expect(fenceA.assert()).rejects.toThrow(FenceLostError);
  });

  /**
   * Cùng `version` mà KHÁC người giữ cũng là mất lease.
   *
   * Chỉ so `version` là chưa đủ: `release()` rồi một worker khác `claim()` có thể đưa
   * `version` về một số mà token cũ tình cờ khớp. Người giữ là chiều thứ hai, và hai
   * chiều cùng khớp mới là còn quyền.
   */
  it("version khớp mà người giữ khác cũng là mất lease", async () => {
    const jobId = await freshJob();
    const lease = (await claim({
      prisma: s1,
      jobId,
      workerId: WORKER_A,
    })) as JobLease;
    await admin.provisioningJob.update({
      where: { id: jobId },
      data: { claimedBy: WORKER_B },
    });

    await expect(createPrismaFence(s1, lease).assert()).rejects.toThrow(
      FenceLostError,
    );
  });

  it("job đã biến mất thì assert() ném, không trả về im lặng", async () => {
    const jobId = await freshJob();
    const lease = (await claim({
      prisma: s1,
      jobId,
      workerId: WORKER_A,
    })) as JobLease;
    await admin.provisioningJob.delete({ where: { id: jobId } });

    await expect(createPrismaFence(s1, lease).assert()).rejects.toThrow(
      FenceLostError,
    );
  });

  it("nhả lease xong thì worker khác giành được ngay, không cần chờ hết hạn", async () => {
    const jobId = await freshJob();
    const lease = (await claim({
      prisma: s1,
      jobId,
      workerId: WORKER_A,
    })) as JobLease;
    expect(await release(s1, lease)).toBe(true);

    const leaseB = await claim({ prisma: s1, jobId, workerId: WORKER_B });
    expect(leaseB).not.toBeNull();
  });
});

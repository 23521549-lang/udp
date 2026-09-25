import type { Attempt } from "./boss.js";
import { createJobKit, type JobKitDeps } from "./job-kit.js";
import { createProvisionJob } from "./provision.job.js";
import { createTeardownJob } from "./teardown.job.js";

/**
 * Worker của MỌI `ProvisioningJob` (Plan #29 QĐ-4): một hàng đợi, một đối soát, một lease;
 * rẽ theo `job_type`. Loại chưa có worker là lỗi lắp ráp — không đường nào tạo được hàng
 * `DOMAIN_APPLY` trước khi nó có worker (Plan #30).
 */
export interface JobWorker {
  run(jobId: string, attempt: Pick<Attempt, "final">): Promise<void>;
  /** Đối soát gửi: bù trừ PROVISION dở dang, hay dọn tiếp TEARDOWN dở dang */
  compensate(jobId: string): Promise<void>;
}

export function createJobWorker(deps: JobKitDeps): JobWorker {
  const kit = createJobKit(deps);
  const provision = createProvisionJob(kit);
  const teardown = createTeardownJob(kit);

  const typeOf = async (jobId: string) =>
    (
      await deps.prisma.provisioningJob.findUnique({
        where: { id: jobId },
        select: { jobType: true },
      })
    )?.jobType ?? null;

  const unsupported = (type: string): Promise<never> =>
    Promise.reject(new Error(`chưa có worker cho job ${type}`));

  return {
    run: async (jobId, attempt) => {
      const type = await typeOf(jobId);
      switch (type) {
        case null:
          return;
        case "PROVISION":
          return provision.run(jobId, attempt);
        case "TEARDOWN":
          return teardown.run(jobId);
        case "DOMAIN_APPLY":
          return unsupported(type);
      }
    },
    compensate: async (jobId) => {
      const type = await typeOf(jobId);
      switch (type) {
        case null:
          return;
        case "PROVISION":
          return provision.compensate(jobId);
        case "TEARDOWN":
          return teardown.run(jobId);
        case "DOMAIN_APPLY":
          return unsupported(type);
      }
    },
  };
}

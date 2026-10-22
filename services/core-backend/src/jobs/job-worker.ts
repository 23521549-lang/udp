import type { Attempt } from "./boss.js";
import { createDomainApplyJob } from "./domain-apply.job.js";
import { createEnvironmentApplyJob } from "./environment-apply.job.js";
import { createJobKit, type JobKitDeps } from "./job-kit.js";
import { createProvisionJob } from "./provision.job.js";
import { createTeardownJob } from "./teardown.job.js";

/**
 * Worker của MỌI `ProvisioningJob` (Plan #29 QĐ-4): một hàng đợi, một đối soát, một lease;
 * rẽ theo `job_type`. `DOMAIN_APPLY` và [v4.11] `ENVIRONMENT_APPLY` không tạo tài nguyên cloud nên
 * "bù trừ" của chúng chính là chạy lại tới trạng thái đích — việc áp là idempotent.
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
  const domainApply = createDomainApplyJob(kit);
  const environmentApply = createEnvironmentApplyJob(kit);

  const typeOf = async (jobId: string) =>
    (
      await deps.prisma.provisioningJob.findUnique({
        where: { id: jobId },
        select: { jobType: true },
      })
    )?.jobType ?? null;

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
          return domainApply.run(jobId);
        case "ENVIRONMENT_APPLY":
          return environmentApply.run(jobId);
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
          return domainApply.run(jobId);
        case "ENVIRONMENT_APPLY":
          return environmentApply.run(jobId);
      }
    },
  };
}

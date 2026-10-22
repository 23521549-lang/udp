import type { Request } from "express";
import { uniqueViolationIndexOf, type Prisma } from "@udp/db";
import { ConflictError, logger, NotFoundError } from "@udp/http";
import { ENVIRONMENT_ERROR_SLUGS } from "@udp/shared-types/environment-api";
import { PROVISION_ERROR_SLUGS } from "@udp/shared-types/provisioning-api";
import type { ProvisioningJobWire } from "@udp/shared-types/wire";
import { prisma } from "../../core/db.js";
import { auditEntry } from "../audit/audit.service.js";
import type { PublicEnvironment } from "../project/project.types.js";
import {
  jobView,
  JOB_SELECT,
  type EnqueueJob,
} from "../provisioning/provisioning.service.js";
import {
  environmentApplyPayloadSchema,
  type EnvironmentApplyPayload,
} from "./environment-apply.payload.js";

/**
 * Job `ENVIRONMENT_APPLY` phía request (Plan #40 QĐ-6, QĐ-8): hàng job là outbox (Plan #28 QĐ-1)
 * — ghi TRONG transaction của thay đổi nó mang, gửi sang hàng đợi SAU commit; hỏng lúc gửi thì
 * đối soát gửi lại hàng QUEUED.
 */

const ACTIVE_JOB_INDEX = "idx_one_active_job_per_project";

/** Project đang có job khác chạy — cùng một câu cho kiểm trước và cho đua ở unique index */
export const projectBusy = (): ConflictError =>
  new ConflictError(
    "Project đang có một lượt triển khai chạy — thử lại khi lượt đó xong",
  ).withTypeSlug(ENVIRONMENT_ERROR_SLUGS.projectBusy);

/** Job mới trên hàng đợi đầu vào, mang hạ tầng của lượt PROVISION đã xong gần nhất */
export async function createEnvironmentJob(
  tx: Prisma.TransactionClient,
  projectId: string,
  change: EnvironmentApplyPayload["change"],
  request: Request,
) {
  const source = await tx.provisioningJob.findFirst({
    where: { projectId, jobType: "PROVISION", state: "DONE" },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  if (source === null) {
    throw new ConflictError("Project chưa có lượt triển khai nào hoàn tất");
  }
  const job = await tx.provisioningJob.create({
    data: {
      projectId,
      jobType: "ENVIRONMENT_APPLY",
      payload: { infra: source.payload, change },
    },
    select: JOB_SELECT,
  });
  await tx.auditLog.create({
    data: {
      ...auditEntry({
        action: `environment.apply.${change.action.toLowerCase()}`,
        targetType: "ProvisioningJob",
        targetId: job.id,
        after: { environment: change.environment.name },
        request,
      }),
      projectId,
    },
  });
  return job;
}

/** Đua ở unique index "một job sống mỗi project" ⇒ cùng 409 như phép kiểm trước */
export function busyOnRace(e: unknown): never {
  if (uniqueViolationIndexOf(e) === ACTIVE_JOB_INDEX) throw projectBusy();
  throw e;
}

export async function sendJob(
  enqueue: EnqueueJob,
  jobId: string,
): Promise<void> {
  if (enqueue === null) return;
  await enqueue(jobId).catch((err: unknown) => {
    logger.warn(
      { err, jobId },
      "Chưa gửi được job ENVIRONMENT_APPLY sang hàng đợi",
    );
  });
}

export const snapshotOf = (
  environment: PublicEnvironment,
): EnvironmentApplyPayload["change"]["environment"] => ({
  id: environment.id,
  name: environment.name,
  k8sNamespace: environment.k8sNamespace,
  isProduction: environment.isProduction,
});

/**
 * `POST /projects/:id/jobs/:jobId/retry` (QĐ-8): CHỈ `ENVIRONMENT_APPLY` đã `FAILED` — job mới
 * cùng payload, vì job idempotent. PROVISION thử lại bằng `POST /provision`, DOMAIN_APPLY bằng
 * `PUT /domains` (D-P19 giữ nguyên). ADD mà environment đã bị xoá ⇒ không còn gì để dựng.
 */
export async function retryEnvironmentJob(
  enqueue: EnqueueJob,
  projectId: string,
  jobId: string,
  request: Request,
): Promise<ProvisioningJobWire> {
  const failed = await prisma.provisioningJob.findFirst({
    where: { id: jobId, projectId },
    select: { jobType: true, state: true, payload: true },
  });
  if (failed === null) throw new NotFoundError("Không tìm thấy job");
  if (failed.jobType !== "ENVIRONMENT_APPLY" || failed.state !== "FAILED") {
    throw new ConflictError(
      "Chỉ thử lại được job ENVIRONMENT_APPLY đã thất bại",
    ).withTypeSlug(PROVISION_ERROR_SLUGS.notRetryable);
  }
  const { change } = environmentApplyPayloadSchema.parse(failed.payload);
  if (change.action === "ADD") {
    const alive = await prisma.environment.count({
      where: { id: change.environment.id, projectId },
    });
    if (alive === 0) {
      throw new ConflictError(
        `Environment ${change.environment.name} đã bị xoá — không còn gì để dựng`,
      ).withTypeSlug(PROVISION_ERROR_SLUGS.notRetryable);
    }
  }
  const job = await prisma
    .$transaction((tx) => createEnvironmentJob(tx, projectId, change, request))
    .catch(busyOnRace);
  await sendJob(enqueue, job.id);
  return jobView(job);
}

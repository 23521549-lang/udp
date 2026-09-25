import type { Request } from "express";
import { ACTIVE_ROLLOUT_STATUSES } from "@udp/config";
import type { Prisma } from "@udp/db";
import {
  ConfirmationRequiredError,
  ConflictError,
  logger,
  NotFoundError,
} from "@udp/http";
import {
  DOMAIN_ERROR_SLUGS,
  type DomainUpgradeBody,
  type PutDomainsBody,
} from "@udp/shared-types/domain-api";
import type { ProvisioningJobWire } from "@udp/shared-types/wire";
import { prisma } from "../../core/db.js";
import { auditEntry } from "../audit/audit.service.js";
import {
  jobView,
  JOB_SELECT,
  type EnqueueJob,
} from "../provisioning/provisioning.service.js";
import type { DomainApplyPayload } from "./domain-apply.payload.js";
import type { DomainAdapterRegistry } from "./domain-adapter.registry.js";
import type { ResolvedTarget } from "./domain-target.js";

/**
 * Tạo job `DOMAIN_APPLY` cho project ĐANG chạy (§8.2, §8.6, Plan #30 P3). Job chạy ở worker;
 * ở đây chỉ ghi hàng job (outbox, Plan #28 QĐ-1) trong CÙNG transaction với thứ nó thay
 * đổi, rồi gửi sang hàng đợi sau commit.
 */

/** Hạ tầng của lượt PROVISION đã xong gần nhất — worker cần nó để chạm cluster */
async function infraOf(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<Prisma.InputJsonValue> {
  const source = await tx.provisioningJob.findFirst({
    where: { projectId, jobType: "PROVISION", state: "DONE" },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  if (source === null) {
    throw new ConflictError(
      "Project chưa có lượt triển khai nào hoàn tất",
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.notRunning);
  }
  return source.payload as Prisma.InputJsonValue;
}

async function createApplyJob(
  tx: Prisma.TransactionClient,
  projectId: string,
  change: DomainApplyPayload["change"],
  audit: { action: string; after: Prisma.InputJsonValue; request: Request },
) {
  const job = await tx.provisioningJob.create({
    data: {
      projectId,
      jobType: "DOMAIN_APPLY",
      payload: {
        infra: await infraOf(tx, projectId),
        // Cấu hình tool đến từ body JSON đã qua configSchema: ép ở đúng biên ghi này
        change: change as Prisma.InputJsonValue,
      },
    },
    select: JOB_SELECT,
  });
  await tx.auditLog.create({
    data: {
      ...auditEntry({
        action: audit.action,
        targetType: "ProvisioningJob",
        targetId: job.id,
        after: audit.after,
        request: audit.request,
      }),
      projectId,
    },
  });
  return job;
}

async function send(enqueue: EnqueueJob, jobId: string): Promise<void> {
  if (enqueue === null) return;
  // Hỏng ở đây không mất job: đối soát gửi lại hàng QUEUED (Plan #28 QĐ-1)
  await enqueue(jobId).catch((err: unknown) => {
    logger.warn({ err, jobId }, "Chưa gửi được job DOMAIN_APPLY sang hàng đợi");
  });
}

/**
 * Trạng thái đích cho project ACTIVE ⇒ job. `domain_set_version` tăng cùng lệnh tạo job, có
 * điều kiện theo khoá người gọi đang cầm; unique index một job sống cho mỗi project chặn
 * hai lần áp đua nhau (409). Trả `"stale-version"` khi khoá đã cũ.
 */
export async function applyToRunning(args: {
  projectId: string;
  body: PutDomainsBody;
  targets: readonly ResolvedTarget[];
  request: Request;
  enqueue: EnqueueJob;
}): Promise<ProvisioningJobWire | "stale-version"> {
  const { projectId, body } = args;
  const job = await prisma.$transaction(async (tx) => {
    const bumped = await tx.project.updateMany({
      where: {
        id: projectId,
        status: "ACTIVE",
        domainSetVersion: body.lastKnownDomainSetVersion,
      },
      data: { domainSetVersion: { increment: 1 } },
    });
    if (bumped.count === 0) return null;
    return createApplyJob(
      tx,
      projectId,
      {
        kind: "apply",
        target: {
          domains: args.targets.map((t) => ({
            domainType: t.domainType,
            toolId: t.adapter.toolId,
            config: t.config,
          })),
          preferences: body.preferences,
        },
      },
      {
        action: "domain.config.apply",
        after: {
          enabled: args.targets.map(
            (t) => `${t.domainType}:${t.adapter.toolId}`,
          ),
          preferences: body.preferences,
        },
        request: args.request,
      },
    );
  });
  if (job === null) return "stale-version";
  await send(args.enqueue, job.id);
  return jobView(job);
}

/**
 * Nâng một domain đang chạy lên bản adapter mà máy chủ đang nạp (§8.6 nhánh B). Kiểm ở
 * đây những gì trả lời được mà không chạm cluster; validator và healthcheck chạy ở worker.
 */
export async function requestUpgrade(args: {
  projectId: string;
  domainType: string;
  body: DomainUpgradeBody;
  request: Request;
  registry: DomainAdapterRegistry;
  enqueue: EnqueueJob;
}): Promise<ProvisioningJobWire> {
  const { projectId, domainType } = args;
  const [project, row, rollouts] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: {
        status: true,
        environments: { select: { isProduction: true } },
      },
    }),
    prisma.domainConfig.findUnique({
      where: { projectId_domainType: { projectId, domainType } },
      select: {
        isEnabled: true,
        selectedTool: true,
        adapterVersion: true,
        domainStatus: true,
      },
    }),
    prisma.rolloutSession.count({
      where: { projectId, status: { in: [...ACTIVE_ROLLOUT_STATUSES] } },
    }),
  ]);
  if (project === null) throw new NotFoundError("Không tìm thấy project");
  const adapter =
    row?.selectedTool == null
      ? undefined
      : args.registry.get(domainType, row.selectedTool);
  if (
    project.status !== "ACTIVE" ||
    row === null ||
    !row.isEnabled ||
    row.domainStatus !== "ACTIVE" ||
    adapter === undefined
  ) {
    throw new ConflictError(
      `Domain ${domainType} không chạy trên cluster của project`,
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.notRunning);
  }
  if (row.adapterVersion === adapter.version) {
    throw new ConflictError(
      `Domain ${domainType} đã ở bản ${adapter.version}`,
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.upToDate);
  }
  // §8.6: đổi nguồn metric giữa lúc canary đang so hai cửa sổ là mất hệ quy chiếu
  if (rollouts > 0) {
    throw new ConflictError(
      "Project có rollout đang chạy — nâng cấp sau khi rollout kết thúc",
      undefined,
      "ROLLOUT_IN_PROGRESS",
    );
  }
  if (
    project.environments.some((e) => e.isProduction) &&
    args.body.confirm !== domainType
  ) {
    throw new ConfirmationRequiredError(
      `Nâng cấp chạm environment production: gõ ${domainType} để xác nhận`,
    );
  }

  const job = await prisma.$transaction((tx) =>
    createApplyJob(
      tx,
      projectId,
      { kind: "upgrade", domainType },
      {
        action: "domain.upgrade",
        after: {
          domainType,
          from: row.adapterVersion,
          to: adapter.version,
        },
        request: args.request,
      },
    ),
  );
  await send(args.enqueue, job.id);
  return jobView(job);
}

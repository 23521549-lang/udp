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
  type DomainRetryBody,
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

/** Thứ mọi thao tác Day-2 trên MỘT domain cần đọc — một lượt đi về, ba câu song song */
async function day2Of(
  projectId: string,
  domainType: string,
  registry: DomainAdapterRegistry,
) {
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
      : registry.get(domainType, row.selectedTool);
  if (
    project.status !== "ACTIVE" ||
    row === null ||
    !row.isEnabled ||
    adapter === undefined
  ) {
    throw new ConflictError(
      `Domain ${domainType} không chạy trên cluster của project`,
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.notRunning);
  }
  return { project, row, adapter, rollouts };
}

/** §8.6: đổi nguồn metric hay đường traffic giữa lúc canary đang so hai cửa sổ là mất hệ quy chiếu */
function assertNoLiveRollout(liveRollouts: number, what: string): void {
  if (liveRollouts > 0) {
    throw new ConflictError(
      `Project có rollout đang chạy — ${what} sau khi rollout kết thúc`,
      undefined,
      "ROLLOUT_IN_PROGRESS",
    );
  }
}

/** Chạm cluster dùng chung MỌI environment: có production thì gõ lại tên domain (428, §8.4) */
function requireProductionConfirm(
  environments: readonly { isProduction: boolean }[],
  confirm: string | undefined,
  domainType: string,
  what: string,
): void {
  if (environments.some((e) => e.isProduction) && confirm !== domainType) {
    throw new ConfirmationRequiredError(
      `${what} chạm environment production: gõ ${domainType} để xác nhận`,
    );
  }
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
  const { project, row, adapter, rollouts } = await day2Of(
    projectId,
    domainType,
    args.registry,
  );
  if (row.domainStatus !== "ACTIVE") {
    throw new ConflictError(
      `Domain ${domainType} không chạy trên cluster của project`,
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.notRunning);
  }
  if (row.adapterVersion === adapter.version) {
    throw new ConflictError(
      `Domain ${domainType} đã ở bản ${adapter.version}`,
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.upToDate);
  }
  // [Plan #45] Người dùng nâng lên bản họ đã thấy, không phải bản máy chủ vừa đổi sau đó
  if (
    args.body.toVersion !== undefined &&
    args.body.toVersion !== adapter.version
  ) {
    throw new ConflictError(
      `Máy chủ đang nạp bản ${adapter.version} của ${domainType}, không phải ${args.body.toVersion} — mở lại hộp nâng cấp`,
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.versionUnavailable);
  }
  assertNoLiveRollout(rollouts, "nâng cấp");
  requireProductionConfirm(
    project.environments,
    args.body.confirm,
    domainType,
    "Nâng cấp",
  );

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

/**
 * [v4.11, Plan #45] Áp lại MỘT domain về cấu hình đang lưu (§9 `POST …/retry`, QĐ-1 của
 * `plan45-spec.md`): domain ERROR/BLOCKED sau một lượt hỏng, hay domain đã trôi mà người vận
 * hành chọn ghi đè (§10.13). Không tự sửa drift (§8.6) — đây là lựa chọn có xác nhận.
 */
export async function requestReapply(args: {
  projectId: string;
  domainType: string;
  body: DomainRetryBody;
  request: Request;
  registry: DomainAdapterRegistry;
  enqueue: EnqueueJob;
}): Promise<ProvisioningJobWire> {
  const { projectId, domainType } = args;
  const { project, row, adapter, rollouts } = await day2Of(
    projectId,
    domainType,
    args.registry,
  );
  if (row.domainStatus === "PENDING" || row.domainStatus === "DEPLOYING") {
    throw new ConflictError(
      row.domainStatus === "PENDING"
        ? `Domain ${domainType} chưa từng được triển khai — triển khai project trước`
        : `Domain ${domainType} đang được triển khai — đợi lượt đó xong`,
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.notRetryable);
  }
  // Áp lại bằng bản adapter MỚI HƠN bản đang chạy là nâng cấp lách validator (§8.6)
  if (row.adapterVersion !== null && row.adapterVersion !== adapter.version) {
    throw new ConflictError(
      `Domain ${domainType} chạy bản ${row.adapterVersion}, máy chủ nạp bản ${adapter.version} — nâng cấp (có kiểm validator) thay vì áp lại`,
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.notRetryable);
  }
  assertNoLiveRollout(rollouts, "áp lại domain");
  requireProductionConfirm(
    project.environments,
    args.body.confirm,
    domainType,
    "Áp lại",
  );

  const job = await prisma.$transaction((tx) =>
    createApplyJob(
      tx,
      projectId,
      { kind: "reapply", domainType },
      {
        action: "domain.reapply",
        after: { domainType, from: row.domainStatus },
        request: args.request,
      },
    ),
  );
  await send(args.enqueue, job.id);
  return jobView(job);
}

import type { Request } from "express";
import type { JobState, Prisma } from "@udp/db";
import {
  ConfirmationRequiredError,
  ConflictError,
  logger,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
} from "@udp/http";
import { CLOUD_ERROR_SLUGS } from "@udp/shared-types/cloud-api";
import {
  PROVISION_ERROR_SLUGS,
  type ProvisionBlocker,
  type ProvisionBody,
} from "@udp/shared-types/provisioning-api";
import type {
  JobDetailWire,
  ProvisionPreviewWire,
  ProvisioningJobWire,
} from "@udp/shared-types/wire";
import { ZodError } from "zod";
import { prisma } from "../../core/db.js";
import { auditEntry } from "../audit/audit.service.js";
import type { CloudPlatform } from "../cloud/cloud.platform.js";
import { activeMeta } from "../cloud/cloud.repository.js";
import type { DomainAdapterRegistry } from "../domain/domain-adapter.registry.js";
import {
  catalogAvailability,
  projectDomains,
} from "../domain/domain-config.store.js";
import { resolveTarget, validateTarget } from "../domain/domain-target.js";
import { resourceQuotaSchema } from "../project/project.types.js";
import { closeFinishedCycle } from "./prisma-ledger.js";
import { providerFromDb } from "./provider-codec.js";
import {
  clusterParamsOf,
  estimatedMinutesOf,
  payloadOf,
  phaseSteps,
  type ProvisionPayload,
} from "./provision-plan.js";
import {
  CANCELLABLE_STATES,
  requestCancel,
  TERMINAL_STATES,
} from "./provisioning-job.repository.js";

/**
 * Provisioning của project qua HTTP (Plan #28 P5, §8.1 giai đoạn 2, §9): xem trước, tạo
 * job, đọc tiến độ, hủy. Job CHẠY ở worker (`jobs/provision.job.ts`); ở đây chỉ ghi hàng
 * `ProvisioningJob` QUEUED — nó là outbox (QĐ-1) — rồi gửi sang hàng đợi sau commit.
 */

export interface ProvisioningDeps {
  platform: CloudPlatform;
  registry: DomainAdapterRegistry;
  /** `UDP_EGRESS_CIDRS` — rỗng thì triển khai này không provisioning được */
  egressCidrs: readonly string[];
}

/** Gửi job sang hàng đợi — `null` khi tiến trình này không chạy hàng đợi (đối soát gửi) */
export type EnqueueJob = ((jobId: string) => Promise<void>) | null;

const PROJECT_NOT_FOUND = "Không tìm thấy project";
const JOB_NOT_FOUND = "Không tìm thấy job";
const RETRYABLE_PROJECT: readonly string[] = ["DRAFT", "ERROR"];
const RECENT_JOBS = 20;

const BLOCKER_MESSAGES: Readonly<Record<ProvisionBlocker, string>> = {
  "project-not-draft": "Project không ở trạng thái nháp hay lỗi",
  "job-active": "Project đang có một job chạy",
  "cloud-not-validated": "Credential cloud chưa được kiểm",
  "egress-not-configured":
    "Triển khai UDP chưa cấu hình địa chỉ egress (UDP_EGRESS_CIDRS)",
  "domains-invalid": "Cấu hình domain đang lưu không hợp lệ",
  "orphans-pending":
    "Lượt trước còn tài nguyên nghi mồ côi trên cloud — dọn trước khi chạy lại",
};

interface Plan {
  preview: ProvisionPreviewWire;
  payload: ProvisionPayload;
}

/** Thứ tự deploy của domain đang lưu — `null` khi cấu hình không còn hợp lệ */
async function deployOrderOf(
  projectId: string,
  registry: DomainAdapterRegistry,
): Promise<string[][] | null> {
  const state = await projectDomains(projectId);
  if (state === null) throw new NotFoundError(PROJECT_NOT_FOUND);
  const target = {
    domains: state.view.domains.flatMap((d) =>
      d.isEnabled && d.selectedTool !== null
        ? [
            {
              domainType: d.domainType,
              toolId: d.selectedTool,
              config: d.toolConfig ?? {},
            },
          ]
        : [],
    ),
    preferences: state.view.preferences,
  };
  try {
    const targets = resolveTarget(
      target,
      registry,
      await catalogAvailability(),
    );
    const result = validateTarget(targets, target);
    return result.valid ? (result.order ?? []) : null;
  } catch (e) {
    // Tool đã gỡ khỏi registry hay config không còn khớp schema: lý do chặn, không phải 500
    if (e instanceof UnprocessableError || e instanceof ZodError) return null;
    throw e;
  }
}

async function planOf(
  projectId: string,
  deps: ProvisioningDeps,
): Promise<Plan> {
  const [project, credential, activeJob, orphans, deployOrder] =
    await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: {
          status: true,
          resourceQuota: true,
          expiresAt: true,
          owner: { select: { email: true } },
          environments: { select: { isProduction: true } },
        },
      }),
      activeMeta(projectId),
      prisma.provisioningJob.findFirst({
        where: { projectId, state: { notIn: [...TERMINAL_STATES] } },
        select: { id: true },
      }),
      prisma.provisionedResource.count({
        where: { projectId, status: "ORPHAN_SUSPECTED" },
      }),
      deployOrderOf(projectId, deps.registry),
    ]);
  if (project === null) throw new NotFoundError(PROJECT_NOT_FOUND);
  if (credential === null) {
    throw new ConflictError(
      "Project chưa cấu hình cloud — lưu credential trước",
    ).withTypeSlug(CLOUD_ERROR_SLUGS.notConfigured);
  }
  const provider = providerFromDb(credential.provider);
  const adapter = deps.platform.adapterFor(provider, credential.region);
  if (adapter === null) {
    throw new ServiceUnavailableError(
      `Cloud ${credential.provider} không được bật trên triển khai UDP này`,
    );
  }

  const payload = payloadOf({
    provider,
    region: credential.region,
    quota: resourceQuotaSchema.parse(project.resourceQuota),
    owner: project.owner.email,
    expiresAt: project.expiresAt,
    controlPlaneCidrs: deps.egressCidrs,
  });
  const estimate = await adapter.estimateCost(
    clusterParamsOf(projectId, payload),
  );
  if (estimate.status !== "SUCCESS" || estimate.data === undefined) {
    throw new ServiceUnavailableError(
      estimate.message ?? "Adapter không ước tính được chi phí",
    );
  }
  const steps = phaseSteps(adapter, projectId, payload);

  const blockers: ProvisionBlocker[] = [];
  if (!RETRYABLE_PROJECT.includes(project.status)) {
    blockers.push("project-not-draft");
  }
  if (activeJob !== null) blockers.push("job-active");
  if (credential.lastValidatedAt === null) blockers.push("cloud-not-validated");
  if (deps.egressCidrs.length === 0) blockers.push("egress-not-configured");
  if (deployOrder === null) blockers.push("domains-invalid");
  if (orphans > 0) blockers.push("orphans-pending");

  return {
    payload,
    preview: {
      provider: credential.provider,
      region: credential.region,
      cluster: { nodeSize: payload.nodeSize, nodeCount: payload.nodeCount },
      cost: {
        monthlyUsd: estimate.data.monthlyUsd,
        breakdown: estimate.data.breakdown,
        isEstimate: estimate.data.isEstimate,
        pricingAsOf: estimate.data.pricingAsOf,
      },
      steps: {
        network: steps.network.map((s) => s.name),
        cluster: steps.cluster.map((s) => s.name),
      },
      deployOrder: deployOrder ?? [],
      estimatedMinutes: estimatedMinutesOf(provider, deployOrder?.length ?? 0),
      requiresConfirmation: project.environments.some((e) => e.isProduction),
      blockers,
    },
  };
}

export async function preview(
  projectId: string,
  deps: ProvisioningDeps,
): Promise<ProvisionPreviewWire> {
  return (await planOf(projectId, deps)).preview;
}

// ------------------------------------------------------------- job

const JOB_SELECT = {
  id: true,
  jobType: true,
  state: true,
  attempt: true,
  estimatedCost: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ProvisioningJobSelect;

type JobRow = Prisma.ProvisioningJobGetPayload<{ select: typeof JOB_SELECT }>;

const recordOf = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

/** `last_error` do worker ghi ⇒ hình cố định cho Portal; hàng cũ thiếu trường vẫn đọc được */
function lastErrorView(value: unknown): ProvisioningJobWire["lastError"] {
  const v = recordOf(value);
  if (v === null) return null;
  return {
    step: typeof v.step === "string" ? v.step : "",
    message: typeof v.message === "string" ? v.message : "",
    orphans: Array.isArray(v.orphans)
      ? v.orphans.filter((o): o is string => typeof o === "string")
      : [],
    at: typeof v.at === "string" ? v.at : null,
  };
}

export function jobView(row: JobRow): ProvisioningJobWire {
  const confirmed = recordOf(row.estimatedCost)?.confirmedMonthlyUsd;
  return {
    id: row.id,
    jobType: row.jobType,
    state: row.state,
    attempt: row.attempt,
    confirmedMonthlyUsd: typeof confirmed === "number" ? confirmed : null,
    lastError: lastErrorView(row.lastError),
    cancellable: CANCELLABLE_STATES.includes(row.state),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Job chưa kết thúc của project — khoá mọi thay đổi mà job đang dựa vào */
export async function activeJobOf(projectId: string): Promise<string | null> {
  const row = await prisma.provisioningJob.findFirst({
    where: { projectId, state: { notIn: [...TERMINAL_STATES] } },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function provision(
  projectId: string,
  body: ProvisionBody,
  request: Request,
  deps: ProvisioningDeps,
  enqueue: EnqueueJob,
): Promise<ProvisioningJobWire> {
  const { preview: view, payload } = await planOf(projectId, deps);
  const blocker = view.blockers[0];
  if (blocker !== undefined) {
    throw new ConflictError(BLOCKER_MESSAGES[blocker]).withTypeSlug(
      PROVISION_ERROR_SLUGS.blocked,
    );
  }
  // §4.4 lớp 2: production đòi ĐÚNG con số vừa thấy — giá đổi giữa hai lần bấm cũng là lệch
  if (
    view.requiresConfirmation &&
    body.confirmedMonthlyUsd !== view.cost.monthlyUsd
  ) {
    throw new ConfirmationRequiredError(
      `Project có environment production: xác nhận chi phí ước tính ${String(view.cost.monthlyUsd)} USD/tháng`,
    );
  }

  const job = await prisma.$transaction(async (tx) => {
    /**
     * Project rời DRAFT/ERROR NGAY trong transaction tạo job: domain và quota không đổi
     * được nữa giữa lúc người dùng xác nhận và lúc worker nhận việc. Unique index
     * `idx_one_active_job_per_project` là lớp chặn thứ hai (P2002 ⇒ 409).
     */
    const moved = await tx.project.updateMany({
      where: { id: projectId, status: { in: ["DRAFT", "ERROR"] } },
      data: { status: "PROVISIONING" },
    });
    if (moved.count === 0) {
      throw new ConflictError(
        BLOCKER_MESSAGES["project-not-draft"],
      ).withTypeSlug(PROVISION_ERROR_SLUGS.blocked);
    }
    // Lượt trước đã bù trừ sạch: đóng chu kỳ sổ để lượt này dùng lại khoá tất định
    const closed = await closeFinishedCycle(tx, projectId);
    if (closed.length > 0) {
      await tx.auditLog.create({
        data: {
          ...auditEntry({
            action: "ledger.cycle.close",
            targetType: "Project",
            targetId: projectId,
            before: { deleted: closed },
            request,
          }),
          projectId,
        },
      });
    }
    const created = await tx.provisioningJob.create({
      data: {
        projectId,
        jobType: "PROVISION",
        payload,
        estimatedCost: {
          monthlyUsd: view.cost.monthlyUsd,
          breakdown: view.cost.breakdown,
          pricingAsOf: view.cost.pricingAsOf,
          confirmedMonthlyUsd: body.confirmedMonthlyUsd ?? null,
        },
      },
      select: JOB_SELECT,
    });
    await tx.auditLog.create({
      data: {
        ...auditEntry({
          action: "project.provision",
          targetType: "ProvisioningJob",
          targetId: created.id,
          after: {
            provider: view.provider,
            region: view.region,
            monthlyUsd: view.cost.monthlyUsd,
          },
          request,
        }),
        projectId,
      },
    });
    return created;
  });

  // Sau commit. Hỏng ở đây không mất job: đối soát gửi lại hàng QUEUED (QĐ-1)
  if (enqueue !== null) {
    await enqueue(job.id).catch((err: unknown) => {
      logger.warn({ err, jobId: job.id }, "Chưa gửi được job sang hàng đợi");
    });
  }
  return jobView(job);
}

export async function list(projectId: string): Promise<ProvisioningJobWire[]> {
  const rows = await prisma.provisioningJob.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: RECENT_JOBS,
    select: JOB_SELECT,
  });
  return rows.map(jobView);
}

async function jobOrNotFound(projectId: string, jobId: string) {
  const row = await prisma.provisioningJob.findFirst({
    where: { id: jobId, projectId },
    select: JOB_SELECT,
  });
  if (row === null) throw new NotFoundError(JOB_NOT_FOUND);
  return row;
}

/** Tên logic của tài nguyên — đuôi của khoá `{projectId}:{step}:{kind}:{name}` */
const nameOf = (idempotencyKey: string): string =>
  idempotencyKey.split(":").at(-1) ?? idempotencyKey;

export async function detail(
  projectId: string,
  jobId: string,
): Promise<JobDetailWire> {
  const [job, resources, domains] = await Promise.all([
    jobOrNotFound(projectId, jobId),
    prisma.provisionedResource.findMany({
      where: { jobId },
      orderBy: { createdAt: "asc" },
      select: {
        step: true,
        kind: true,
        idempotencyKey: true,
        status: true,
        providerId: true,
        updatedAt: true,
      },
    }),
    prisma.domainConfig.findMany({
      where: { projectId, isEnabled: true },
      orderBy: { domainType: "asc" },
      select: { domainType: true, domainStatus: true, lastError: true },
    }),
  ]);
  return {
    job: jobView(job),
    resources: resources.map((r) => ({
      step: r.step,
      kind: r.kind,
      name: nameOf(r.idempotencyKey),
      status: r.status,
      providerId: r.providerId,
      updatedAt: r.updatedAt.toISOString(),
    })),
    domains: domains.map((d) => {
      const message = recordOf(d.lastError)?.message;
      return {
        domainType: d.domainType,
        status: d.domainStatus,
        message: typeof message === "string" ? message : null,
      };
    }),
  };
}

export const isTerminal = (state: JobState): boolean =>
  TERMINAL_STATES.includes(state);

export async function cancel(
  projectId: string,
  jobId: string,
  request: Request,
): Promise<ProvisioningJobWire> {
  await jobOrNotFound(projectId, jobId);
  if (!(await requestCancel(prisma, jobId))) {
    throw new ConflictError(
      "Job đã qua điểm hủy được (đang bù trừ hoặc đã kết thúc)",
    ).withTypeSlug(PROVISION_ERROR_SLUGS.notCancellable);
  }
  await prisma.auditLog.create({
    data: {
      ...auditEntry({
        action: "provision.cancel",
        targetType: "ProvisioningJob",
        targetId: jobId,
        request,
      }),
      projectId,
    },
  });
  return jobView(await jobOrNotFound(projectId, jobId));
}

/** Hàng sổ có thể còn là tài nguyên thật trên cloud */
const LIVE_RESOURCE_STATUSES = [
  "CREATING",
  "CREATED",
  "READY",
  "DELETING",
] as const;

/**
 * Phần hạ tầng của lệnh xoá mềm project (§9 "soft-delete + enqueue teardown", Plan #29
 * QĐ-3) — chạy TRONG transaction của lệnh xoá, nên không có khoảnh khắc nào project đã
 * xoá mà không ai được giao dọn.
 *
 * - Có job PROVISION còn hủy được ⇒ yêu cầu hủy: bù trừ của chính nó là teardown, một job
 *   thứ hai chỉ tranh cùng tài nguyên. Job đang bù trừ ⇒ để nó xong.
 * - Không job nào chạy mà sổ còn tài nguyên sống ⇒ job TEARDOWN mang payload của lượt
 *   PROVISION gần nhất (cloud, region, tag).
 * - Project chưa từng dựng gì ⇒ không có gì để dọn.
 *
 * Trả id job cần gửi sang hàng đợi sau commit, hay `null`.
 */
export async function retireInfrastructure(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<string | null> {
  const active = await tx.provisioningJob.findFirst({
    where: { projectId, state: { notIn: [...TERMINAL_STATES] } },
    select: { id: true },
  });
  if (active !== null) {
    await tx.provisioningJob.updateMany({
      where: { id: active.id, state: { in: [...CANCELLABLE_STATES] } },
      data: { state: "CANCEL_REQUESTED" },
    });
    return null;
  }
  const live = await tx.provisionedResource.count({
    where: { projectId, status: { in: [...LIVE_RESOURCE_STATUSES] } },
  });
  if (live === 0) return null;
  const source = await tx.provisioningJob.findFirst({
    where: { projectId, jobType: "PROVISION" },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  if (source === null) return null;
  const job = await tx.provisioningJob.create({
    data: {
      projectId,
      jobType: "TEARDOWN",
      payload: source.payload ?? {},
    },
    select: { id: true },
  });
  return job.id;
}

import type { Request } from "express";
import {
  ACTIVE_ROLLOUT_STATUSES,
  ENVIRONMENT,
  k8sNamespaceFor,
} from "@udp/config";
import { hasSqlState } from "@udp/db";
import { ConflictError, logger, NotFoundError } from "@udp/http";
import {
  ENVIRONMENT_ERROR_SLUGS,
  type CreateEnvironmentBody,
  type UpdateEnvironmentBody,
} from "@udp/shared-types/environment-api";
import type { ProvisioningJobWire } from "@udp/shared-types/wire";
import type { FlagServiceClient } from "../../core/clients/flag-service.client.js";
import { prisma } from "../../core/db.js";
import { auditContextOf, auditEntry } from "../audit/audit.service.js";
import type { PublicEnvironment } from "../project/project.types.js";
import {
  activeJobOf,
  jobView,
  type EnqueueJob,
} from "../provisioning/provisioning.service.js";
import {
  busyOnRace,
  createEnvironmentJob,
  projectBusy,
  sendJob,
  snapshotOf,
} from "./environment-job.js";

/**
 * Vòng đời environment (§9 Environment, Plan #40): tạo, sửa hai cờ, xoá.
 *
 * - Project CHƯA có cluster (nháp, lỗi): chỉ database — hàng environment, rồi Service 2 backfill
 *   `FlagEnvConfig` (§4). Project ĐANG chạy: thêm job `ENVIRONMENT_APPLY` dựng/dọn phần cluster.
 * - Audit của vòng đời environment KHÔNG mang `environment_id` (chỉ `target_id`): cột đó nói hành
 *   động xảy ra TRONG environment (bật flag, phát khoá), và là thứ khiến environment "có lịch sử".
 *   Tạo rồi sửa cờ một environment chưa dùng không được làm nó thành không xoá được.
 */

export interface EnvironmentDeps {
  flagService: FlagServiceClient;
  enqueue: EnqueueJob;
}

const ENV_FIELDS = {
  id: true,
  name: true,
  k8sNamespace: true,
  isProduction: true,
  rank: true,
  autoDeploy: true,
} as const;

/** Project đang dựng hay đã xoá mềm: không đổi tập environment giữa chừng */
const MUTABLE_STATUSES: readonly string[] = ["DRAFT", "ERROR", "ACTIVE"];

async function projectOf(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      name: true,
      status: true,
      environments: { select: { rank: true } },
    },
  });
  if (project === null) throw new NotFoundError("Không tìm thấy project");
  if (!MUTABLE_STATUSES.includes(project.status)) throw projectBusy();
  const running = project.status === "ACTIVE";
  if (running && (await activeJobOf(projectId)) !== null) throw projectBusy();
  return { ...project, running };
}

async function environmentOf(
  projectId: string,
  environmentId: string,
): Promise<PublicEnvironment> {
  const environment = await prisma.environment.findFirst({
    where: { id: environmentId, projectId },
    select: ENV_FIELDS,
  });
  if (environment === null) {
    throw new NotFoundError("Không tìm thấy environment trong project này");
  }
  return environment;
}

export const list = (projectId: string): Promise<PublicEnvironment[]> =>
  prisma.environment.findMany({
    where: { projectId },
    select: ENV_FIELDS,
    orderBy: { rank: "asc" },
  });

export async function create(
  deps: EnvironmentDeps,
  projectId: string,
  body: CreateEnvironmentBody,
  request: Request,
): Promise<{
  environment: PublicEnvironment;
  job: ProvisioningJobWire | null;
}> {
  const project = await projectOf(projectId);
  if (project.environments.length >= ENVIRONMENT.maxPerProject) {
    throw new ConflictError(
      `Project đã có đủ ${String(ENVIRONMENT.maxPerProject)} environment`,
    ).withTypeSlug(ENVIRONMENT_ERROR_SLUGS.limit);
  }
  // Tên trùng ⇒ `@@unique([projectId, name])` ⇒ 409 DUPLICATE_RESOURCE qua ánh xạ chung
  const environment = await prisma.environment.create({
    data: {
      projectId,
      name: body.name,
      rank: Math.max(-1, ...project.environments.map((e) => e.rank)) + 1,
      isProduction: body.isProduction,
      autoDeploy: body.autoDeploy ?? !body.isProduction,
      k8sNamespace: k8sNamespaceFor(project.name, projectId, body.name),
    },
    select: ENV_FIELDS,
  });

  /**
   * Bù trừ: xoá hàng vừa tạo. An toàn vì nó chưa có lịch sử nào — audit của lần tạo chỉ ghi SAU
   * khi mọi bước đã qua, và backfill của S2 (nếu đã kịp commit) đi theo bằng cascade.
   */
  const undo = async (e: unknown): Promise<never> => {
    await prisma.environment
      .delete({ where: { id: environment.id } })
      .catch((err: unknown) => {
        logger.error(
          { err, environmentId: environment.id },
          "Không bù trừ được environment vừa tạo",
        );
      });
    throw e;
  };

  await deps.flagService
    .backfillEnvironment(environment.id, auditContextOf(request))
    .catch(undo);
  const job = await prisma
    .$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          ...auditEntry({
            action: "environment.create",
            targetType: "Environment",
            targetId: environment.id,
            after: {
              name: environment.name,
              isProduction: environment.isProduction,
              autoDeploy: environment.autoDeploy,
            },
            request,
          }),
          projectId,
        },
      });
      return project.running
        ? createEnvironmentJob(
            tx,
            projectId,
            { action: "ADD", environment: snapshotOf(environment) },
            request,
          )
        : null;
    })
    .catch((e: unknown) => undo(e).catch(busyOnRace));
  if (job !== null) await sendJob(deps.enqueue, job.id);
  return { environment, job: job === null ? null : jobView(job) };
}

export async function update(
  projectId: string,
  environmentId: string,
  body: UpdateEnvironmentBody,
  request: Request,
): Promise<PublicEnvironment> {
  const before = await environmentOf(projectId, environmentId);
  const isProduction = body.isProduction ?? before.isProduction;
  // Bật production mà không nói gì về autoDeploy ⇒ tắt (§8.3)
  const autoDeploy =
    body.autoDeploy ?? (body.isProduction === true ? false : before.autoDeploy);
  const [environment] = await prisma.$transaction([
    prisma.environment.update({
      where: { id: environmentId },
      data: { isProduction, autoDeploy },
      select: ENV_FIELDS,
    }),
    prisma.auditLog.create({
      data: {
        ...auditEntry({
          action: "environment.update",
          targetType: "Environment",
          targetId: environmentId,
          before: {
            isProduction: before.isProduction,
            autoDeploy: before.autoDeploy,
          },
          after: { isProduction, autoDeploy },
          request,
        }),
        projectId,
      },
    }),
  ]);
  return environment;
}

/**
 * Xoá CỨNG, có điều kiện (QĐ-5): lịch sử append-only (`audit_logs`, `deployment_events`) giữ
 * environment bằng `Restrict` — SetNull là một lần UPDATE trên bảng append-only (§2.2). Thứ tự
 * kiểm cho lý do CỤ THỂ nhất: rollout đang chạy nói nhiều hơn "có lịch sử".
 */
export async function remove(
  deps: EnvironmentDeps,
  projectId: string,
  environmentId: string,
  request: Request,
): Promise<ProvisioningJobWire | null> {
  const project = await projectOf(projectId);
  const environment = await environmentOf(projectId, environmentId);
  const where = { environmentId };
  const refuse = (slug: string, message: string): never => {
    throw new ConflictError(message).withTypeSlug(slug);
  };
  if (project.environments.length <= 1) {
    refuse(
      ENVIRONMENT_ERROR_SLUGS.last,
      "Không xoá được environment cuối cùng của project",
    );
  }
  const [rollouts, enabled, audits, deploys] = await Promise.all([
    prisma.rolloutSession.count({
      where: { ...where, status: { in: [...ACTIVE_ROLLOUT_STATUSES] } },
    }),
    prisma.flagEnvConfig.count({ where: { ...where, isEnabled: true } }),
    prisma.auditLog.count({ where }),
    prisma.deploymentEvent.count({ where }),
  ]);
  if (rollouts > 0) {
    refuse(
      ENVIRONMENT_ERROR_SLUGS.rolloutActive,
      "Environment còn rollout đang chạy",
    );
  }
  if (enabled > 0) {
    refuse(
      ENVIRONMENT_ERROR_SLUGS.flagsEnabled,
      `Environment còn ${String(enabled)} flag đang bật`,
    );
  }
  if (audits + deploys > 0) {
    refuse(
      ENVIRONMENT_ERROR_SLUGS.hasHistory,
      "Environment đã có lịch sử (audit, deploy) — lịch sử không bị xoá theo",
    );
  }

  const job = await prisma
    .$transaction(async (tx) => {
      // Cascade: FlagEnvConfig, change log, binding theo env — những thứ THUỘC environment
      await tx.environment.delete({ where: { id: environmentId } });
      await tx.auditLog.create({
        data: {
          ...auditEntry({
            action: "environment.delete",
            targetType: "Environment",
            targetId: environmentId,
            before: { name: environment.name, rank: environment.rank },
            request,
          }),
          projectId,
        },
      });
      return project.running
        ? createEnvironmentJob(
            tx,
            projectId,
            { action: "REMOVE", environment: snapshotOf(environment) },
            request,
          )
        : null;
    })
    .catch((e: unknown) => {
      // Một hàng lịch sử vừa xuất hiện giữa lúc kiểm và lúc xoá (Restrict)
      if (hasSqlState(e, "23503")) {
        refuse(
          ENVIRONMENT_ERROR_SLUGS.hasHistory,
          "Environment vừa có lịch sử — lịch sử không bị xoá theo",
        );
      }
      return busyOnRace(e);
    });
  if (job !== null) await sendJob(deps.enqueue, job.id);
  return job === null ? null : jobView(job);
}

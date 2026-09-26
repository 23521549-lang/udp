import type { Prisma } from "@udp/db";
import { logger, NotFoundError } from "@udp/http";
import type { DeployAcceptedResponseWire } from "@udp/shared-types/wire";
import type { Request } from "express";
import { prisma } from "../../core/db.js";
import { auditEntry } from "../audit/audit.service.js";

/**
 * Cổng gửi một lần deploy sang hàng đợi `udp-deploy` — `null` khi tiến trình không chạy hàng đợi:
 * `DEPLOY_START` đã ghi là outbox, đối soát gửi thay (`reconcileDeploys`).
 */
export type EnqueueDeploy = ((deploymentId: string) => Promise<void>) | null;

export async function enqueueAfterCommit(
  enqueue: EnqueueDeploy,
  deploymentId: string,
): Promise<void> {
  await enqueue?.(deploymentId).catch((err: unknown) => {
    logger.warn(
      { err, deploymentId },
      "Chưa gửi được job deploy, đối soát sẽ gửi lại",
    );
  });
}

const record = (v: Prisma.JsonValue | null): Prisma.InputJsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};

/**
 * Duyệt một deploy chờ (§2.2 `auto_deploy = false`, §8.3): ghi `DEPLOY_START` cùng `deploymentId`
 * với các cột của bản ghi chờ, rồi gửi job. Hai người bấm cùng lúc: unique index của sự kiện
 * deploy cho đúng một START, người sau nhận `duplicate`.
 */
export async function approve(
  projectId: string,
  deploymentId: string,
  request: Request,
  enqueue: EnqueueDeploy,
): Promise<DeployAcceptedResponseWire> {
  const status = await prisma.$transaction(async (tx) => {
    const pending = await tx.deploymentEvent.findFirst({
      where: { projectId, deploymentId, eventType: "DEPLOY_PENDING" },
      select: {
        environmentId: true,
        workloadName: true,
        pipelineId: true,
        imageTag: true,
        commitSha: true,
        commitTimestamp: true,
        metadata: true,
      },
    });
    if (pending === null) {
      throw new NotFoundError("Không có deploy chờ duyệt này");
    }
    const { count } = await tx.deploymentEvent.createMany({
      data: [
        {
          ...pending,
          projectId,
          deploymentId,
          eventType: "DEPLOY_START",
          triggeredBy: "MANUAL",
          metadata: record(pending.metadata),
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return "duplicate" as const;
    await tx.auditLog.create({
      data: {
        projectId,
        ...auditEntry({
          action: "deployment.approve",
          targetType: "Deployment",
          targetId: deploymentId,
          environmentId: pending.environmentId,
          request,
        }),
      },
    });
    return "started" as const;
  });
  if (status === "started") await enqueueAfterCommit(enqueue, deploymentId);
  return { deploymentId, status };
}

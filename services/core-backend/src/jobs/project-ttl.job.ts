import { expiryDecision } from "@udp/adapter-core";
import type { PrismaClient } from "@udp/db";
import { logger } from "@udp/http";
import { auditEntry } from "../modules/audit/audit.service.js";
import {
  retireInfrastructure,
  type EnqueueJob,
} from "../modules/provisioning/provisioning.service.js";

/**
 * Lịch `project-ttl` (§4.4 lớp 3, §3.1 `project-ttl.job.ts`, Plan #29 QĐ-5).
 *
 * Quyết định là `expiryDecision` — thuần, và cố tình không xoá gì. Tệp này chỉ THI HÀNH:
 *
 * - `warn` / hết hạn mà `WARN` / bị chặn: một hàng audit (actor SYSTEM) cho MỖI mốc của MỖI
 *   `expires_at`. "Đã cảnh báo chưa" đọc lại từ chính audit (append-only) — gia hạn TTL là
 *   một `expires_at` mới, nên chuỗi mốc bắt đầu lại. Không thêm cột nào.
 * - `teardown`: hàng audit `project.ttl.teardown` ghi TRƯỚC, rồi xoá mềm và giao việc dọn
 *   hạ tầng — CÙNG transaction, cùng đường với `DELETE /projects/:id`. Project có
 *   environment production đã deploy không bao giờ tới nhánh này (`teardown-blocked`).
 */

export interface TtlSweepOutcome {
  warned: string[];
  expired: string[];
  blocked: string[];
  tornDown: string[];
}

export async function sweepProjectTtl(args: {
  prisma: PrismaClient;
  enqueue: EnqueueJob;
  now?: () => Date;
  /** Giới hạn lượt quét vào các project này — test dùng, lịch thật quét hết */
  only?: readonly string[];
}): Promise<TtlSweepOutcome> {
  const { prisma } = args;
  const now = (args.now ?? (() => new Date()))();
  const out: TtlSweepOutcome = {
    warned: [],
    expired: [],
    blocked: [],
    tornDown: [],
  };

  const projects = await prisma.project.findMany({
    where: {
      status: { not: "DELETED" },
      expiresAt: { not: null },
      ...(args.only === undefined ? {} : { id: { in: [...args.only] } }),
    },
    select: { id: true, expiresAt: true, expiryAction: true },
  });

  /** Ghi một lần cho mỗi (project, hành động, `expires_at`, mốc) */
  const once = async (
    projectId: string,
    action: string,
    expiresAt: string,
    extra: Record<string, string | number> = {},
  ): Promise<boolean> => {
    const seen = await prisma.auditLog.findFirst({
      where: {
        projectId,
        action,
        AND: [
          { after: { path: ["expiresAt"], equals: expiresAt } },
          ...Object.entries(extra).map(([k, v]) => ({
            after: { path: [k], equals: v },
          })),
        ],
      },
      select: { id: true },
    });
    if (seen !== null) return false;
    await prisma.auditLog.create({
      data: {
        ...auditEntry({
          action,
          targetType: "Project",
          targetId: projectId,
          actorType: "SYSTEM",
          after: { expiresAt, ...extra },
        }),
        projectId,
      },
    });
    return true;
  };

  for (const p of projects) {
    if (p.expiresAt === null) continue;
    const expiresAt = p.expiresAt.toISOString();
    const deployedProduction = await prisma.deploymentEvent.count({
      where: {
        projectId: p.id,
        eventType: "DEPLOY_SUCCESS",
        environment: { isProduction: true },
      },
    });
    const decision = expiryDecision(
      {
        expiresAt: p.expiresAt,
        expiryAction: p.expiryAction,
        hasDeployedProductionEnv: deployedProduction > 0,
      },
      now,
    );
    switch (decision.kind) {
      case "none":
        break;
      case "warn":
        if (
          await once(p.id, "project.ttl.warn", expiresAt, {
            threshold: decision.threshold,
          })
        ) {
          out.warned.push(p.id);
        }
        break;
      case "expired-warn-only":
        if (await once(p.id, "project.ttl.expired", expiresAt)) {
          out.expired.push(p.id);
        }
        break;
      case "teardown-blocked":
        if (
          await once(p.id, "project.ttl.teardown-blocked", expiresAt, {
            reason: decision.reason,
          })
        ) {
          out.blocked.push(p.id);
        }
        break;
      case "teardown": {
        const retired = await prisma.$transaction(async (tx) => {
          const moved = await tx.project.updateMany({
            where: { id: p.id, status: { not: "DELETED" } },
            data: { status: "DELETED" },
          });
          if (moved.count === 0) return { jobId: null, moved: false };
          // Vết TRƯỚC hành động (§4.4): một lần xoá không ai giải thích được là không được
          await tx.auditLog.create({
            data: {
              ...auditEntry({
                action: "project.ttl.teardown",
                targetType: "Project",
                targetId: p.id,
                actorType: "SYSTEM",
                after: { expiresAt },
              }),
              projectId: p.id,
            },
          });
          return { jobId: await retireInfrastructure(tx, p.id), moved: true };
        });
        if (retired.moved) out.tornDown.push(p.id);
        const { jobId } = retired;
        if (jobId !== null && args.enqueue !== null) {
          await args.enqueue(jobId).catch((err: unknown) => {
            logger.warn({ err, jobId }, "Chưa gửi được job TEARDOWN của TTL");
          });
        }
        break;
      }
    }
  }
  return out;
}

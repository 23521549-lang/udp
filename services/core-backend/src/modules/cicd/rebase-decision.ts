import type { Prisma } from "@udp/db";
import { z } from "zod";

/**
 * [Plan #61 QĐ-13] Lượt rebase theo lịch có thành một lần deploy production không — UDP quyết, không phải pipeline:
 * "commit đầu `main`" mà pipeline vừa rebase không nhất thiết là thứ đang chạy ở production (vừa rollback có chủ đích,
 * lượt deploy cuối hỏng hay đang chờ duyệt). Chỉ deploy khi lần deploy MỚI NHẤT của workload đã thành công với CÙNG
 * `repo:commit` mà digest khác.
 */
export type RebaseDecision =
  | { action: "deploy" }
  | { action: "unchanged"; deploymentId: string }
  | {
      action: "skipped";
      deploymentId: string | null;
      reason: "NOT_DEPLOYED" | "NOT_SETTLED" | "OTHER_IMAGE";
    };

/** Lần deploy mới nhất của workload ở environment: sự kiện cuối và image nó áp (`null` khi không đọc được) */
export interface LatestDeployment {
  deploymentId: string;
  eventType: string;
  imageRef: string | null;
}

/** `repo:tag@digest` ⇒ `repo:tag` (phần nhận diện commit) — image không digest giữ nguyên */
const named = (imageRef: string): string => {
  const at = imageRef.indexOf("@");
  return at >= 0 ? imageRef.slice(0, at) : imageRef;
};

export function decideRebase(
  latest: LatestDeployment | null,
  imageRef: string,
): RebaseDecision {
  if (latest === null) {
    return { action: "skipped", deploymentId: null, reason: "NOT_DEPLOYED" };
  }
  const { deploymentId } = latest;
  if (latest.eventType !== "DEPLOY_SUCCESS") {
    return { action: "skipped", deploymentId, reason: "NOT_SETTLED" };
  }
  if (latest.imageRef === imageRef)
    return { action: "unchanged", deploymentId };
  // Rollout SERVICE_LEVEL không ghi image vào metadata: không khẳng định được là cùng commit ⇒ không đè
  return latest.imageRef !== null && named(latest.imageRef) === named(imageRef)
    ? { action: "deploy" }
    : { action: "skipped", deploymentId, reason: "OTHER_IMAGE" };
}

const imageMetadata = z.object({ imageRef: z.string().min(1) });

/** Sự kiện vòng đời deploy — `FLAG_CHANGE` không đổi image đang chạy */
const LIFECYCLE = [
  "DEPLOY_PENDING",
  "DEPLOY_START",
  "DEPLOY_SUCCESS",
  "DEPLOY_FAILURE",
  "ROLLBACK",
] as const;

/** Lần deploy mới nhất của workload — image từ metadata của sự kiện mở đầu (START, hay PENDING khi chờ duyệt) */
export async function latestDeployment(
  tx: Pick<Prisma.TransactionClient, "deploymentEvent">,
  where: { projectId: string; environmentId: string; workloadName: string },
): Promise<LatestDeployment | null> {
  const last = await tx.deploymentEvent.findFirst({
    where: { ...where, eventType: { in: [...LIFECYCLE] } },
    orderBy: { occurredAt: "desc" },
    select: { deploymentId: true, eventType: true },
  });
  if (last === null) return null;
  const opening = await tx.deploymentEvent.findFirst({
    where: {
      projectId: where.projectId,
      deploymentId: last.deploymentId,
      eventType: { in: ["DEPLOY_START", "DEPLOY_PENDING"] },
    },
    orderBy: { occurredAt: "asc" },
    select: { metadata: true },
  });
  const meta = imageMetadata.safeParse(opening?.metadata);
  return {
    deploymentId: last.deploymentId,
    eventType: last.eventType,
    imageRef: meta.success ? meta.data.imageRef : null,
  };
}

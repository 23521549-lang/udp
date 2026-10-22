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

/**
 * Lần deploy mới nhất của workload — image từ metadata của sự kiện mở đầu (START, hay PENDING khi chờ duyệt)
 *
 * [Plan #61, sửa trong 61d-1] `occurred_at` do DATABASE cấp (`clock_timestamp()`), nên thứ tự ở đây không phụ thuộc
 * đồng hồ của tiến trình ghi — bảng này có hai writer ở hai tiến trình (Service 1 và `ROLLBACK` của Service 3).
 *
 * Thứ tự dựa vào ĐỘ PHÂN GIẢI của cột, không dựa vào khoá phụ: cột là `TIMESTAMPTZ(6)` (micro giây) nên hai sự kiện
 * trùng mốc gần như không xảy ra. `id` là khoá chốt cuối cùng và chỉ bảo đảm tính XÁC ĐỊNH — cùng dữ liệu cho cùng
 * câu trả lời, thay vì để Postgres trả hàng nào cũng được khi hai mốc bằng nhau. Nó KHÔNG bảo đảm đúng chiều thời
 * gian giữa hai tiến trình, vì `uuid(7)` cũng sinh ở máy của writer, tức đúng cái đồng hồ vừa bị loại khỏi đường
 * quyết định — và khi hai sự kiện đến từ hai tiến trình, nó thiên vị CÓ HỆ THỐNG về tiến trình chạy nhanh.
 *
 * Vì vậy đừng đọc `id` như một lưới an toàn. Trùng mốc giữa sự kiện MỞ ĐẦU và KẾT THÚC của CÙNG một `deploymentId`
 * thì hướng hỏng đúng là hướng an toàn (chọn nhầm sự kiện mở đầu ⇒ `NOT_SETTLED` ⇒ BỎ QUA lượt rebase). Nhưng cặp
 * nguy hiểm là `ROLLBACK` của Service 3 trùng mốc với `DEPLOY_SUCCESS` của Service 1 ở HAI `deploymentId` khác nhau:
 * ở đó chọn nhầm nghĩa là đè lên một lần rollback có chủ đích. Thứ chặn cặp đó là độ phân giải micro giây của cột,
 * không phải khoá phụ.
 */
export async function latestDeployment(
  tx: Pick<Prisma.TransactionClient, "deploymentEvent">,
  where: { projectId: string; environmentId: string; workloadName: string },
): Promise<LatestDeployment | null> {
  const last = await tx.deploymentEvent.findFirst({
    where: { ...where, eventType: { in: [...LIFECYCLE] } },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { deploymentId: true, eventType: true },
  });
  if (last === null) return null;
  const opening = await tx.deploymentEvent.findFirst({
    where: {
      projectId: where.projectId,
      deploymentId: last.deploymentId,
      eventType: { in: ["DEPLOY_START", "DEPLOY_PENDING"] },
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    select: { metadata: true },
  });
  const meta = imageMetadata.safeParse(opening?.metadata);
  return {
    deploymentId: last.deploymentId,
    eventType: last.eventType,
    imageRef: meta.success ? meta.data.imageRef : null,
  };
}

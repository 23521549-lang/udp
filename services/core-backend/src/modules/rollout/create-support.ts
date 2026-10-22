import { METRICS_PROVIDER } from "@udp/config";
import { logger, ServiceUnavailableError, type AppError } from "@udp/http";
import type { ProbeOutcome } from "@udp/metrics-provider";
import type { Request } from "express";
import type { AppDeps } from "../../core/app-deps.js";
import { metricsSourceFor } from "../capability/metrics-source.resolver.js";
import * as repository from "./rollout.repository.js";
import type { ProbeRolloutInput } from "./rollout.types.js";

/**
 * Hai bước chung của việc TẠO rollout ở cả hai scope (§8.5) — tách khỏi `rollout.service.ts` để nhánh FLAG_LEVEL
 * và nhánh SERVICE_LEVEL (`service-level.service.ts`, Plan #51) dùng MỘT định nghĩa: probe pha 1 và bù trừ sau
 * INSERT.
 */

export interface Probed {
  scrapeIntervalSec: number;
  scrapeIntervalSource: ProbeOutcome["scrapeIntervalSource"];
  hasSeries: boolean;
}

/**
 * Pha 1 (§7.4 [v4.4]): WORKLOAD có lưu lượng không — middleware đã xuất metric
 * cho đúng `service_name`/`namespace` chưa. KHÔNG kiểm nhãn `ff` ở đây: hook chỉ
 * gắn nhãn cho flag đã track, và flag chỉ được track SAU khi session tồn tại —
 * pha đó là việc của Service 3 trước bậc đầu.
 */
export async function probeWorkload(
  deps: AppDeps,
  where: { projectId: string; environmentId: string; namespace: string },
  workloadName: string,
  metricQueries: ProbeRolloutInput["metricQueries"],
): Promise<Probed> {
  // Nguồn theo binding metrics.query CỦA environment này (§5.4, Plan #31 AC-5)
  const source = await metricsSourceFor({
    projectId: where.projectId,
    environmentId: where.environmentId,
    registry: await deps.domainRegistry(),
  });
  const outcome = await deps
    .metricsFor(source, metricQueries, { projectId: where.projectId })
    .probe({ namespace: where.namespace, workloadName });
  const data = outcome.data;
  if (data?.reachable !== true) {
    throw new ServiceUnavailableError("Nguồn metrics không tới được");
  }
  if (data.queryFailed) {
    throw new ServiceUnavailableError(
      "Nguồn metrics sống nhưng truy vấn probe hỏng",
    );
  }
  return {
    scrapeIntervalSec:
      data.scrapeIntervalSec ?? METRICS_PROVIDER.defaultScrapeLagSeconds,
    scrapeIntervalSource: data.scrapeIntervalSource,
    hasSeries: data.hasSeries,
  };
}

/** Cửa sổ `rate()` phải ≥ 4 × scrape interval (§7.4) — hẹp hơn thì Prometheus trả khoảng trống */
export const minWindowOf = (scrapeIntervalSec: number): number =>
  Math.ceil(4 * scrapeIntervalSec);

/**
 * Bù trừ một lần tạo hỏng SAU khi session đã tồn tại (FLAG_LEVEL: `track` hỏng; SERVICE_LEVEL: ghi đối tượng
 * giao hàng vào cluster hỏng). Luôn NÉM — bên gọi không bao giờ nhận 201 cho một rollout không chạy được.
 *
 * Bình thường xoá được (lease khai sinh giữ S3 ở ngoài). Không xoá được — lease đã hết vì S1 treo lâu hơn biên —
 * thì S3 có thể đã chạm hàng: huỷ bằng intent ROLLBACK (trên session chưa áp bậc, S3 đóng nó — §7.6 dòng
 * PENDING). Lỗi trả về nói ĐÚNG điều đã xảy ra với rollout (đã xoá / đã yêu cầu huỷ / không huỷ được) và mang
 * `resourceId` khi rollout còn tồn tại. Bước bù trừ tự hỏng (database) thì vẫn trả lỗi GỐC, không để lỗi phụ che
 * mất nguyên nhân.
 */
export async function compensateCreate(args: {
  projectId: string;
  session: repository.NewSession;
  reason: string;
  failure: (suffix: string) => AppError;
  actorUserId: string;
  request: Request;
}): Promise<never> {
  const { projectId, session, actorUserId, request } = args;
  const reason = args.reason.slice(0, 255);
  let fate: "deleted" | "cancel-requested" | "still-running";
  try {
    if (await repository.deleteUnclaimed(session, projectId, reason, request)) {
      fate = "deleted";
    } else {
      const intentId = await repository.insertIntent({
        projectId,
        sessionId: session.id,
        action: "ROLLBACK",
        actorUserId,
        request,
        reason,
      });
      fate = intentId === undefined ? "still-running" : "cancel-requested";
    }
  } catch (err: unknown) {
    logger.error(
      { err, sessionId: session.id },
      "Bù trừ sau khi tạo rollout hỏng cũng hỏng — rollout có thể còn sống",
    );
    fate = "still-running";
  }

  const suffix =
    fate === "deleted"
      ? ""
      : fate === "cancel-requested"
        ? ` — rollout ${session.id} đã được yêu cầu huỷ, Service 3 sẽ đóng nó`
        : ` — KHÔNG huỷ được rollout ${session.id}; huỷ bằng tay (ROLLBACK) trên trang của nó`;
  const failure = args.failure(suffix);
  throw fate === "deleted" ? failure : failure.withResource(session.id);
}

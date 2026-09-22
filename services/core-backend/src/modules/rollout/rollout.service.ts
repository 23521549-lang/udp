import { METRICS_PROVIDER, ROLLOUT_TIMING } from "@udp/config";
import {
  logger,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
  ValidationError,
  type AppError,
} from "@udp/http";
import type { ProbeOutcome } from "@udp/metrics-provider";
import { canaryPairOf, flagServeDbSchema } from "@udp/shared-types";
import type { Request } from "express";
import type { AppDeps } from "../../core/app-deps.js";
import type { TrackOutcome } from "../../core/clients/flag-service.client.js";
import * as repository from "./rollout.repository.js";
import { detailView, eventView, summaryView } from "./rollout.view.js";
import type {
  CreateRolloutInput,
  IntentAction,
  ListRolloutsQuery,
  ProbeResult,
  ProbeRolloutInput,
  RolloutDetail,
  RolloutEventView,
  RolloutEventsQuery,
  RolloutSummary,
} from "./rollout.types.js";

/**
 * Luồng 5 ở Service 1 (§8.5): tạo rollout FLAG_LEVEL, probe pha 1, ghi intent.
 *
 * Thứ tự của `create` là thứ tự từ rẻ tới đắt, và từ "chưa ghi gì" tới "đã ghi":
 * kiểm cấu hình (một câu SQL) → probe metrics (mạng) → INSERT (kèm lease khai
 * sinh) → `track` sang Service 2 → bù trừ nếu `track` hỏng. Mọi lỗi trước INSERT
 * không để lại gì; mọi lỗi sau INSERT được bù trừ trước khi trả lời.
 */

const NOT_FOUND = "Không tìm thấy rollout trong project này";

// --------------------------------------------------------------- probe pha 1

interface Probed {
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
async function probeWorkload(
  deps: AppDeps,
  namespace: string,
  workloadName: string,
  metricQueries: ProbeRolloutInput["metricQueries"],
): Promise<Probed> {
  const outcome = await deps
    .metricsFor(metricQueries)
    .probe({ namespace, workloadName });
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
const minWindowOf = (scrapeIntervalSec: number): number =>
  Math.ceil(4 * scrapeIntervalSec);

export async function probe(
  deps: AppDeps,
  projectId: string,
  input: ProbeRolloutInput,
): Promise<ProbeResult> {
  const namespace = await repository.namespaceOf(projectId, input.envId);
  if (namespace === undefined) {
    throw new NotFoundError("Không tìm thấy environment trong project này");
  }
  const probed = await probeWorkload(
    deps,
    namespace,
    input.workloadName,
    input.metricQueries,
  );
  return {
    // Không tới được đã là 503 ở `probeWorkload` — tới đây thì luôn tới được
    reachable: true,
    hasSeries: probed.hasSeries,
    scrapeIntervalSec: probed.scrapeIntervalSec,
    scrapeIntervalSource: probed.scrapeIntervalSource,
    minMetricWindowSeconds: minWindowOf(probed.scrapeIntervalSec),
  };
}

// --------------------------------------------------------------- tạo

export async function create(
  deps: AppDeps,
  projectId: string,
  input: CreateRolloutInput,
  actorUserId: string,
  request: Request,
): Promise<RolloutDetail> {
  if (input.scope === "SERVICE_LEVEL") {
    throw new UnprocessableError(
      "SERVICE_LEVEL chưa được hỗ trợ — Service 3 chưa có executor cho workload (cần cluster-access, ADR-06)",
    );
  }
  if (input.strategy !== "CANARY") {
    throw new UnprocessableError(
      `${input.strategy} ở FLAG_LEVEL chưa có executor (§7.2) — chỉ CANARY chạy tự động được`,
    );
  }

  const target = await repository.flagTargetOf(projectId, input);
  if (target === undefined) {
    throw new NotFoundError(
      "Không tìm thấy flag, rule hoặc variant này trong environment của project",
    );
  }
  if (target.lifecycleStatus !== "ACTIVE") {
    // Cùng luật với `track` của S2 (chốt thật, dưới khoá env) — kiểm sớm ở đây để
    // người dùng nhận 422 rõ nghĩa thay vì 409 sau một vòng probe và bù trừ
    throw new UnprocessableError(
      `Flag đang ${target.lifecycleStatus} — chỉ rollout được flag ACTIVE (§6.7)`,
    );
  }
  if (!target.isEnabled) {
    // Hook không gắn nhãn khi flag tắt (§6.6): probe pha 2 sẽ không bao giờ qua
    throw new UnprocessableError(
      `Flag "${target.flagKey}" đang TẮT ở environment này — bật flag trước khi rollout`,
    );
  }
  const serve = flagServeDbSchema.safeParse(target.serve);
  if (!serve.success) {
    throw new UnprocessableError("rule.serve không hợp lệ");
  }
  const pair = canaryPairOf(serve.data, input.targetVariantId);
  if (pair.kind === "invalid") throw new UnprocessableError(pair.reason);

  const probed = await probeWorkload(
    deps,
    target.namespace,
    input.workloadName,
    input.metricQueries,
  );
  if (!probed.hasSeries) {
    throw new UnprocessableError(
      `Workload "${input.workloadName}" ở namespace "${target.namespace}" chưa xuất metric HTTP — cài udpMetricsMiddleware() (§6.6, §11.1)`,
      { namespace: target.namespace, workloadName: input.workloadName },
      "METRICS_NOT_AVAILABLE",
    );
  }
  const minWindow = minWindowOf(probed.scrapeIntervalSec);
  if (
    input.metricWindowSeconds !== undefined &&
    input.metricWindowSeconds < minWindow
  ) {
    throw new UnprocessableError(
      `metricWindowSeconds phải ≥ ${String(minWindow)} (4 × scrape interval ${String(probed.scrapeIntervalSec)}s, đo theo ${probed.scrapeIntervalSource})`,
    );
  }

  let session: repository.NewSession;
  try {
    session = await repository.insertSession({
      projectId,
      environmentId: target.environmentId,
      target: input,
      baselinePercentage: pair.targetPercent,
      metricWindowSeconds:
        input.metricWindowSeconds ??
        Math.max(ROLLOUT_TIMING.metricWindowSeconds, minWindow),
      actorUserId,
      request,
    });
  } catch (err: unknown) {
    if (err instanceof repository.ActiveRolloutExists) {
      throw activeRolloutConflict(err.activeRolloutId);
    }
    throw err;
  }

  const tracked = await deps.flagService.track(session.id);
  if (tracked.status !== "SUCCESS") {
    await compensate(projectId, session, tracked, actorUserId, request);
  }
  return get(projectId, session.id);
}

function activeRolloutConflict(activeRolloutId: string | undefined): Error {
  const message =
    "Flag này đã có một rollout đang chạy — mỗi flag tối đa một rollout sống (§8.5)";
  const err = new ConflictError(message, undefined, "ROLLOUT_IN_PROGRESS");
  return activeRolloutId === undefined
    ? err
    : err.withResource(activeRolloutId);
}

/**
 * `track` hỏng sau khi session đã tồn tại. Luôn NÉM — bên gọi không bao giờ nhận
 * 201 cho một rollout mà flag không được gắn nhãn.
 *
 * Bình thường xoá được (lease khai sinh giữ S3 ở ngoài). Không xoá được — lease
 * đã hết vì S1 treo lâu hơn biên — thì S3 có thể đã chạm hàng: huỷ bằng intent
 * ROLLBACK (trên session chưa áp bậc, S3 đóng nó mà không PATCH — §7.6 dòng
 * PENDING). Lỗi trả về nói ĐÚNG điều đã xảy ra với rollout (đã xoá / đã yêu cầu
 * huỷ / không huỷ được) và mang `resourceId` khi rollout còn tồn tại, để Portal
 * dẫn người dùng tới nó. Bước bù trừ tự hỏng (database) thì vẫn trả lỗi GỐC của
 * `track`, không để lỗi phụ che mất nguyên nhân.
 */
async function compensate(
  projectId: string,
  session: repository.NewSession,
  tracked: Exclude<TrackOutcome, { status: "SUCCESS" }>,
  actorUserId: string,
  request: Request,
): Promise<never> {
  const reason = `track thất bại: ${tracked.message}`.slice(0, 255);
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
      "Bù trừ sau khi track hỏng cũng hỏng — rollout có thể còn sống",
    );
    fate = "still-running";
  }

  const suffix =
    fate === "deleted"
      ? ""
      : fate === "cancel-requested"
        ? ` — rollout ${session.id} đã được yêu cầu huỷ, Service 3 sẽ đóng nó`
        : ` — KHÔNG huỷ được rollout ${session.id}; huỷ bằng tay (ROLLBACK) trên trang của nó`;
  const failure = trackFailure(tracked, suffix);
  throw fate === "deleted" ? failure : failure.withResource(session.id);
}

function trackFailure(
  tracked: Exclude<TrackOutcome, { status: "SUCCESS" }>,
  suffix: string,
): AppError {
  switch (tracked.status) {
    case "LIMIT":
      return new ConflictError(
        `${tracked.message}${suffix}`,
        undefined,
        "TRACKED_FLAG_LIMIT",
      );
    case "UNAVAILABLE":
      return new ServiceUnavailableError(
        `Service 2 không phản hồi khi gắn nhãn flag${suffix}`,
      );
    case "REJECTED":
      return new ConflictError(
        `Service 2 từ chối gắn nhãn (HTTP ${String(tracked.httpStatus)}): ${tracked.message}${suffix}`,
      );
  }
}

// --------------------------------------------------------------- intent

/**
 * `POST .../rollouts/:rolloutId/actions` — 202, không 200: Service 1 chỉ GHI ý
 * định; Service 3 thi hành ở vòng kế (§8.5 "202 Accepted chứ không phải 200").
 */
export async function act(
  projectId: string,
  rolloutId: string,
  action: IntentAction,
  actorUserId: string,
  request: Request,
): Promise<{ intentId: string }> {
  const intentId = await repository.insertIntent({
    projectId,
    sessionId: rolloutId,
    action,
    actorUserId,
    request,
  });
  if (intentId !== undefined) return { intentId };

  const blocker = await repository.intentBlockerOf(projectId, rolloutId);
  if (blocker === undefined) throw new NotFoundError(NOT_FOUND);
  if (blocker.status === "DONE" || blocker.status === "FAILED") {
    throw new ConflictError(
      `Rollout đã kết thúc (${blocker.status}) — không còn gì để ${action}`,
    );
  }
  if (blocker.status === "PENDING" && action !== "ROLLBACK") {
    throw new ConflictError(
      "Rollout chưa bắt đầu (chưa thấy nhãn ff) — chỉ huỷ được bằng ROLLBACK (§7.6)",
    );
  }
  if (blocker.hasPendingIntent) {
    throw new ConflictError(
      "Đang có một ý định chờ Service 3 xử lý — đợi nó xong rồi thử lại",
    );
  }
  // Điều kiện đổi giữa lần ghi và lần đọc lại (S3 vừa đóng session hay xử lý intent)
  throw new ConflictError("Trạng thái rollout vừa đổi — tải lại và thử lại");
}

// --------------------------------------------------------------- đọc

export async function get(
  projectId: string,
  rolloutId: string,
): Promise<RolloutDetail> {
  const rows = await repository.detailOf(projectId, rolloutId);
  if (rows === undefined) throw new NotFoundError(NOT_FOUND);
  return detailView(rows);
}

export async function list(
  projectId: string,
  query: ListRolloutsQuery,
): Promise<RolloutSummary[]> {
  return (await repository.list(projectId, query)).map(summaryView);
}

export async function events(
  projectId: string,
  rolloutId: string,
  query: RolloutEventsQuery,
): Promise<RolloutEventView[]> {
  const rows = await repository.events(projectId, rolloutId, query);
  if (rows === "no-session") throw new NotFoundError(NOT_FOUND);
  if (rows === "bad-cursor") {
    throw new ValidationError(
      "Con trỏ before không phải event của rollout này",
    );
  }
  return rows.map((row) => eventView(row, rolloutId));
}

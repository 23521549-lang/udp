import {
  SIGNATURE_REJECTIONS,
  type SignatureRejection,
} from "@udp/shared-types";

/**
 * Năm chỉ số DORA từ Event Store (§2.2 "Định nghĩa DORA dùng trong UDP", §9) — hàm THUẦN.
 *
 * Tách khỏi truy vấn để định nghĩa được test không cần database: định nghĩa sai (đếm
 * `DEPLOY_START` lẫn `DEPLOY_SUCCESS` thành hai lần deploy, hay chia cho số sự kiện thay
 * vì số deployment) là loại lỗi chỉ lộ ra khi đọc kỹ con số — test là nơi đọc kỹ.
 *
 * Mọi chỉ số đi kèm cỡ mẫu. Median của 0 mẫu là `null`, không phải 0: "chưa có dữ liệu"
 * và "lead time bằng không" là hai câu trả lời khác nhau.
 */

export type DeploymentEventType =
  | "DEPLOY_PENDING"
  | "DEPLOY_START"
  | "DEPLOY_SUCCESS"
  | "DEPLOY_FAILURE"
  | "FLAG_CHANGE"
  | "ROLLBACK";

export interface DoraEvent {
  deploymentId: string;
  eventType: DeploymentEventType;
  occurredAt: Date;
  commitTimestamp: Date | null;
  restoresDeploymentId: string | null;
  rolloutSessionId: string | null;
  triggeredBy: "WEBHOOK" | "MANUAL" | "ROLLBACK" | "AUTO";
  metadata: unknown;
}

export interface DoraResult {
  window: { from: string; to: string; days: number };
  deployments: number;
  deploymentFrequencyPerDay: number;
  leadTimeSeconds: { median: number | null; samples: number };
  changeFailureRate: { value: number | null; failed: number; total: number };
  recoveryTimeSeconds: { median: number | null; samples: number };
  reworkRate: { value: number | null; rework: number; total: number };
  /** Rollback theo nguồn — `AUTO` là của reconciler (C1), tách cho E5 */
  rollbacks: { auto: number; manual: number };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const hi = s[mid] ?? 0;
  return s.length % 2 === 1 ? hi : ((s[mid - 1] ?? 0) + hi) / 2;
}

const seconds = (a: Date, b: Date): number =>
  (a.getTime() - b.getTime()) / 1000;

const isRework = (metadata: unknown): boolean =>
  typeof metadata === "object" &&
  metadata !== null &&
  (metadata as { rework?: unknown }).rework === true;

/**
 * @param events sự kiện của MỘT (project, environment) có `occurredAt` trong cửa sổ
 * @param successAt mốc `DEPLOY_SUCCESS` của những deployment bị ROLLBACK khôi phục —
 *   có thể nằm TRƯỚC cửa sổ (deploy hôm qua, rollback hôm nay), nên truyền riêng
 */
export function computeDora(
  events: readonly DoraEvent[],
  window: { from: Date; to: Date },
  successAt: ReadonlyMap<string, Date>,
): DoraResult {
  const days = Math.max(
    1,
    Math.round((window.to.getTime() - window.from.getTime()) / 86_400_000),
  );

  // Một deployment = một deploymentId có kết cục (thành công hoặc thất bại) trong cửa sổ
  const outcome = new Map<string, DoraEvent>();
  for (const e of events) {
    if (e.eventType === "DEPLOY_SUCCESS" || e.eventType === "DEPLOY_FAILURE") {
      const prev = outcome.get(e.deploymentId);
      // FAILURE thắng SUCCESS của cùng lần deploy: nó thất bại sau khi báo xong
      if (prev === undefined || e.eventType === "DEPLOY_FAILURE") {
        outcome.set(e.deploymentId, e);
      }
    }
  }
  const successes = [...outcome.values()].filter(
    (e) => e.eventType === "DEPLOY_SUCCESS",
  );

  const leadTimes = successes.flatMap((e) =>
    e.commitTimestamp === null
      ? []
      : [seconds(e.occurredAt, e.commitTimestamp)],
  );

  const rollbacks = events.filter((e) => e.eventType === "ROLLBACK");
  const restored = new Set(
    rollbacks.flatMap((r) =>
      r.restoresDeploymentId === null ? [] : [r.restoresDeploymentId],
    ),
  );
  const failed = [...outcome.values()].filter(
    (e) => e.eventType === "DEPLOY_FAILURE" || restored.has(e.deploymentId),
  ).length;

  const recovery = rollbacks.flatMap((r) => {
    if (r.restoresDeploymentId === null) return [];
    const at = successAt.get(r.restoresDeploymentId);
    return at === undefined ? [] : [seconds(r.occurredAt, at)];
  });

  const total = outcome.size;
  const rework = successes.filter((e) => isRework(e.metadata)).length;

  return {
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      days,
    },
    deployments: successes.length,
    deploymentFrequencyPerDay: successes.length / days,
    leadTimeSeconds: { median: median(leadTimes), samples: leadTimes.length },
    changeFailureRate: {
      value: total === 0 ? null : failed / total,
      failed,
      total,
    },
    recoveryTimeSeconds: { median: median(recovery), samples: recovery.length },
    reworkRate: {
      value: successes.length === 0 ? null : rework / successes.length,
      rework,
      total: successes.length,
    },
    rollbacks: {
      auto: rollbacks.filter((r) => r.triggeredBy === "AUTO").length,
      manual: rollbacks.filter((r) => r.triggeredBy !== "AUTO").length,
    },
  };
}

export const DAY_MS = 86_400_000;

/**
 * [v4.11, Plan #56/#57] Cửa sổ `days` NGÀY LỊCH UTC: từ đầu ngày cách hôm nay `days − 1` ngày tới hết hôm nay. Cửa sổ
 * cuộn (`now − days`) chạm `days + 1` ngày lịch — biểu đồ "7 ngày" thành 8 cột, hai cột đầu cuối là nửa ngày. Một
 * định nghĩa cho E10 của trang Bằng chứng và biểu đồ deploy của trang Kiến trúc.
 */
export function utcDayWindow(
  days: number,
  now: Date,
): { from: Date; to: Date } {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return {
    from: new Date(today - (days - 1) * DAY_MS),
    to: new Date(today + DAY_MS),
  };
}

/**
 * [v4.11, Plan #56] Kết cục deploy theo NGÀY (UTC) trong cửa sổ — trục thời gian của E10 trên trang Bằng chứng.
 *
 * Cùng định nghĩa "một deployment" với `computeDora`: một `deploymentId` có kết cục, FAILURE thắng SUCCESS của cùng
 * lần deploy; ngày là ngày của sự kiện kết cục. Mọi ngày của cửa sổ đều có mặt (ngày không deploy là 0, không bị
 * bỏ) — biểu đồ thiếu ngày là biểu đồ nói dối về tần suất.
 *
 * [Plan #57] Khi sự kiện mang `environmentId` (gộp nhiều env), một deployment là cặp (env, `deploymentId`) như
 * Deployment Frequency của §2.2: provisioning ghi CÙNG `deploymentId` cho mỗi env, đó là nhiều lần deploy.
 */
export function dailyOutcomes(
  events: readonly (DoraEvent & { environmentId?: string })[],
  window: { from: Date; to: Date },
): { date: string; success: number; failure: number }[] {
  const outcome = new Map<string, DoraEvent>();
  for (const e of events) {
    if (e.eventType !== "DEPLOY_SUCCESS" && e.eventType !== "DEPLOY_FAILURE")
      continue;
    const key = `${e.environmentId ?? ""}/${e.deploymentId}`;
    const prev = outcome.get(key);
    if (prev === undefined || e.eventType === "DEPLOY_FAILURE") {
      outcome.set(key, e);
    }
  }
  const days = new Map<string, { success: number; failure: number }>();
  const first = Math.floor(window.from.getTime() / DAY_MS);
  const last = Math.floor((window.to.getTime() - 1) / DAY_MS);
  for (let d = first; d <= last; d += 1) {
    days.set(new Date(d * DAY_MS).toISOString().slice(0, 10), {
      success: 0,
      failure: 0,
    });
  }
  for (const e of outcome.values()) {
    const day = days.get(e.occurredAt.toISOString().slice(0, 10));
    if (day === undefined) continue;
    if (e.eventType === "DEPLOY_SUCCESS") day.success += 1;
    else day.failure += 1;
  }
  return [...days].map(([date, n]) => ({ date, ...n }));
}

// ------------------------------------------------------------- danh sách deployment

export interface DeploymentEventRow extends DoraEvent {
  id: string;
  workloadName: string | null;
  imageTag: string | null;
  commitSha: string | null;
}

export interface DeploymentView {
  deploymentId: string;
  status: DeploymentEventType;
  workloadName: string | null;
  imageTag: string | null;
  commitSha: string | null;
  triggeredBy: DoraEvent["triggeredBy"];
  /** [Plan #61 QĐ-13] Lần deploy do rebase theo lịch — metadata của sự kiện mở đầu mang `kind: "rebase"` */
  rebase: boolean;
  /** [Plan #61 QĐ-16] Phán quyết của cổng deploy — `null` khi không kiểm */
  signature: "VERIFIED" | SignatureRejection | null;
  /**
   * [Plan #61 QĐ-17, 61d-2a] Lời báo có mang token OIDC của đúng lượt chạy và token đó đã được xác minh.
   * Chỉ `VERIFIED` hay `null`: một lần từ chối là lỗi XÁC THỰC nên không sinh bản ghi deployment nào.
   */
  trustedDeploy: "VERIFIED" | null;
  rolloutSessionId: string | null;
  restoresDeploymentId: string | null;
  startedAt: string;
  lastEventAt: string;
  events: { id: string; eventType: DeploymentEventType; occurredAt: string }[];
}

const isRebase = (metadata: unknown): boolean =>
  typeof metadata === "object" &&
  metadata !== null &&
  (metadata as { kind?: unknown }).kind === "rebase";

/** Phán quyết của cổng deploy ghi trong metadata: `keyId` ⇒ đã kiểm, `code` ⇒ từ chối */
function signatureOf(metadata: unknown): DeploymentView["signature"] {
  if (typeof metadata !== "object" || metadata === null) return null;
  const signature = (metadata as { signature?: unknown }).signature;
  if (typeof signature !== "object" || signature === null) return null;
  const { keyId, code } = signature as { keyId?: unknown; code?: unknown };
  if (typeof keyId === "string") return "VERIFIED";
  return SIGNATURE_REJECTIONS.find((c) => c === code) ?? null;
}

/** Trusted Deploy đã xác minh: metadata của sự kiện mở đầu mang `trustedDeploy.tokenId` */
function trustedDeployOf(metadata: unknown): DeploymentView["trustedDeploy"] {
  if (typeof metadata !== "object" || metadata === null) return null;
  const trusted = (metadata as { trustedDeploy?: unknown }).trustedDeploy;
  if (typeof trusted !== "object" || trusted === null) return null;
  return typeof (trusted as { tokenId?: unknown }).tokenId === "string"
    ? "VERIFIED"
    : null;
}

/**
 * Gom sự kiện theo `deploymentId` (§2.2: cột đó tồn tại đúng để gom START/SUCCESS/
 * FAILURE của một lần deploy). Trạng thái = sự kiện MUỘN NHẤT; thứ tự = lần deploy có
 * sự kiện mới nhất trước.
 */
export function groupDeployments(
  rows: readonly DeploymentEventRow[],
  limit: number,
): DeploymentView[] {
  const groups = new Map<string, DeploymentEventRow[]>();
  for (const r of rows) {
    const g = groups.get(r.deploymentId) ?? [];
    g.push(r);
    groups.set(r.deploymentId, g);
  }
  const out = [...groups.entries()].map(([deploymentId, g]) => {
    const sorted = [...g].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );
    const first = sorted[0] as DeploymentEventRow;
    const last = sorted[sorted.length - 1] as DeploymentEventRow;
    const pick = <K extends "workloadName" | "imageTag" | "commitSha">(k: K) =>
      sorted.map((e) => e[k]).find((v) => v !== null) ?? null;
    return {
      deploymentId,
      status: last.eventType,
      workloadName: pick("workloadName"),
      imageTag: pick("imageTag"),
      commitSha: pick("commitSha"),
      triggeredBy: first.triggeredBy,
      rebase: sorted.some((e) => isRebase(e.metadata)),
      signature:
        sorted.map((e) => signatureOf(e.metadata)).find((v) => v !== null) ??
        null,
      trustedDeploy:
        sorted
          .map((e) => trustedDeployOf(e.metadata))
          .find((v) => v !== null) ?? null,
      rolloutSessionId:
        sorted.map((e) => e.rolloutSessionId).find((v) => v !== null) ?? null,
      restoresDeploymentId:
        sorted.map((e) => e.restoresDeploymentId).find((v) => v !== null) ??
        null,
      startedAt: first.occurredAt.toISOString(),
      lastEventAt: last.occurredAt.toISOString(),
      events: sorted.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        occurredAt: e.occurredAt.toISOString(),
      })),
    };
  });
  return out
    .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt))
    .slice(0, limit);
}

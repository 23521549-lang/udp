/**
 * Đọc trạng thái của đối tượng giao hàng SERVICE_LEVEL thành MỘT hình chung (§7.3 "Service 3 đọc status để mirror")
 * [Plan #51 QĐ-8] — thuần, để test được trên đúng hình dạng `status` mà Argo Rollouts và Flagger ghi.
 *
 * Mốc quan trọng nhất là "công cụ đã THẤY phiên bản mới chưa": ngay sau lần ghi của Service 1, `status` vẫn là của
 * lượt trước (Argo: `Healthy`, Flagger: `Succeeded`) — đọc nó như "xong" là đóng session DONE trước khi canary bắt
 * đầu. Argo: `observedGeneration` < `generation` ⇒ chưa thấy. Flagger: pha kết thúc chỉ được tin khi
 * `lastTransitionTime` sau lúc tạo session.
 */

export type DeliveryPhase =
  "waiting" | "progressing" | "paused" | "done" | "failed";

export interface Observation {
  phase: DeliveryPhase;
  /** Phần trăm traffic tới phiên bản mới mà công cụ đang áp */
  weight: number;
  /** Argo: `status.currentStepIndex` */
  stepIndex?: number;
  /** Argo: đang dừng ở một bậc `pause` chờ promote (pauseCondition của bậc canary / blue-green) */
  pausedAtStep: boolean;
  resourceVersion?: string;
  message?: string;
}

type Json = Record<string, unknown>;

export interface ArgoRollout {
  metadata?: { generation?: number; resourceVersion?: string };
  spec?: {
    strategy?: {
      canary?: {
        steps?: Json[];
        canaryService?: string;
        trafficRouting?: {
          istio?: {
            virtualService?: { name?: string; routes?: string[] };
            virtualServices?: { name?: string; routes?: string[] }[];
          };
        };
      };
      blueGreen?: Json;
    };
  };
  status?: {
    phase?: string;
    observedGeneration?: string | number;
    currentStepIndex?: number;
    pauseConditions?: { reason?: string }[] | null;
    abort?: boolean;
    stableRS?: string;
    currentPodHash?: string;
    message?: string;
    canary?: { weights?: { canary?: { weight?: number } } };
    blueGreen?: { activeSelector?: string };
  };
}

/** Lý do pause của Argo cho một BẬC (khác pause tay `spec.paused` hay pause do lỗi) */
const STEP_PAUSES: ReadonlySet<string> = new Set([
  "CanaryPauseStep",
  "BlueGreenPause",
]);

/** Trọng số mà bậc `index` đang áp: `setWeight` gần nhất ở/trước nó; qua hết bậc ⇒ 100 */
export function weightAt(steps: readonly Json[], index: number): number {
  if (index >= steps.length) return 100;
  for (let i = Math.min(index, steps.length - 1); i >= 0; i--) {
    const weight = steps[i]?.["setWeight"];
    if (typeof weight === "number") return weight;
  }
  return 0;
}

/** Trọng số của `setWeight` KẾ TIẾP sau bậc `index` — nơi một lần promote đưa tới; hết ⇒ 100 */
export function nextWeightAfter(steps: readonly Json[], index: number): number {
  for (let i = index + 1; i < steps.length; i++) {
    const weight = steps[i]?.["setWeight"];
    if (typeof weight === "number") return weight;
  }
  return 100;
}

export const isPauseStep = (step: Json | undefined): boolean =>
  step !== undefined && "pause" in step;

export function observeArgo(rollout: ArgoRollout): Observation {
  const status = rollout.status ?? {};
  const resourceVersion = rollout.metadata?.resourceVersion;
  const base = {
    ...(resourceVersion === undefined ? {} : { resourceVersion }),
    ...(status.message === undefined ? {} : { message: status.message }),
    ...(status.currentStepIndex === undefined
      ? {}
      : { stepIndex: status.currentStepIndex }),
  };
  const observed =
    Number(status.observedGeneration ?? 0) >=
    (rollout.metadata?.generation ?? 0);
  const blueGreen = rollout.spec?.strategy?.blueGreen !== undefined;
  const switched =
    status.currentPodHash !== undefined &&
    (blueGreen
      ? status.blueGreen?.activeSelector === status.currentPodHash
      : status.stableRS === status.currentPodHash);
  const steps = rollout.spec?.strategy?.canary?.steps ?? [];
  const weight = blueGreen
    ? switched
      ? 100
      : 0
    : (status.canary?.weights?.canary?.weight ??
      weightAt(steps, status.currentStepIndex ?? 0));
  const pausedAtStep = (status.pauseConditions ?? []).some((c) =>
    STEP_PAUSES.has(c.reason ?? ""),
  );

  if (!observed) return { ...base, phase: "waiting", weight: 0, pausedAtStep };
  if (status.abort === true || status.phase === "Degraded") {
    return { ...base, phase: "failed", weight: 0, pausedAtStep: false };
  }
  if (status.phase === "Healthy" && switched) {
    return { ...base, phase: "done", weight: 100, pausedAtStep: false };
  }
  return {
    ...base,
    phase: pausedAtStep || status.phase === "Paused" ? "paused" : "progressing",
    weight,
    pausedAtStep,
  };
}

export interface FlaggerCanary {
  status?: {
    phase?: string;
    canaryWeight?: number;
    lastTransitionTime?: string;
    conditions?: { message?: string }[];
  };
}

/** Pha đang chạy của Flagger — thấy chúng là Flagger ĐÃ nhận phiên bản mới */
const FLAGGER_RUNNING: ReadonlySet<string> = new Set([
  "Waiting",
  "Progressing",
  "Promoting",
  "Finalising",
]);

export function observeFlagger(
  canary: FlaggerCanary,
  sessionCreatedAt: Date,
): Observation {
  const status = canary.status ?? {};
  const message = status.conditions?.[0]?.message;
  const base = message === undefined ? {} : { message };
  const phase = status.phase ?? "";
  const since = Date.parse(status.lastTransitionTime ?? "");
  const fresh = !Number.isNaN(since) && since >= sessionCreatedAt.getTime();
  const weight = status.canaryWeight ?? 0;

  if (fresh && phase === "Succeeded") {
    return { ...base, phase: "done", weight: 100, pausedAtStep: false };
  }
  if (fresh && phase === "Failed") {
    return { ...base, phase: "failed", weight: 0, pausedAtStep: false };
  }
  if (phase === "WaitingPromotion") {
    return { ...base, phase: "paused", weight, pausedAtStep: true };
  }
  if (FLAGGER_RUNNING.has(phase)) {
    return { ...base, phase: "progressing", weight, pausedAtStep: false };
  }
  // Initialized / Waiting / Succeeded-cũ: Flagger chưa thấy phiên bản mới
  return { ...base, phase: "waiting", weight: 0, pausedAtStep: false };
}

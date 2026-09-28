import { describe, expect, it } from "vitest";
import {
  nextWeightAfter,
  observeArgo,
  observeFlagger,
  weightAt,
  type ArgoRollout,
} from "../src/delivery/observe.js";

/**
 * Đọc trạng thái công cụ giao hàng (Plan #51 QĐ-8) — mốc quan trọng nhất: trạng thái CŨ ngay sau lần ghi của
 * Service 1 không được đọc thành "xong".
 */

const STEPS = [20, 40, 60, 80].flatMap((w) => [
  { setWeight: w },
  { pause: {} },
]);

const rollout = (status: NonNullable<ArgoRollout["status"]>): ArgoRollout => ({
  metadata: { generation: 2, resourceVersion: "7" },
  spec: { strategy: { canary: { steps: STEPS } } },
  status,
});

describe("bậc của Argo", () => {
  it("weightAt: setWeight gần nhất ở/trước bậc; qua hết ⇒ 100; nextWeightAfter: setWeight kế tiếp", () => {
    expect(weightAt(STEPS, 0)).toBe(20);
    expect(weightAt(STEPS, 1)).toBe(20);
    expect(weightAt(STEPS, 3)).toBe(40);
    expect(weightAt(STEPS, 8)).toBe(100);
    expect(nextWeightAfter(STEPS, 1)).toBe(40);
    expect(nextWeightAfter(STEPS, 7)).toBe(100);
  });
});

describe("observeArgo", () => {
  it("controller chưa thấy spec mới (observedGeneration cũ) ⇒ waiting — KHÔNG phải done dù status cũ Healthy", () => {
    expect(
      observeArgo(
        rollout({
          observedGeneration: "1",
          phase: "Healthy",
          stableRS: "old",
          currentPodHash: "old",
        }),
      ).phase,
    ).toBe("waiting");
  });

  it("dừng ở bậc pause ⇒ paused, trọng số theo trafficRouting; xong khi stableRS = currentPodHash", () => {
    const paused = observeArgo(
      rollout({
        observedGeneration: "2",
        phase: "Paused",
        currentStepIndex: 3,
        pauseConditions: [{ reason: "CanaryPauseStep" }],
        stableRS: "old",
        currentPodHash: "new",
        canary: { weights: { canary: { weight: 40 } } },
      }),
    );
    expect(paused).toMatchObject({
      phase: "paused",
      weight: 40,
      stepIndex: 3,
      pausedAtStep: true,
      resourceVersion: "7",
    });
    expect(
      observeArgo(
        rollout({
          observedGeneration: "2",
          phase: "Healthy",
          stableRS: "new",
          currentPodHash: "new",
        }),
      ),
    ).toMatchObject({ phase: "done", weight: 100 });
  });

  it("abort hay Degraded ⇒ failed; blue-green: trọng số 0 tới khi activeSelector là phiên bản mới", () => {
    expect(
      observeArgo(
        rollout({ observedGeneration: "2", phase: "Degraded", abort: true }),
      ).phase,
    ).toBe("failed");
    const bg: ArgoRollout = {
      metadata: { generation: 2 },
      spec: { strategy: { blueGreen: {} } },
      status: {
        observedGeneration: "2",
        phase: "Paused",
        pauseConditions: [{ reason: "BlueGreenPause" }],
        currentPodHash: "new",
        blueGreen: { activeSelector: "old" },
      },
    };
    expect(observeArgo(bg)).toMatchObject({
      phase: "paused",
      weight: 0,
      pausedAtStep: true,
    });
  });
});

describe("observeFlagger", () => {
  const created = new Date("2026-09-29T10:00:00Z");

  it("Succeeded CŨ (trước lúc tạo session) ⇒ waiting; Succeeded mới ⇒ done", () => {
    expect(
      observeFlagger(
        {
          status: {
            phase: "Succeeded",
            lastTransitionTime: "2026-09-29T09:00:00Z",
          },
        },
        created,
      ).phase,
    ).toBe("waiting");
    expect(
      observeFlagger(
        {
          status: {
            phase: "Succeeded",
            lastTransitionTime: "2026-09-29T10:05:00Z",
          },
        },
        created,
      ).phase,
    ).toBe("done");
  });

  it("Progressing mang trọng số; WaitingPromotion ⇒ paused; Failed mới ⇒ failed", () => {
    expect(
      observeFlagger(
        { status: { phase: "Progressing", canaryWeight: 30 } },
        created,
      ),
    ).toMatchObject({ phase: "progressing", weight: 30 });
    expect(
      observeFlagger(
        { status: { phase: "WaitingPromotion", canaryWeight: 80 } },
        created,
      ),
    ).toMatchObject({ phase: "paused", pausedAtStep: true });
    expect(
      observeFlagger(
        {
          status: {
            phase: "Failed",
            lastTransitionTime: "2026-09-29T10:01:00Z",
          },
        },
        created,
      ).phase,
    ).toBe("failed");
  });
});

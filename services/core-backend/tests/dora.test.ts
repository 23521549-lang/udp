import { describe, expect, it } from "vitest";
import {
  computeDora,
  dailyOutcomes,
  groupDeployments,
  median,
  type DeploymentEventRow,
  type DoraEvent,
} from "../src/modules/deployment/deployment.dora.js";

/**
 * Định nghĩa DORA của §2.2, từng chỉ số một. Mỗi ô chặn một cách đếm sai có thật:
 * đếm sự kiện thay vì deployment, median của 0 mẫu thành 0, rollback trỏ tới deploy
 * ngoài cửa sổ bị bỏ qua.
 */

const T0 = new Date("2026-09-01T00:00:00.000Z");
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);
const WINDOW = { from: T0, to: at(24 * 7) };

let seq = 0;
function ev(
  deploymentId: string,
  eventType: DoraEvent["eventType"],
  hour: number,
  over: Partial<DoraEvent> = {},
): DoraEvent {
  seq += 1;
  return {
    deploymentId,
    eventType,
    occurredAt: at(hour),
    commitTimestamp: null,
    restoresDeploymentId: null,
    rolloutSessionId: null,
    triggeredBy: "WEBHOOK",
    metadata: null,
    ...over,
  };
}

describe("DORA: định nghĩa §2.2", () => {
  it("START + SUCCESS của cùng lần deploy là MỘT deployment, không phải hai", () => {
    const r = computeDora(
      [ev("d1", "DEPLOY_START", 1), ev("d1", "DEPLOY_SUCCESS", 2)],
      WINDOW,
      new Map(),
    );
    expect(r.deployments).toBe(1);
    expect(r.deploymentFrequencyPerDay).toBeCloseTo(1 / 7);
  });

  it("lead time = median(occurredAt(SUCCESS) − commitTimestamp), bỏ deploy thiếu commit", () => {
    const r = computeDora(
      [
        ev("d1", "DEPLOY_SUCCESS", 10, { commitTimestamp: at(9) }),
        ev("d2", "DEPLOY_SUCCESS", 20, { commitTimestamp: at(17) }),
        ev("d3", "DEPLOY_SUCCESS", 30, { commitTimestamp: at(28) }),
        ev("d4", "DEPLOY_SUCCESS", 40),
      ],
      WINDOW,
      new Map(),
    );
    expect(r.leadTimeSeconds).toEqual({ median: 2 * 3600, samples: 3 });
  });

  it("change failure rate: deployment thất bại HOẶC bị ROLLBACK khôi phục, chia cho số DEPLOYMENT", () => {
    const r = computeDora(
      [
        ev("d1", "DEPLOY_START", 1),
        ev("d1", "DEPLOY_SUCCESS", 2),
        ev("d2", "DEPLOY_SUCCESS", 3),
        ev("d3", "DEPLOY_FAILURE", 4),
        ev("d4", "DEPLOY_SUCCESS", 5),
        ev("r1", "ROLLBACK", 6, {
          restoresDeploymentId: "d2",
          triggeredBy: "ROLLBACK",
        }),
      ],
      WINDOW,
      new Map([["d2", at(3)]]),
    );
    expect(r.changeFailureRate).toEqual({ value: 2 / 4, failed: 2, total: 4 });
  });

  it("thời gian khôi phục tính cả khi deploy bị khôi phục nằm TRƯỚC cửa sổ", () => {
    const r = computeDora(
      [
        ev("r1", "ROLLBACK", 5, {
          restoresDeploymentId: "old",
          triggeredBy: "MANUAL",
        }),
      ],
      WINDOW,
      new Map([["old", at(-3)]]),
    );
    expect(r.recoveryTimeSeconds).toEqual({ median: 8 * 3600, samples: 1 });
  });

  it("không có dữ liệu ⇒ null kèm cỡ mẫu 0, KHÔNG phải 0", () => {
    const r = computeDora([], WINDOW, new Map());
    expect(r.leadTimeSeconds.median).toBeNull();
    expect(r.changeFailureRate.value).toBeNull();
    expect(r.recoveryTimeSeconds).toEqual({ median: null, samples: 0 });
    expect(r.reworkRate.value).toBeNull();
    expect(r.deployments).toBe(0);
  });

  it("rework = deployment có metadata.rework = true / số deployment thành công", () => {
    const r = computeDora(
      [
        ev("d1", "DEPLOY_SUCCESS", 1, { metadata: { rework: true } }),
        ev("d2", "DEPLOY_SUCCESS", 2, { metadata: { rework: "true" } }),
      ],
      WINDOW,
      new Map(),
    );
    expect(r.reworkRate).toEqual({ value: 0.5, rework: 1, total: 2 });
  });

  it("rollback tách theo nguồn: AUTO (reconciler, C1) khác thủ công", () => {
    const r = computeDora(
      [
        ev("r1", "ROLLBACK", 1, {
          triggeredBy: "AUTO",
          rolloutSessionId: "s1",
        }),
        ev("r2", "ROLLBACK", 2, {
          triggeredBy: "MANUAL",
          rolloutSessionId: "s2",
        }),
        ev("r3", "ROLLBACK", 3, {
          triggeredBy: "AUTO",
          rolloutSessionId: "s3",
        }),
      ],
      WINDOW,
      new Map(),
    );
    expect(r.rollbacks).toEqual({ auto: 2, manual: 1 });
  });

  it("median số chẵn phần tử là trung bình hai phần tử giữa", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("kết cục theo ngày (Plan #56, E10 trên trang Bằng chứng)", () => {
  it("mọi ngày của cửa sổ có mặt; một deployment đếm MỘT lần, FAILURE thắng SUCCESS", () => {
    const days = dailyOutcomes(
      [
        ev("a", "DEPLOY_START", 1),
        ev("a", "DEPLOY_SUCCESS", 2),
        ev("b", "DEPLOY_SUCCESS", 3),
        ev("b", "DEPLOY_FAILURE", 4),
        ev("c", "DEPLOY_SUCCESS", 24 * 3 + 5),
        ev("d", "ROLLBACK", 24 * 3 + 6),
      ],
      WINDOW,
    );
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ date: "2026-09-01", success: 1, failure: 1 });
    expect(days[3]).toEqual({ date: "2026-09-04", success: 1, failure: 0 });
    expect(days.filter((d) => d.success + d.failure === 0)).toHaveLength(5);
  });

  it("sự kiện ngoài cửa sổ không rơi vào ngày nào", () => {
    const days = dailyOutcomes([ev("x", "DEPLOY_SUCCESS", -5)], WINDOW);
    expect(days.every((d) => d.success === 0)).toBe(true);
  });
});

describe("gom sự kiện thành deployment", () => {
  const row = (
    deploymentId: string,
    eventType: DoraEvent["eventType"],
    hour: number,
    over: Partial<DeploymentEventRow> = {},
  ): DeploymentEventRow => ({
    ...ev(deploymentId, eventType, hour),
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    workloadName: null,
    imageTag: null,
    commitSha: null,
    ...over,
  });

  it("trạng thái = sự kiện muộn nhất; lần có sự kiện mới nhất đứng đầu; trần limit", () => {
    const out = groupDeployments(
      [
        row("d1", "DEPLOY_START", 1, { imageTag: "v1" }),
        row("d1", "DEPLOY_SUCCESS", 2),
        row("d2", "DEPLOY_START", 5, { commitSha: "abc" }),
        row("d3", "ROLLBACK", 3),
      ],
      2,
    );
    expect(out.map((d) => d.deploymentId)).toEqual(["d2", "d3"]);
    const all = groupDeployments(
      [
        row("d1", "DEPLOY_SUCCESS", 2),
        row("d1", "DEPLOY_START", 1, { imageTag: "v1" }),
      ],
      10,
    );
    expect(all[0]?.status).toBe("DEPLOY_SUCCESS");
    expect(all[0]?.imageTag).toBe("v1");
    expect(all[0]?.events.map((e) => e.eventType)).toEqual([
      "DEPLOY_START",
      "DEPLOY_SUCCESS",
    ]);
  });
});

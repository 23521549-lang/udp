import { describe, expect, it } from "vitest";
import { ChaosState } from "../src/chaos.js";
import { Timeline } from "../src/timeline.js";

/** Bơm lỗi (§13.4) — đồng hồ và nguồn ngẫu nhiên tiêm được: tất định */

function chaosAt(start = 1_000) {
  let now = start;
  const timeline = new Timeline(() => now);
  let roll = 0;
  const chaos = new ChaosState(timeline, () => roll);
  return {
    chaos,
    timeline,
    advance: (ms: number) => {
      now += ms;
    },
    setRoll: (r: number) => {
      roll = r;
    },
  };
}

describe("ChaosState", () => {
  it("scope flag-on chỉ hỏng nhánh on; shared hỏng mọi nhánh (đối chứng âm)", () => {
    const { chaos, setRoll } = chaosAt();
    setRoll(0.1);
    chaos.setErrorRate(0.3, "flag-on");
    expect(chaos.decide("on").fail).toBe(true);
    expect(chaos.decide("off").fail).toBe(false);
    chaos.setErrorRate(0.3, "shared");
    expect(chaos.decide("off").fail).toBe(true);
    setRoll(0.5);
    expect(chaos.decide("on").fail).toBe(false);
  });

  it("độ trễ tăng tuyến tính theo rampSeconds rồi giữ ở ms", () => {
    const { chaos, advance } = chaosAt();
    chaos.setLatency(800, 10, "flag-on");
    expect(chaos.decide("on").delayMs).toBe(0);
    advance(5_000);
    expect(chaos.decide("on").delayMs).toBe(400);
    expect(chaos.decide("off").delayMs).toBe(0);
    advance(60_000);
    expect(chaos.decide("on").delayMs).toBe(800);
  });

  it("blast radius đếm request PHỤC VỤ nhánh on từ lúc bơm lỗi (định nghĩa §14 E5)", () => {
    const { chaos, timeline, advance } = chaosAt();
    chaos.recordServed("on", false); // trước khi bơm: không đếm
    chaos.setErrorRate(1, "flag-on");
    chaos.recordServed("on", true);
    advance(10);
    chaos.recordServed("on", false);
    chaos.recordServed("off", false);
    expect(chaos.describe().blastRadius).toEqual({
      servedOn: 2,
      failedOn: 1,
      servedAll: 3,
      failedAll: 1,
      lastOnServedAt: 1_010,
    });
    chaos.reset();
    expect(timeline.list().map((e) => e.type)).toEqual([
      "fault-on",
      "fault-off",
    ]);
    chaos.clearSession();
    expect(timeline.list()).toEqual([]);
    expect(chaos.describe().blastRadius.servedOn).toBe(0);
  });
});

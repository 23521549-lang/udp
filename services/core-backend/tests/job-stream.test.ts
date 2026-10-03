import { describe, expect, it } from "vitest";
import { streamJob } from "../src/modules/provisioning/job-stream.js";

/** Vòng SSE của job (Plan #28 QĐ-6, AC-8) trên đồng hồ giả */

function harness(states: { json: string; terminal: boolean }[]) {
  let clock = 0;
  let index = 0;
  const sent: string[] = [];
  return {
    sent,
    ports: {
      snapshot: () =>
        Promise.resolve(states[Math.min(index++, states.length - 1)] ?? null),
      send: (event: "snapshot" | "heartbeat") => {
        sent.push(event);
      },
      closed: () => false,
      sleep: (ms: number) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
    },
  };
}

const TIMING = { pollMs: 1_000, heartbeatMs: 3_000 };

describe("streamJob", () => {
  it("chỉ gửi snapshot khi ảnh chụp ĐỔI; im lặng lâu thì heartbeat; đóng ở trạng thái cuối", async () => {
    const same = { json: "a", terminal: false };
    const h = harness([
      same,
      same,
      same,
      same,
      { json: "b", terminal: false },
      { json: "c", terminal: true },
    ]);
    await streamJob(h.ports, TIMING);
    expect(h.sent).toEqual(["snapshot", "heartbeat", "snapshot", "snapshot"]);
  });

  it("job biến mất ⇒ đóng không gửi gì thêm", async () => {
    const h = harness([]);
    await streamJob(h.ports, TIMING);
    expect(h.sent).toEqual([]);
  });

  it("client đóng ⇒ dừng đọc", async () => {
    const h = harness([{ json: "a", terminal: false }]);
    let reads = 0;
    await streamJob(
      {
        ...h.ports,
        snapshot: () => {
          reads += 1;
          return h.ports.snapshot();
        },
        closed: () => reads >= 2,
      },
      TIMING,
    );
    expect(reads).toBe(2);
  });
});

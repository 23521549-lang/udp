import { describe, expect, it } from "vitest";
import {
  NODE_SCOPE,
  parseSummary,
  perStreamKiB,
  retryAfterMs,
  usageOf,
  type ContainerSample,
} from "../src/e9.js";

/** E9 (§14.1) [Plan #50] — phần thuần: đọc Summary API của kubelet và gộp theo pha */

const at = (s: number): string =>
  new Date(Date.UTC(2026, 8, 29, 0, 0, s)).toISOString();

/** Đúng hình dạng `stats/summary` của kubelet — chỉ những trường E9 đọc, cộng vài trường bị bỏ qua */
function summary(s: number, cpuNs: number, memMiB: number): string {
  const block = {
    cpu: { time: at(s), usageNanoCores: 1, usageCoreNanoSeconds: cpuNs },
    memory: { time: at(s), workingSetBytes: memMiB * 1024 * 1024, rssBytes: 1 },
  };
  return JSON.stringify({
    node: { nodeName: "udp-control-plane", ...block },
    pods: [
      {
        podRef: { name: "flag-service-abc", namespace: "udp", uid: "u1" },
        containers: [{ name: "flag-service", startTime: at(0), ...block }],
      },
      {
        podRef: { name: "coredns-x", namespace: "kube-system", uid: "u2" },
        containers: [{ name: "coredns", ...block }],
      },
      {
        podRef: { name: "sample-app-y", namespace: "udp-demo-dev", uid: "u3" },
        // container vừa khởi động: cAdvisor chưa có mẫu CPU
        containers: [{ name: "sample-app", memory: block.memory }],
      },
    ],
  });
}

const keep = (ns: string): boolean => ns === "udp" || ns.startsWith("udp-");

describe("parseSummary", () => {
  it("giữ node và container của namespace được chọn; bỏ container chưa có mẫu CPU", () => {
    const samples = parseSummary(summary(0, 5e9, 100), keep);
    expect(samples.map((s) => `${s.namespace}/${s.container}`)).toEqual([
      `${NODE_SCOPE}/node`,
      "udp/flag-service",
    ]);
    expect(samples[1]).toEqual({
      namespace: "udp",
      pod: "flag-service-abc",
      container: "flag-service",
      cpuAtMs: Date.parse(at(0)),
      cpuCoreNanoSeconds: 5e9,
      workingSetBytes: 100 * 1024 * 1024,
    });
  });
});

describe("usageOf", () => {
  const tick = (s: number, cpuNs: number, memMiB: number): ContainerSample[] =>
    parseSummary(summary(s, cpuNs, memMiB), (ns) => ns === "udp");

  it("CPU trung bình từ HAI ĐẦU bộ đếm; cực đại theo khoảng; mẫu trùng mốc cAdvisor tính một lần", () => {
    // 0→10 s: 1 lõi·giây (100 m); 10→20 s: 3 lõi·giây (300 m); lượt hỏi thứ ba trùng mốc 20 s
    const usage = usageOf([
      tick(0, 0, 100),
      tick(10, 1e9, 120),
      tick(20, 4e9, 140),
      tick(20, 4e9, 140),
    ]).find((u) => u.container === "flag-service");
    expect(usage).toEqual({
      namespace: "udp",
      container: "flag-service",
      cpuMillicoresMean: 200,
      cpuMillicoresMax: 300,
      memoryMiBP50: 120,
      memoryMiBMax: 140,
      samples: 3,
    });
  });

  it("pod khởi động lại giữa pha: khoảng bộ đếm tụt bị bỏ, không thành CPU âm", () => {
    const usage = usageOf([
      tick(0, 5e9, 100),
      tick(10, 6e9, 100),
      tick(20, 1e8, 90),
    ]);
    const flag = usage.find((u) => u.container === "flag-service");
    expect(flag?.cpuMillicoresMax).toBe(100);
    expect(flag?.cpuMillicoresMean).toBeNaN();
  });
});

describe("perStreamKiB / retryAfterMs", () => {
  const u = (memoryMiBP50: number) => ({
    namespace: "udp",
    container: "flag-service",
    cpuMillicoresMean: 1,
    cpuMillicoresMax: 1,
    memoryMiBP50,
    memoryMiBMax: memoryMiBP50,
    samples: 2,
  });

  it("chênh RAM trung vị giữa hai pha chia số stream, KiB", () => {
    expect(perStreamKiB([u(100)], [u(150)], "flag-service", 1000)).toBe(51.2);
    expect(perStreamKiB([u(100)], [], "flag-service", 1000)).toBeNull();
  });

  it("Retry-After số giây; thiếu hay hỏng ⇒ giá trị dự phòng", () => {
    expect(retryAfterMs("7", 3)).toBe(7000);
    expect(retryAfterMs(undefined, 3)).toBe(3000);
    expect(retryAfterMs("", 3)).toBe(3000);
    expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT", 3)).toBe(3000);
  });
});

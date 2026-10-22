import { describe, expect, it } from "vitest";
import { FakeMetricsProvider } from "../src/testing.js";

const on = {
  namespace: "ns",
  workloadName: "svc",
  flagKey: "f",
  variantKey: "on",
};

describe("FakeMetricsProvider", () => {
  it("nhánh có kịch bản trả số; nhánh không có trả hasData=false chứ không phải 0 lỗi (I7)", async () => {
    const fake = new FakeMetricsProvider().set("f=on", {
      requests: 300,
      errors: 12,
      p99Ms: 250,
    });
    const req = await fake.requestCount(on, 60);
    const rate = await fake.errorRate(on, 60);
    const missing = await fake.errorCount({ ...on, variantKey: "off" }, 60);

    expect(req).toMatchObject({ value: 300, hasData: true, windowSeconds: 60 });
    expect(rate.value).toBeCloseTo(0.04);
    expect(missing.hasData).toBe(false);
    expect(fake.calls.map((c) => `${c.kind}:${c.key}`)).toEqual([
      "requestCount:f=on",
      "errorRate:f=on",
      "errorCount:f=off",
    ]);
  });

  it("nguồn không tới được ⇒ mọi mẫu hasData=false và probe FAILED", async () => {
    const fake = new FakeMetricsProvider()
      .set("f=on", { requests: 10, errors: 0 })
      .setReachable(false);
    expect((await fake.requestCount(on, 60)).hasData).toBe(false);
    const probe = await fake.probe(on);
    expect(probe.status).toBe("FAILED");
    expect(probe.data?.reachable).toBe(false);
  });

  it("probe pha 2 thấy flag theo flagKey dù chỉ nhánh kia có lưu lượng; nhánh 0 request không tính", async () => {
    const fake = new FakeMetricsProvider().set("f=off", {
      requests: 10,
      errors: 0,
    });
    const probe = await fake.probe(on);
    expect(probe.data).toMatchObject({
      reachable: true,
      hasSeries: true,
      queryFailed: false,
      scrapeIntervalSec: 15,
    });
    expect((await fake.probe({ ...on, flagKey: "g" })).data?.hasSeries).toBe(
      false,
    );
    const idle = new FakeMetricsProvider().set("f=off", {
      requests: 0,
      errors: 0,
    });
    expect((await idle.probe(on)).data?.hasSeries).toBe(false);
  });

  it("probe pha 1 theo workload/namespace; truy vấn hỏng ⇒ queryFailed, không phải hasSeries=false", async () => {
    const workload = { namespace: on.namespace, workloadName: on.workloadName };
    const fake = new FakeMetricsProvider();
    expect((await fake.probe(workload)).data?.hasSeries).toBe(false);
    fake.setWorkload(on.namespace, on.workloadName);
    expect((await fake.probe(workload)).data?.hasSeries).toBe(true);
    expect(
      (await fake.probe({ ...workload, namespace: "khac" })).data?.hasSeries,
    ).toBe(false);
    fake.setQueryFailing(true);
    const failing = await fake.probe(workload);
    expect(failing.status).toBe("FAILED");
    expect(failing.data).toMatchObject({
      reachable: true,
      hasSeries: false,
      queryFailed: true,
    });
  });
});

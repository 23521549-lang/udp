import { describe, expect, it } from "vitest";
import { FakeCluster } from "../src/testing.js";

/** Cụm giả của test (Plan #51): ba hành vi API server mà đường SERVICE_LEVEL dựa vào */

const ROLLOUT = {
  apiVersion: "argoproj.io/v1alpha1",
  kind: "Rollout",
  namespace: "ns",
  name: "web",
};

describe("FakeCluster", () => {
  it("merge patch RFC 7386 (null xoá, mảng thay nguyên); patch lên đối tượng chính KHÔNG đổi status", async () => {
    const cluster = new FakeCluster();
    cluster.seed(ROLLOUT, {
      spec: { strategy: { canary: { steps: [1, 2], analysis: { a: 1 } } } },
      status: { phase: "Healthy" },
    });
    const client = cluster.client("workload");
    await client.write("patch", ROLLOUT, {
      spec: { strategy: { canary: { steps: [3], analysis: null } } },
      status: { phase: "Bị bỏ qua" },
    });
    expect(cluster.get(ROLLOUT)).toMatchObject({
      spec: { strategy: { canary: { steps: [3] } } },
      status: { phase: "Healthy" },
    });
    expect(
      (cluster.get(ROLLOUT) as { spec: { strategy: { canary: object } } }).spec
        .strategy.canary,
    ).not.toHaveProperty("analysis");
  });

  it("resourceVersion trong patch là điều kiện — lệch ⇒ 409; subresource status chỉ đổi status", async () => {
    const cluster = new FakeCluster();
    cluster.seed(ROLLOUT, { spec: {}, status: { abort: false } });
    const client = cluster.client("traffic");
    await expect(
      client.write("patch", ROLLOUT, { metadata: { resourceVersion: "999" } }),
    ).rejects.toMatchObject({ status: 409 });
    await client.write(
      "patch",
      { ...ROLLOUT, subresource: "status" },
      { status: { abort: true } },
    );
    expect(cluster.get(ROLLOUT)).toMatchObject({ status: { abort: true } });
    expect(cluster.writesBy("traffic").map((w) => w.path)).toEqual([
      "/apis/argoproj.io/v1alpha1/namespaces/ns/rollouts/web",
      "/apis/argoproj.io/v1alpha1/namespaces/ns/rollouts/web/status",
    ]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREATED_RESOURCE_KINDS,
  type CreatedResource,
  type CreatedResourceKind,
  TEARDOWN_ORDER,
} from "../src/cloud.js";
import { ORPHAN_HOURLY_USD } from "../src/guardrails.js";
import {
  discoverK8sManaged,
  runTeardown,
  teardownBatches,
  teardownTierOf,
  TEARDOWN_TIER_OF_KIND,
  waitGone,
  type TeardownCloud,
} from "../src/teardown.js";
import { SimCloud } from "../src/testing/sim-cloud.js";

/**
 * [v4.10] Teardown có thứ tự (§4.2, §4.5).
 *
 * Ba phép kiểm dưới đây là ba chỗ mà một hiện thực hợp lý vẫn để rò tiền:
 *
 *  - Thứ tự sai: `DeleteVpc` gọi trước khi ELB biến mất ⇒ `DependencyViolation`, và nếu ai
 *    đó "sửa" bằng cách bắt lỗi rồi bỏ qua thì VPC và NAT gateway sống mãi.
 *  - Nuốt timeout: báo "đã dọn xong" trong khi hoá đơn vẫn chạy.
 *  - Một `kind` chưa xếp bậc: nó bị xoá ở một thứ tự không xác định.
 */

let dir: string;
let cloud: SimCloud;

const res = (
  kind: CreatedResourceKind,
  id: string,
  over: Partial<CreatedResource> = {},
): CreatedResource => ({
  kind,
  id,
  provider: "aws",
  region: "ap-southeast-1",
  createdAt: new Date(0).toISOString(),
  tags: {},
  ...over,
});

const cloudPort = (c: SimCloud): TeardownCloud => ({
  deleteResource: (r) => Promise.resolve(c.deleteResource(r.id)),
  describeById: (id) => Promise.resolve(c.describeById(id)),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teardown-"));
  cloud = new SimCloud({ statePath: join(dir, "cloud.json") });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("mọi kind phải có bậc", () => {
  /**
   * Phép kiểm đầy đủ, cả hai chiều.
   *
   * Tầng thứ nhất là trình biên dịch: `TIER_OF_KIND` là `Record<CreatedResourceKind, string>`
   * toàn phần, nên thêm một `kind` vào union mà quên xếp bậc là lỗi biên dịch. Phép kiểm ở
   * đây là tầng thứ hai, và nó bắt một thứ khác: bảng và **danh sách chạy được**
   * `CREATED_RESOURCE_KINDS` trôi khỏi nhau — một khả năng thật, vì danh sách đó viết tay.
   */
  it("mọi CreatedResourceKind đều được xếp bậc", () => {
    const unmapped = CREATED_RESOURCE_KINDS.filter(
      (k) => !Object.hasOwn(TEARDOWN_TIER_OF_KIND, k),
    );
    expect(unmapped).toEqual([]);
  });

  it("bảng không có kind nào NGOÀI danh sách chạy được", () => {
    const known = new Set<string>(CREATED_RESOURCE_KINDS);
    const extra = Object.keys(TEARDOWN_TIER_OF_KIND).filter(
      (k) => !known.has(k),
    );
    expect(extra).toEqual([]);
  });

  it("mọi bậc trong bảng đều nằm trong TEARDOWN_ORDER", () => {
    const known = new Set<string>(TEARDOWN_ORDER);
    const strange = [...new Set(Object.values(TEARDOWN_TIER_OF_KIND))].filter(
      (t) => !known.has(t),
    );
    expect(strange).toEqual([]);
  });

  it("kind lạ thì NÉM, không im lặng bỏ qua", () => {
    expect(() => teardownTierOf("khong-co" as CreatedResourceKind)).toThrow(
      "chưa được xếp bậc",
    );
  });

  it("ba kind k8s-* đều ở bậc đầu tiên", () => {
    for (const k of ["k8s-loadbalancer", "k8s-volume", "k8s-eni"] as const) {
      expect(teardownTierOf(k), k).toBe("k8s-managed");
    }
  });

  it("vpc ở bậc CUỐI, và nat đứng trước subnet-route", () => {
    expect(teardownTierOf("vpc")).toBe("vpc");
    expect(TEARDOWN_ORDER.indexOf("nat")).toBeLessThan(
      TEARDOWN_ORDER.indexOf("subnet-route"),
    );
    expect(TEARDOWN_ORDER.at(-1)).toBe("vpc");
  });
});

describe("teardownBatches — chia lô theo đúng thứ tự", () => {
  it("lô ra theo thứ tự chín bậc, bỏ bậc rỗng", () => {
    const batches = teardownBatches([
      res("vpc", "vpc-1"),
      res("nat-gateway", "nat-1"),
      res("cluster", "cl-1"),
      res("subnet", "sn-1"),
    ]);
    expect(batches.map((b) => b.tier)).toEqual([
      "wait-k8s-gone",
      "cluster",
      "nat",
      "subnet-route",
      "vpc",
    ]);
  });

  /**
   * Rào `wait-k8s-gone` **luôn** xuất hiện, kể cả khi sổ không có tài nguyên `k8s-*` nào.
   *
   * Một tài nguyên do Kubernetes sinh có thể tồn tại trên cloud mà sổ chưa biết — đó chính
   * là ca `listTaggedResources` tồn tại để phát hiện. Bỏ rào khi sổ rỗng là tin sổ, và
   * ADR-08 nói sổ không được tin khi lệch với cloud.
   */
  it("rào wait-k8s-gone LUÔN có, kể cả khi không có tài nguyên k8s-* nào trong sổ", () => {
    const batches = teardownBatches([res("vpc", "vpc-1")]);
    expect(batches.map((b) => b.tier)).toEqual(["wait-k8s-gone", "vpc"]);
  });

  it("rào đứng NGAY SAU bậc k8s-managed và TRƯỚC mọi bậc network", () => {
    const batches = teardownBatches([
      res("k8s-loadbalancer", "elb-1"),
      res("vpc", "vpc-1"),
      res("nat-gateway", "nat-1"),
    ]);
    const tiers = batches.map((b) => b.tier);
    expect(tiers.indexOf("k8s-managed")).toBe(0);
    expect(tiers.indexOf("wait-k8s-gone")).toBe(1);
    expect(tiers.indexOf("wait-k8s-gone")).toBeLessThan(tiers.indexOf("nat"));
    expect(tiers.indexOf("wait-k8s-gone")).toBeLessThan(tiers.indexOf("vpc"));
  });

  it("gộp đúng nhiều tài nguyên cùng bậc", () => {
    const batches = teardownBatches([
      res("subnet", "sn-1"),
      res("subnet", "sn-2"),
      res("route-table", "rtb-1"),
    ]);
    const subnetRoute = batches.find((b) => b.tier === "subnet-route");
    expect(subnetRoute?.resources).toHaveLength(3);
  });
});

describe("discoverK8sManaged — lưới an toàn duy nhất cho thứ sổ không biết", () => {
  it("nhặt đúng tài nguyên mang tag kubernetes.io/cluster/<tên>", () => {
    const all = [
      res("k8s-loadbalancer", "elb-1", {
        tags: { "kubernetes.io/cluster/main": "owned" },
      }),
      res("k8s-eni", "eni-1", {
        tags: { "kubernetes.io/cluster/main": "shared" },
      }),
      res("vpc", "vpc-1", { tags: { "udp.project": "p" } }),
      res("k8s-volume", "vol-1", {
        tags: { "kubernetes.io/cluster/cluster-khac": "owned" },
      }),
    ];
    const found = discoverK8sManaged(all, "main");
    expect(found.map((r) => r.id).sort()).toEqual(["elb-1", "eni-1"]);
  });

  it("không có tag nào thì trả rỗng, không ném", () => {
    expect(discoverK8sManaged([res("vpc", "vpc-1")], "main")).toEqual([]);
  });
});

describe("waitGone — hết hạn KHÔNG phải thành công", () => {
  it("tài nguyên biến mất thì trả gone, polls đếm được", async () => {
    let calls = 0;
    const port: TeardownCloud = {
      deleteResource: () => Promise.resolve("deleted"),
      describeById: () => {
        calls += 1;
        return Promise.resolve(calls < 3 ? res("k8s-eni", "eni-1") : null);
      },
    };
    const result = await waitGone({
      resources: [res("k8s-eni", "eni-1")],
      cloud: port,
      timeoutMs: 10_000,
      pollIntervalMs: 100,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    expect(result.gone).toEqual(["eni-1"]);
    expect(result.stillThere).toEqual([]);
    expect(result.polls).toBe(3);
  });

  /**
   * Phép kiểm quan trọng nhất của mục này.
   *
   * Nếu `waitGone` coi timeout là thành công thì teardown báo "đã dọn xong" trong khi ELB
   * vẫn tồn tại và VPC không xoá được — hoá đơn vẫn chạy, và không một test nào chỉ kiểm
   * đường thành công sẽ thấy.
   */
  it("hết hạn mà còn sót ⇒ stillThere KHÔNG rỗng", async () => {
    let clock = 0;
    const port: TeardownCloud = {
      deleteResource: () => Promise.resolve("deleted"),
      describeById: (id) => Promise.resolve(res("k8s-eni", id)),
    };
    const result = await waitGone({
      resources: [res("k8s-eni", "eni-1")],
      cloud: port,
      timeoutMs: 500,
      pollIntervalMs: 100,
      now: () => {
        clock += 200;
        return clock;
      },
      sleep: () => Promise.resolve(),
    });
    expect(result.stillThere.map((r) => r.id)).toEqual(["eni-1"]);
    expect(result.gone).toEqual([]);
  });

  it("một phần biến mất, một phần còn sót ⇒ phân loại đúng cả hai", async () => {
    let clock = 0;
    const port: TeardownCloud = {
      deleteResource: () => Promise.resolve("deleted"),
      describeById: (id) =>
        Promise.resolve(id === "eni-1" ? null : res("k8s-volume", id)),
    };
    const result = await waitGone({
      resources: [res("k8s-eni", "eni-1"), res("k8s-volume", "vol-1")],
      cloud: port,
      timeoutMs: 300,
      pollIntervalMs: 100,
      now: () => {
        clock += 200;
        return clock;
      },
      sleep: () => Promise.resolve(),
    });
    expect(result.gone).toEqual(["eni-1"]);
    expect(result.stillThere.map((r) => r.id)).toEqual(["vol-1"]);
  });
});

describe("runTeardown — trên cloud mô phỏng THẬT", () => {
  it("xoá đúng thứ tự chín bậc, và DeleteVpc chỉ sau khi ELB biến mất", async () => {
    const vpc = cloud.createResource({
      kind: "vpc",
      name: "vpc",
      tags: { "udp.project": "p" },
      idempotencyKey: "k-vpc",
    });
    const elb = await cloud.seedK8sManaged({
      kind: "k8s-loadbalancer",
      clusterName: "main",
      attachedTo: vpc.id,
    });

    const outcome = await runTeardown({
      resources: [vpc, elb],
      cloud: cloudPort(cloud),
      waitTimeoutMs: 5_000,
      pollIntervalMs: 10,
      now: () => Date.now(),
      sleep: () => Promise.resolve(),
    });

    expect(outcome.tiers).toEqual(["k8s-managed", "wait-k8s-gone", "vpc"]);
    expect(outcome.orphans).toEqual([]);
    expect(await cloud.listAll()).toEqual([]);

    /** Nhật ký lời gọi là oracle: ELB phải bị xoá TRƯỚC VPC */
    const deletes = (await cloud.calls())
      .filter((c) => c.verb === "delete")
      .map((c) => c.kind);
    expect(deletes).toEqual(["k8s-loadbalancer", "vpc"]);
  });

  /**
   * Ô ÂM: bỏ rào chờ thì teardown **thất bại**, không phải "vẫn xanh nhưng chậm hơn".
   *
   * Cloud mô phỏng ném `DependencyViolation` khi VPC còn tài nguyên tham chiếu (S-9), nên
   * xoá VPC trước khi ELB biến mất là một lỗi có thật chứ không phải một sự khác biệt về
   * hiệu năng.
   */
  it("xoá VPC trước khi ELB biến mất ⇒ VPC thành orphan kèm chi phí", async () => {
    const vpc = cloud.createResource({
      kind: "vpc",
      name: "vpc",
      tags: { "udp.project": "p" },
      idempotencyKey: "k-vpc",
    });
    const elb = await cloud.seedK8sManaged({
      kind: "k8s-loadbalancer",
      clusterName: "main",
      attachedTo: vpc.id,
    });

    /** Sổ KHÔNG biết ELB — đúng ca mà state file mù */
    const outcome = await runTeardown({
      resources: [vpc],
      cloud: cloudPort(cloud),
      waitTimeoutMs: 100,
      pollIntervalMs: 10,
      now: () => Date.now(),
      sleep: () => Promise.resolve(),
    });

    expect(outcome.orphans).toHaveLength(1);
    expect(outcome.orphans[0]?.resource.id).toBe(vpc.id);
    expect(outcome.orphans[0]?.reason).toContain("DependencyViolation");
    /** ELB vẫn còn trên cloud, và nó vẫn đang tính tiền */
    expect((await cloud.listAll()).map((r) => r.id)).toContain(elb.id);
  });

  it("còn sót sau khi hết hạn chờ ⇒ orphan kèm USD/giờ, KHÔNG phải thành công", async () => {
    const vpc = cloud.createResource({
      kind: "vpc",
      name: "vpc",
      tags: { "udp.project": "p" },
      idempotencyKey: "k-vpc",
    });
    const elb = await cloud.seedK8sManaged({
      kind: "k8s-loadbalancer",
      clusterName: "main",
      attachedTo: vpc.id,
    });

    /** Cổng giả: `delete` không làm gì, nên ELB không bao giờ biến mất */
    const stubborn: TeardownCloud = {
      deleteResource: () => Promise.resolve("deleted"),
      describeById: (id) => Promise.resolve(cloud.describeById(id)),
    };

    let clock = 0;
    const outcome = await runTeardown({
      resources: [vpc, elb],
      cloud: stubborn,
      waitTimeoutMs: 300,
      pollIntervalMs: 100,
      now: () => {
        clock += 200;
        return clock;
      },
      sleep: () => Promise.resolve(),
    });

    const orphan = outcome.orphans.find((o) => o.resource.id === elb.id);
    expect(orphan).toBeDefined();
    expect(orphan?.reason).toContain("còn tồn tại sau");
    expect(orphan?.usdPerHour).toBe(ORPHAN_HOURLY_USD["k8s-loadbalancer"]);
    expect(outcome.estimatedOrphanUsdPerHour).toBeGreaterThan(0);
  });

  it("xoá thứ đã mất là THÀNH CÔNG, không ném (compensation chạy lại được)", async () => {
    const vpc = cloud.createResource({
      kind: "vpc",
      name: "vpc",
      tags: {},
      idempotencyKey: "k",
    });
    await cloud.deleteOutOfBand(vpc.id);

    const outcome = await runTeardown({
      resources: [vpc],
      cloud: cloudPort(cloud),
      waitTimeoutMs: 100,
      pollIntervalMs: 10,
      now: () => Date.now(),
      sleep: () => Promise.resolve(),
    });
    expect(outcome.orphans).toEqual([]);
    expect(outcome.deleted).toEqual([vpc.id]);
  });

  it("orphan không định giá được thì usdPerHour là null, không phải 0", async () => {
    const vpc = cloud.createResource({
      kind: "vpc",
      name: "vpc",
      tags: {},
      idempotencyKey: "k-vpc",
    });
    const rtb = cloud.createResource({
      kind: "route-table",
      name: "rtb",
      tags: {},
      idempotencyKey: "k-rtb",
    });
    /** Ép `route-table` giữ tham chiếu VPC để nó thành orphan khi xoá VPC trước */
    const failing: TeardownCloud = {
      deleteResource: (r) => {
        if (r.kind === "route-table") {
          return Promise.reject(new Error("không xoá được"));
        }
        return Promise.resolve(cloud.deleteResource(r.id));
      },
      describeById: (id) => Promise.resolve(cloud.describeById(id)),
    };

    const outcome = await runTeardown({
      resources: [vpc, rtb],
      cloud: failing,
      waitTimeoutMs: 100,
      pollIntervalMs: 10,
      now: () => Date.now(),
      sleep: () => Promise.resolve(),
    });

    const orphan = outcome.orphans.find(
      (o) => o.resource.kind === "route-table",
    );
    expect(orphan?.usdPerHour).toBeNull();
    /** Tổng chỉ cộng những cái định giá được — không lặng lẽ cộng 0 */
    expect(outcome.estimatedOrphanUsdPerHour).toBe(0);
  });
});

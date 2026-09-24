import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOKUP_INDETERMINATE, JOB_LEASE } from "@udp/config/constants";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResourceQuota } from "../src/cloud.js";
import {
  CloudAdapterRunner,
  FenceLostError,
  quotaRejection,
  SimulatedCrash,
  type RunPlan,
  type RunnerObserver,
  type RunnerPhase,
} from "../src/runner/index.js";
import { InMemoryLedger } from "../src/testing/in-memory-ledger.js";
import { SimCloud } from "../src/testing/sim-cloud.js";
import { credential, PROJECT, keyOf, simStep } from "./helpers/sim-steps.js";

/**
 * [v4.10] Mười bốn bất biến của `CloudAdapterRunner` (RUN1..RUN14).
 *
 * Hai bất biến cuối được kiểm bằng **quét cấu trúc** chứ không bằng hành vi, vì chúng nói
 * về hình dạng của mã: `rethrowIfFatal` phải là câu lệnh đầu của mọi `catch` (một `catch`
 * quên gọi nó là một lỗ không ai thấy trong code review), và runner không được giữ state ở
 * phạm vi module (nếu giữ thì resume thành công nhờ bộ nhớ chứ không nhờ sổ và tag, và
 * toàn bộ ADR-08 không được kiểm).
 */

const QUOTA: ResourceQuota = {
  maxNodes: 3,
  maxNodeSize: "medium",
  maxDatabases: 2,
  maxStorageGb: 50,
  maxLoadBalancers: 3,
};

let dir: string;
let cloud: SimCloud;
let ledger: InMemoryLedger;
let phases: { phase: RunnerPhase; step: string }[];
let fenceOk = true;

const observer = (): RunnerObserver => ({
  onPhase(phase, step) {
    phases.push({ phase, step });
  },
});

const runnerWith = (
  over: Partial<{ observer: RunnerObserver }> = {},
): CloudAdapterRunner =>
  new CloudAdapterRunner({
    ledger,
    fence: {
      assert: () =>
        fenceOk
          ? Promise.resolve()
          : Promise.reject(new FenceLostError("version đã đổi")),
    },
    observer: over.observer ?? observer(),
    /** Đồng hồ tiêm vào: vòng backoff không được làm test chờ thật */
    sleep: () => Promise.resolve(),
  });

const planWith = (steps: RunPlan["steps"]): RunPlan => ({
  projectId: PROJECT,
  provider: "aws",
  region: "ap-southeast-1",
  step: "NETWORK",
  steps,
  credential: credential(),
  quota: QUOTA,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-"));
  cloud = new SimCloud({ statePath: join(dir, "cloud.json") });
  ledger = new InMemoryLedger();
  phases = [];
  fenceOk = true;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("RUN1 + RUN2 — lookup trước create, ghi sổ trước create", () => {
  it("một lượt sạch: lookup rồi intend rồi create, theo đúng thứ tự", async () => {
    const out = await runnerWith().run(
      planWith([simStep(cloud, { name: "vpc" })]),
    );
    expect(out.status).toBe("SUCCESS");

    const order = phases.map((p) => p.phase);
    expect(order.indexOf("after-lookup")).toBeLessThan(
      order.indexOf("before-intend"),
    );
    expect(order.indexOf("after-intend")).toBeLessThan(
      order.indexOf("before-create"),
    );
  });

  it("sổ có hàng CREATING trước khi cloud có tài nguyên", async () => {
    const seen: string[] = [];
    const runner = runnerWith({
      observer: {
        async onPhase(phase) {
          if (phase === "before-create") {
            const row = await ledger.byKey(keyOf("vpc"));
            seen.push(row?.status ?? "khong-co-hang");
          }
        },
      },
    });
    await runner.run(planWith([simStep(cloud, { name: "vpc" })]));
    expect(seen).toEqual(["CREATING"]);
  });

  it("KHÔNG gọi create khi lookup đã thấy tài nguyên (RUN3, cách K3 được đóng)", async () => {
    /** Dựng sẵn tài nguyên trên cloud, như thể một lượt trước đã tạo xong */
    cloud.createResource({
      kind: "vpc",
      name: "vpc",
      tags: {
        "udp.project": PROJECT,
        "udp.key": keyOf("vpc"),
        "udp.owner": "x@y.z",
        "udp.managed": "true",
      },
      idempotencyKey: keyOf("vpc"),
    });

    const out = await runnerWith().run(
      planWith([simStep(cloud, { name: "vpc" })]),
    );
    expect(out.status).toBe("SUCCESS");

    const creates = (await cloud.calls()).filter((c) => c.verb === "create");
    expect(creates).toHaveLength(1); // chỉ lần dựng sẵn, runner không tạo thêm
    expect(
      (await cloud.listAll()).filter((r) => r.kind === "vpc"),
    ).toHaveLength(1);
  });
});

describe("RUN4 + RUN5 — indeterminate là lỗi TẠM", () => {
  it("cấm create, chờ rồi tra lại, hết lượt thì RETRYABLE", async () => {
    let calls = 0;
    const out = await runnerWith().run(
      planWith([
        simStep(cloud, {
          name: "vpc",
          lookupOverride: () => {
            calls += 1;
            return Promise.resolve({
              kind: "indeterminate",
              reason: "cửa sổ lan truyền tag",
            });
          },
        }),
      ]),
    );

    expect(out.status).toBe("RETRYABLE");
    expect(calls).toBe(LOOKUP_INDETERMINATE.maxAttempts);
    /** Không một lời gọi create nào */
    expect(
      (await cloud.calls()).filter((c) => c.verb === "create"),
    ).toHaveLength(0);
  });

  /**
   * Hàng giữ `CREATING`, KHÔNG phải `ORPHAN_SUSPECTED`.
   *
   * `ORPHAN_SUSPECTED` không có cạnh ra (§4.5), nên đặt nó ở đây biến một blip mạng thành
   * hỏng vĩnh viễn và vỡ chính yêu cầu (b) của I31 — "hội tụ về READY hoặc DELETED".
   */
  it("hàng KHÔNG bị đặt ORPHAN_SUSPECTED, và lượt sau hội tụ được", async () => {
    let indeterminate = true;
    const step = simStep(cloud, {
      name: "vpc",
      lookupOverride: () =>
        Promise.resolve(
          indeterminate
            ? { kind: "indeterminate", reason: "chưa thấy" }
            : { kind: "absent" },
        ),
    });

    const first = await runnerWith().run(planWith([step]));
    expect(first.status).toBe("RETRYABLE");
    const afterFail = await ledger.byKey(keyOf("vpc"));
    expect(afterFail).toBeNull(); // chưa intend vì lookup chưa quyết được

    indeterminate = false;
    const second = await runnerWith().run(planWith([step]));
    expect(second.status).toBe("SUCCESS");
    expect((await ledger.byKey(keyOf("vpc")))?.status).toBe("READY");
  });

  /**
   * Bất biến của hằng số, không của mã: tổng backoff phải ≤ nửa lease.
   *
   * Vòng chờ này nằm TRONG một lượt job đang giữ lease. Nếu tổng thời gian chờ vượt lease
   * thì worker thứ hai nhận job và hai worker cùng lookup/create — tức chính bản sửa
   * `indeterminate` tạo ra điểm crash K9.
   */
  it("tổng backoff ≤ nửa lease của ProvisioningJob", () => {
    let total = 0;
    for (let n = 1; n <= LOOKUP_INDETERMINATE.maxAttempts; n += 1) {
      total += n * LOOKUP_INDETERMINATE.backoffStepMs;
    }
    expect(total).toBeLessThanOrEqual((JOB_LEASE.durationSeconds * 1000) / 2);
  });
});

describe("RUN6 — chỉ READY là xong", () => {
  it("waitReady phải xong mới markReady; CREATED chưa phải là xong", async () => {
    const out = await runnerWith().run(
      planWith([simStep(cloud, { name: "vpc", waitReadyCalls: 1 })]),
    );
    expect(out.status).toBe("SUCCESS");
    expect((await ledger.byKey(keyOf("vpc")))?.status).toBe("READY");
  });

  it("waitReady ném ⇒ hàng KHÔNG tới READY, và compensation chạy", async () => {
    const out = await runnerWith().run(
      planWith([simStep(cloud, { name: "vpc", waitReadyCalls: 2 })]),
    );
    expect(out.status).toBe("COMPENSATED");
    expect((await ledger.byKey(keyOf("vpc")))?.status).toBe("DELETED");
  });
});

describe("RUN7 — lookupById là đường dự phòng (điểm crash K8)", () => {
  it("khách xoá tag udp.key: runner tìm lại bằng provider_id trong sổ, không tạo trùng", async () => {
    const step = simStep(cloud, { name: "vpc" });

    /** Lượt một: tạo xong */
    await runnerWith().run(planWith([step]));
    const row = await ledger.byKey(keyOf("vpc"));
    expect(row?.providerId).not.toBeNull();

    /** Khách xoá tag, rồi ép hàng về CREATING như thể crash trước khi markReady */
    await cloud.removeTag(row?.providerId as string, "udp.key");
    const fresh = new InMemoryLedger();
    await fresh.intend({
      projectId: PROJECT,
      step: "NETWORK",
      kind: "vpc",
      idempotencyKey: keyOf("vpc"),
      provider: "aws",
      region: "ap-southeast-1",
    });
    await fresh.markCreated(keyOf("vpc"), row?.providerId as string);
    ledger = fresh;

    const before = (await cloud.calls()).filter(
      (c) => c.verb === "create",
    ).length;
    const out = await runnerWith().run(planWith([step]));
    const after = (await cloud.calls()).filter(
      (c) => c.verb === "create",
    ).length;

    expect(out.status).toBe("SUCCESS");
    expect(after).toBe(before); // KHÔNG tạo trùng
  });
});

describe("RUN8 + RUN9 — compensation ngược thứ tự steps, NOT_FOUND là thành công", () => {
  it("xoá theo thứ tự NGƯỢC của steps, không của sổ", async () => {
    const steps = [
      simStep(cloud, { name: "vpc" }),
      simStep(cloud, { name: "subnet", kind: "subnet", dependsOn: "vpc" }),
      simStep(cloud, {
        name: "nat",
        kind: "nat-gateway",
        createThrows: () => {
          throw new Error("hết elastic IP");
        },
      }),
    ];

    const out = await runnerWith().run(planWith(steps));
    expect(out.status).toBe("COMPENSATED");

    const deletes = (await cloud.calls())
      .filter((c) => c.verb === "delete")
      .map((c) => c.kind);
    expect(deletes).toEqual(["subnet", "vpc"]);
  });

  it("khách đã xoá ngoài luồng ⇒ compensation coi như xong, không ném (K7)", async () => {
    const steps = [
      simStep(cloud, { name: "vpc" }),
      simStep(cloud, {
        name: "nat",
        kind: "nat-gateway",
        createThrows: () => {
          throw new Error("vỡ");
        },
      }),
    ];
    /** Tạo vpc trước, rồi xoá nó ngoài luồng ngay khi step thứ hai vỡ */
    const runner = new CloudAdapterRunner({
      ledger,
      fence: { assert: () => Promise.resolve() },
      observer: {
        async onPhase(phase, step) {
          if (phase === "before-create" && step === "nat") {
            const all = await cloud.listAll();
            const vpc = all.find((r) => r.kind === "vpc");
            if (vpc !== undefined) await cloud.deleteOutOfBand(vpc.id);
          }
        },
      },
      sleep: () => Promise.resolve(),
    });

    const out = await runner.run(planWith(steps));
    expect(out.status).toBe("COMPENSATED");
    expect((await ledger.byKey(keyOf("vpc")))?.status).toBe("DELETED");
  });
});

describe("RUN10 — quota kiểm TRƯỚC mọi lời gọi cloud", () => {
  it("vượt trần node ⇒ 0 lời gọi cloud", async () => {
    const plan = {
      ...planWith([simStep(cloud, { name: "vpc" })]),
      plannedNodes: 99,
    };
    const out = await runnerWith().run(plan);
    expect(out.status).toBe("QUOTA_REJECTED");
    expect(await cloud.calls()).toHaveLength(0);
  });

  it("vượt trần load balancer ⇒ 0 lời gọi cloud", async () => {
    const plan = {
      ...planWith([simStep(cloud, { name: "vpc" })]),
      plannedLoadBalancers: 99,
    };
    const out = await runnerWith().run(plan);
    expect(out.status).toBe("QUOTA_REJECTED");
    expect(await cloud.calls()).toHaveLength(0);
  });

  it("quotaRejection là hàm THUẦN, dùng lại được ở estimateCost", () => {
    expect(quotaRejection({ quota: QUOTA, plannedNodes: 3 })).toBeNull();
    /**
     * Khẳng định theo TÊN CHIỀU, không theo một từ trong câu: `quotaRejection` nay uỷ
     * quyền cho `quotaViolations`, và thông điệp mang tên chiều (`maxNodes`) để người đọc
     * biết chiều nào bị vượt thay vì phải suy từ văn.
     */
    expect(quotaRejection({ quota: QUOTA, plannedNodes: 4 })).toContain(
      "maxNodes",
    );
    expect(quotaRejection({ quota: QUOTA })).toBeNull();
  });
});

describe("RUN11 — fence.assert ở sáu chốt, và mất lease là CHÍ TỬ", () => {
  it("mất lease ⇒ ném FenceLostError, KHÔNG rơi vào compensation", async () => {
    fenceOk = false;
    await expect(
      runnerWith().run(planWith([simStep(cloud, { name: "vpc" })])),
    ).rejects.toBeInstanceOf(FenceLostError);
    /** Không lời gọi cloud nào, và không compensation nào */
    expect(
      (await cloud.calls()).filter((c) => c.verb === "delete"),
    ).toHaveLength(0);
  });

  it("crash mô phỏng cũng CHÍ TỬ — kill -9 không chạy catch", async () => {
    const runner = new CloudAdapterRunner({
      ledger,
      fence: { assert: () => Promise.resolve() },
      observer: {
        onPhase(phase) {
          if (phase === "after-create-commit") {
            throw new SimulatedCrash(phase);
          }
        },
      },
      sleep: () => Promise.resolve(),
    });

    await expect(
      runner.run(planWith([simStep(cloud, { name: "vpc" })])),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    /** Tài nguyên ĐÃ tồn tại trên cloud, nhưng sổ chưa biết id — đây là K3 */
    expect(await cloud.listAll()).toHaveLength(1);
    expect((await ledger.byKey(keyOf("vpc")))?.providerId).toBeNull();
    expect(
      (await cloud.calls()).filter((c) => c.verb === "delete"),
    ).toHaveLength(0);
  });
});

describe("RUN12 — prior chỉ chứa step đứng trước, khoá theo name", () => {
  it("step sau đọc được prior của step trước", async () => {
    const out = await runnerWith().run(
      planWith([
        simStep(cloud, { name: "vpc" }),
        simStep(cloud, { name: "subnet", kind: "subnet", dependsOn: "vpc" }),
      ]),
    );
    expect(out.status).toBe("SUCCESS");
    if (out.status === "SUCCESS") {
      expect(Object.keys(out.created).sort()).toEqual(["subnet", "vpc"]);
    }
  });

  it("step đọc prior của step SAU nó thì vỡ — prior không nhìn về tương lai", async () => {
    const out = await runnerWith().run(
      planWith([
        simStep(cloud, { name: "vpc", dependsOn: "subnet" }),
        simStep(cloud, { name: "subnet", kind: "subnet" }),
      ]),
    );
    expect(out.status).toBe("COMPENSATED");
  });
});

describe("RUN13 — rethrowIfFatal là câu lệnh ĐẦU của mọi catch (quét cấu trúc)", () => {
  /**
   * Phép kiểm này nói về HÌNH DẠNG của mã, không về hành vi, vì một `catch` quên gọi
   * `rethrowIfFatal` là một lỗ không ai thấy trong code review: mã vẫn chạy, test hành vi
   * vẫn xanh, và chỉ đúng ô lưới đi qua nhánh đó mới sai — theo một hướng khó truy.
   */
  const source = readFileSync(
    new URL("../src/runner/runner.ts", import.meta.url),
    "utf8",
  );

  it("có ít nhất bốn khối catch trong runner", () => {
    const count = [...source.matchAll(/\}\s*catch\s*\(/g)].length;
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it("MỌI khối catch mở đầu bằng rethrowIfFatal", () => {
    const offenders: string[] = [];
    const re = /catch\s*\(\s*(\w+)\s*\)\s*\{([\s\S]{0,200}?)(?:\n\s*\}|;)/g;
    for (const m of source.matchAll(re)) {
      const binding = m[1] as string;
      const body = (m[2] as string).trimStart();
      /** Bỏ qua chú thích mở đầu: chúng không phải câu lệnh */
      const withoutComments = body
        .replace(/^\/\*[\s\S]*?\*\/\s*/, "")
        .replace(/^\/\/.*\n\s*/, "")
        .trimStart();
      if (!withoutComments.startsWith(`rethrowIfFatal(${binding})`)) {
        offenders.push(withoutComments.slice(0, 60));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("RUN14 — runner KHÔNG giữ state ở phạm vi module", () => {
  /**
   * Bất biến vô hình nhất của cả pha.
   *
   * Nếu runner giữ bất cứ thứ gì ở module scope — một cache lookup, một map `prior`, một
   * danh sách id đã tạo — thì resume thành công **nhờ bộ nhớ** chứ không nhờ sổ và tag, và
   * toàn bộ ADR-08 không được kiểm. Lưới vẫn 10/10 xanh, chỉ là nó đang chứng minh một
   * thứ khác.
   */
  const source = readFileSync(
    new URL("../src/runner/runner.ts", import.meta.url),
    "utf8",
  );

  it("không có let hay var ở cấp module", () => {
    const moduleLevel = [...source.matchAll(/^(let|var)\s+\w+/gm)].map(
      (m) => m[0],
    );
    expect(moduleLevel).toEqual([]);
  });

  it("không có Map, Set hay mảng nào ở cấp module", () => {
    const containers = [
      ...source.matchAll(/^const\s+\w+\s*(?::[^=]*)?=\s*(new (Map|Set)|\[)/gm),
    ].map((m) => m[0]);
    expect(containers).toEqual([]);
  });

  it("hai thực thể runner không chia sẻ gì: lượt sau vẫn phải đọc lại sổ", async () => {
    const step = simStep(cloud, { name: "vpc" });
    await runnerWith().run(planWith([step]));

    /** Sổ mới, cloud cũ — như thể database khôi phục từ backup trống */
    ledger = new InMemoryLedger();
    const out = await runnerWith().run(planWith([step]));
    expect(out.status).toBe("SUCCESS");
    /** Không tạo trùng: nó phải tìm lại qua tag, không qua bộ nhớ */
    expect(
      (await cloud.listAll()).filter((r) => r.kind === "vpc"),
    ).toHaveLength(1);
  });
});

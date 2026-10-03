import type { DomainAdapter } from "@udp/adapter-core";
import type {
  AdapterResult,
  CapabilityBinding,
  CapabilityRequirement,
} from "@udp/shared-types";
import { env } from "@udp/config";
import { createPrismaClient, type PrismaClient } from "@udp/db";
import { stableOwner } from "@udp/test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyDomainChange,
  type DomainChange,
} from "../src/modules/capability/domain-config.diff.js";
import { upsertBinding } from "../src/modules/capability/capability-binding.repository.js";
import {
  changedBindings,
  restorePort,
  upgradeDomain,
  type DomainUpgradePorts,
  type UpgradeRequest,
} from "../src/modules/day2/domain-upgrade.js";
import {
  notifyDependents,
  type Dependent,
} from "../src/modules/day2/dependent-notify.js";

/**
 * [v4.10] Cổng P21 - §8.6 nhánh B, bốn quy tắc của luồng nâng cấp thành bốn nhóm ô.
 *
 * Mỗi nhóm ô dưới đây kiểm một quy tắc, và mỗi quy tắc có một hậu quả cụ thể nếu sai:
 *
 * | Quy tắc | Nếu sai thì |
 * | --- | --- |
 * | 409 khi có rollout đang chạy | Cửa sổ so sánh của canary đổi hệ quy chiếu giữa chừng (§7.4) |
 * | Validator chạy trước khi chạm cluster | Canary analysis hỏng SAU khi đã nâng xong, không ai chặn được |
 * | Thất bại thì hạ về bản cũ | Cluster ở trạng thái lửng lơ, `adapter_version` không khớp thực tế |
 * | `adapter_version` đổi cùng transaction với rebind | Một lần crash giữa hai `UPDATE` làm mọi lượt quét sau báo trôi giả |
 */

const CONFIG = { enabled: true };
const schema = z.object({ enabled: z.boolean() });

interface StubOptions {
  upgradeResult?: AdapterResult<CapabilityBinding[]>;
  healthResult?: AdapterResult<{ healthy: boolean; details?: string }>;
}

const BINDING: CapabilityBinding = {
  id: "metrics.query",
  version: "2.0.0",
  providedBy: "monitoring:stub",
  endpoint: "http://stub.udp-system:9090",
};

/** Adapter bù nhìn: nó ghi lại lời gọi và trả đúng thứ ô test muốn */
function stubAdapter(options: StubOptions = {}): {
  adapter: DomainAdapter;
  calls: string[];
} {
  const calls: string[] = [];
  const adapter: DomainAdapter = {
    domainType: "MONITORING",
    toolId: "stub",
    version: "2.0.0",
    scope: "cluster",
    capabilities: {
      provides: [{ id: "metrics.query", version: "2.0.0" }],
      requires: [],
    },
    configSchema: schema,
    deploy: () => {
      calls.push("deploy");
      return Promise.resolve({ status: "SUCCESS", data: [BINDING] });
    },
    configure: () => {
      calls.push("configure");
      return Promise.resolve({ status: "SUCCESS", data: [BINDING] });
    },
    upgrade: () => {
      calls.push("upgrade");
      return Promise.resolve(
        options.upgradeResult ?? { status: "SUCCESS", data: [BINDING] },
      );
    },
    detectDrift: () => {
      calls.push("detectDrift");
      return Promise.resolve({ status: "SUCCESS", data: { drifted: false } });
    },
    onDependencyChanged: () => {
      calls.push("onDependencyChanged");
      return Promise.resolve({ status: "SUCCESS" });
    },
    healthcheck: () => {
      calls.push("healthcheck");
      return Promise.resolve(
        options.healthResult ?? { status: "SUCCESS", data: { healthy: true } },
      );
    },
    teardown: () => {
      calls.push("teardown");
      return Promise.resolve({ status: "SUCCESS" });
    },
  };
  return { adapter, calls };
}

function request(adapter: DomainAdapter): UpgradeRequest {
  return {
    target: adapter,
    fromVersion: "1.0.0",
    config: CONFIG,
    capabilitiesOfOldVersion: ["metrics.query"],
    currentBindings: [{ ...BINDING, endpoint: "http://cu.udp-system:9090" }],
  };
}

interface Recorded {
  persisted: { adapterVersion: string }[];
  rollbacks: number;
  errors: string[];
}

function ports(
  adapter: DomainAdapter,
  over: Partial<DomainUpgradePorts> = {},
): { ports: DomainUpgradePorts; log: Recorded } {
  const log: Recorded = { persisted: [], rollbacks: 0, errors: [] };
  const base: DomainUpgradePorts = {
    rolloutInProgress: () => Promise.resolve(false),
    declarationsAfterUpgrade: () => [
      {
        domainType: adapter.domainType,
        toolId: adapter.toolId,
        capabilities: adapter.capabilities,
      },
    ],
    contextFor: () =>
      Promise.resolve({
        signedImages: null,
        k8s: {
          mode: "direct",
          clusterId: "c-stub",
          getClient: () =>
            Promise.reject(new Error("ô này không chạm tới cluster")),
          proxyService: () => Promise.reject(new Error("không dùng")),
          issuerKeys: () => Promise.reject(new Error("không dùng")),
          probe: () =>
            Promise.resolve({
              status: "SUCCESS" as const,
              data: { reachable: true },
            }),
        },
        environments: [],
        systemNamespace: "udp-system",
        region: "ap-southeast-1",
        quota: {
          maxNodes: 3,
          maxNodeSize: "medium",
          maxDatabases: 1,
          maxStorageGb: 10,
          maxLoadBalancers: 1,
        },
        resolved: {},
        tags: {},
        progress: () => undefined,
        fetch: () => Promise.reject(new Error("không dùng")),
      }),
    rollback: () => {
      log.rollbacks += 1;
      return Promise.resolve({ status: "SUCCESS" });
    },
    persist: (args) => {
      log.persisted.push({ adapterVersion: args.adapterVersion });
      return Promise.resolve();
    },
    recordError: (message) => {
      log.errors.push(message);
      return Promise.resolve();
    },
  };
  return { ports: { ...base, ...over }, log };
}

describe("quy tắc 1 - rollout đang chạy ⇒ 409, chưa chạm gì cả", () => {
  it("từ chối với 409 và KHÔNG gọi adapter lần nào", async () => {
    const { adapter, calls } = stubAdapter();
    const { ports: p, log } = ports(adapter, {
      rolloutInProgress: () => Promise.resolve(true),
    });

    const res = await upgradeDomain(request(adapter), p);

    expect(res.status).toBe("REFUSED");
    expect(res.code).toBe("ROLLOUT_IN_PROGRESS");
    expect(res.httpStatus).toBe(409);
    /**
     * "Chưa chạm gì cả" là phần đáng kiểm, không phải mã lỗi.
     *
     * Một hiện thực gọi `upgrade()` rồi mới kiểm rollout vẫn trả 409 và vẫn xanh ở một ô
     * chỉ so mã lỗi - trong khi chart đã được áp lên cluster rồi.
     */
    expect(calls).toEqual([]);
    expect(log.persisted).toEqual([]);
    expect(log.rollbacks).toBe(0);
  });
});

describe("quy tắc 2 - validator chạy TRƯỚC khi chạm cluster", () => {
  it("khai báo bản mới phá constraint của consumer ⇒ 422, không gọi adapter", async () => {
    const { adapter, calls } = stubAdapter();
    /**
     * Ví dụ THẬT của §8.6: Prometheus bản mới đổi `metrics.query` lên `3.0.0`, và Flagger
     * khai `constraint: "^2"`. Đây là ca mà "chạy lại validator" tồn tại để bắt.
     */
    const { ports: p, log } = ports(adapter, {
      declarationsAfterUpgrade: () => [
        {
          domainType: "MONITORING",
          toolId: "stub",
          capabilities: {
            provides: [{ id: "metrics.query", version: "3.0.0" }],
            requires: [],
          },
        },
        {
          domainType: "PROGRESSIVE_DELIVERY",
          toolId: "flagger",
          capabilities: {
            provides: [{ id: "traffic.control", version: "1.0.0" }],
            requires: [{ id: "metrics.query", constraint: "^2" }],
          },
        },
      ],
    });

    const res = await upgradeDomain(request(adapter), p);

    expect(res.status).toBe("REFUSED");
    expect(res.code).toBe("CAPABILITY_INVALID");
    expect(res.httpStatus).toBe(422);
    expect(res.errors?.[0]?.code).toBe("VERSION_MISMATCH");
    expect(calls).toEqual([]);
    expect(log.persisted).toEqual([]);
  });
});

describe("quy tắc 3 - thất bại thì hạ về bản cũ", () => {
  it("upgrade FAILED ⇒ hạ về bản cũ, KHÔNG ghi version mới", async () => {
    const { adapter, calls } = stubAdapter({
      upgradeResult: { status: "FAILED", message: "chart không tải được" },
    });
    const { ports: p, log } = ports(adapter);

    const res = await upgradeDomain(request(adapter), p);

    expect(res.status).toBe("ROLLED_BACK");
    expect(calls).toEqual(["upgrade"]);
    expect(log.rollbacks).toBe(1);
    expect(log.persisted).toEqual([]);
    expect(log.errors[0]).toContain("1.0.0");
  });

  it("healthcheck healthy = false ⇒ hạ về bản cũ, KHÔNG ghi version mới", async () => {
    const { adapter, calls } = stubAdapter({
      healthResult: {
        status: "SUCCESS",
        data: { healthy: false, details: "pod CrashLoopBackOff" },
      },
    });
    const { ports: p, log } = ports(adapter);

    const res = await upgradeDomain(request(adapter), p);

    expect(res.status).toBe("ROLLED_BACK");
    expect(res.message).toContain("CrashLoopBackOff");
    expect(calls).toEqual(["upgrade", "healthcheck"]);
    expect(log.persisted).toEqual([]);
  });

  /**
   * Hạ về bản cũ cũng thất bại là một trạng thái KHÁC, và nó phải kêu to.
   *
   * Gộp nó vào `ROLLED_BACK` nghĩa là Portal nói "đã hạ về bản cũ" trong khi cluster đang
   * ở một trạng thái không ai biết - và đó là loại thông báo tệ hơn không có thông báo,
   * vì nó làm người vận hành thôi tìm.
   */
  it("hạ về bản cũ cũng thất bại ⇒ ROLLBACK_FAILED, và lỗi ghi cả hai nguyên nhân", async () => {
    const { adapter } = stubAdapter({
      upgradeResult: { status: "FAILED", message: "chart không tải được" },
    });
    const { ports: p, log } = ports(adapter, {
      rollback: () =>
        Promise.resolve({ status: "FAILED", message: "helm rollback timeout" }),
    });

    const res = await upgradeDomain(request(adapter), p);

    expect(res.status).toBe("ROLLBACK_FAILED");
    expect(log.persisted).toEqual([]);
    expect(log.errors[0]).toContain("chart không tải được");
    expect(log.errors[0]).toContain("helm rollback timeout");
  });

  it("upgrade SUCCESS mà không có binding ⇒ vẫn hạ về bản cũ", async () => {
    /**
     * `AdapterResult.data` là tuỳ chọn ở tầng kiểu, nên ca này biên dịch được và sẽ xảy ra.
     * Ghi `adapter_version` mới dựa trên một danh sách binding vắng nghĩa là binding cũ
     * nằm lại trong bảng trong khi version đã nhảy - và `detectDrift` sau đó so với một
     * cặp (version, binding) không tồn tại ở đâu cả.
     */
    const { adapter } = stubAdapter({ upgradeResult: { status: "SUCCESS" } });
    const { ports: p, log } = ports(adapter);

    const res = await upgradeDomain(request(adapter), p);

    expect(res.status).toBe("ROLLED_BACK");
    expect(log.persisted).toEqual([]);
  });
});

describe("quy tắc 4 - xanh thì ghi version mới và trả danh sách phải thông báo", () => {
  it("UPGRADED, persist đúng version đích, changed chỉ chứa binding đã đổi", async () => {
    const { adapter, calls } = stubAdapter();
    const { ports: p, log } = ports(adapter);

    const res = await upgradeDomain(request(adapter), p);

    expect(res.status).toBe("UPGRADED");
    expect(res.httpStatus).toBe(202);
    expect(calls).toEqual(["upgrade", "healthcheck"]);
    expect(log.persisted).toEqual([{ adapterVersion: "2.0.0" }]);
    expect(log.rollbacks).toBe(0);
    /** Endpoint đổi ⇒ consumer phải nghe tin */
    expect(res.changed).toEqual([BINDING]);
  });

  it("binding y nguyên ⇒ danh sách thông báo RỖNG", () => {
    expect(changedBindings([BINDING], [BINDING])).toEqual([]);
  });

  it("binding mới xuất hiện ⇒ có trong danh sách", () => {
    const them: CapabilityBinding = {
      id: "metrics.scrape",
      version: "1.0.0",
      providedBy: "monitoring:stub",
      endpoint: "http://stub.udp-system:9090/api/v1/write",
    };
    expect(changedBindings([BINDING], [BINDING, them])).toEqual([them]);
  });

  it("chỉ version schema đổi (endpoint y nguyên) ⇒ vẫn phải thông báo", () => {
    const moi: CapabilityBinding = { ...BINDING, version: "2.1.0" };
    expect(changedBindings([BINDING], [moi])).toEqual([moi]);
  });
});

describe("nửa THÔNG BÁO của CASE 3 - notifyDependents", () => {
  function dependent(
    id: string,
    requires: CapabilityRequirement[],
    result: AdapterResult<void> = { status: "SUCCESS" },
  ): { dep: Dependent; calls: number } {
    const state = { calls: 0 };
    const { adapter } = stubAdapter();
    const dep: Dependent = {
      domainConfigId: id,
      adapter: {
        ...adapter,
        toolId: id,
        capabilities: { provides: [], requires },
        onDependencyChanged: () => {
          state.calls += 1;
          return Promise.resolve(result);
        },
      },
      config: CONFIG,
    };
    return {
      dep,
      get calls() {
        return state.calls;
      },
    };
  }

  it("consumer tiêu thụ capability thì được gọi; consumer khác thì SKIPPED", async () => {
    const a = dependent("flagger", [{ id: "metrics.query", constraint: "^2" }]);
    const b = dependent("harbor", [{ id: "registry.oci" }]);
    const failures: string[] = [];

    const out = await notifyDependents([BINDING], [a.dep, b.dep], {
      contextFor: () => Promise.resolve(notifyContext()),
      recordFailure: (id) => {
        failures.push(id);
        return Promise.resolve();
      },
    });

    expect(out.map((o) => o.status)).toEqual(["NOTIFIED", "SKIPPED"]);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);
    expect(failures).toEqual([]);
  });

  /**
   * Một consumer lỗi KHÔNG dừng những consumer còn lại.
   *
   * Và lỗi được ghi vào `last_error` của ĐÚNG consumer đã lỗi: ghi vào provider nghĩa là
   * Portal chỉ vào Prometheus trong khi thứ hỏng là Flagger.
   */
  it("một consumer lỗi: lỗi ghi vào đúng consumer, vòng vẫn chạy tiếp", async () => {
    const xau = dependent("flagger", [{ id: "metrics.query" }], {
      status: "FAILED",
      message: "không áp lại được Canary CR",
    });
    const tot = dependent("grafana-agent", [{ id: "metrics.query" }]);
    const failures: string[] = [];

    const out = await notifyDependents([BINDING], [xau.dep, tot.dep], {
      contextFor: () => Promise.resolve(notifyContext()),
      recordFailure: (id, message) => {
        failures.push(`${id}:${message}`);
        return Promise.resolve();
      },
    });

    expect(out.map((o) => o.status)).toEqual(["FAILED", "NOTIFIED"]);
    expect(tot.calls).toBe(1);
    expect(failures).toEqual(["flagger:không áp lại được Canary CR"]);
  });
});

/** Bối cảnh tối thiểu cho `notifyDependents` - không ô nào ở trên chạm cluster */
function notifyContext(): Parameters<Dependent["adapter"]["deploy"]>[0] {
  return {
    signedImages: null,
    k8s: {
      mode: "direct",
      clusterId: "c-notify",
      getClient: () => Promise.reject(new Error("không dùng")),
      proxyService: () => Promise.reject(new Error("không dùng")),
      issuerKeys: () => Promise.reject(new Error("không dùng")),
      probe: () =>
        Promise.resolve({
          status: "SUCCESS" as const,
          data: { reachable: true },
        }),
    },
    environments: [],
    systemNamespace: "udp-system",
    region: "ap-southeast-1",
    quota: {
      maxNodes: 1,
      maxNodeSize: "small",
      maxDatabases: 0,
      maxStorageGb: 1,
      maxLoadBalancers: 0,
    },
    resolved: {},
    tags: {},
    progress: () => undefined,
    fetch: () => Promise.reject(new Error("không dùng")),
  };
}

/**
 * Quy tắc 4 ở tầng DATABASE - `adapter_version` và rebind trong MỘT transaction.
 *
 * Phải là database thật: khẳng định "cùng một transaction" là khẳng định về việc cả hai
 * cùng thấy hoặc cùng không, và một fake không có transaction để mà cuộn lại.
 */
const admin: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_day2_upgrade_admin",
});

const PROJECT = "21212121-2121-4121-8121-212121212122";
let configId = "";

beforeAll(async () => {
  const owner = await stableOwner(admin);
  await admin.capabilityBinding.deleteMany({
    where: { domainConfig: { projectId: PROJECT } },
  });
  await admin.domainConfig.deleteMany({ where: { projectId: PROJECT } });
  await admin.project.deleteMany({ where: { id: PROJECT } });
  await admin.project.create({
    data: {
      id: PROJECT,
      ownerId: owner.id,
      name: "day2 upgrade P21",
      creationMode: "CREATE_NEW",
      languageRuntime: "node20",
      resourceQuota: {},
    },
  });
  const cfg = await admin.domainConfig.create({
    data: {
      projectId: PROJECT,
      domainType: "MONITORING",
      isEnabled: true,
      domainStatus: "ACTIVE",
      selectedTool: "stub",
      adapterVersion: "1.0.0",
    },
    select: { id: true },
  });
  configId = cfg.id;
});

beforeEach(async () => {
  await admin.domainConfig.update({
    where: { id: configId },
    data: { adapterVersion: "1.0.0" },
  });
  await upsertBinding(admin, {
    domainConfigId: configId,
    capabilityId: "metrics.query",
    schemaVersion: "2.0.0",
    providedBy: "monitoring:stub",
    endpoint: "http://cu.udp-system:9090",
    environmentId: null,
  });
});

afterAll(async () => {
  await admin.capabilityBinding.deleteMany({
    where: { domainConfig: { projectId: PROJECT } },
  });
  await admin.domainConfig.deleteMany({ where: { projectId: PROJECT } });
  await admin.project.deleteMany({ where: { id: PROJECT } });
  await admin.$disconnect();
});

describe("quy tắc 4 trên database thật", () => {
  it("adapter_version và endpoint mới cùng commit một lần", async () => {
    const change: DomainChange = {
      domainConfigId: configId,
      domainType: "MONITORING",
      selectedTool: "stub",
      capabilitiesOfOldTool: ["metrics.query"],
      adapterVersion: "2.0.0",
      rebind: [
        {
          capabilityId: "metrics.query",
          providedBy: "monitoring:stub",
          schemaVersion: "2.0.0",
          endpoint: "http://moi.udp-system:9090",
        },
      ],
    };

    const outcome = await applyDomainChange(admin, PROJECT, change);

    expect(outcome.bindingsRebound).toBe(1);
    const row = await admin.domainConfig.findUniqueOrThrow({
      where: { id: configId },
      select: { adapterVersion: true, bindings: true },
    });
    expect(row.adapterVersion).toBe("2.0.0");
    expect(row.bindings[0]?.endpoint).toBe("http://moi.udp-system:9090");
  });

  it("không khai adapterVersion ⇒ cột GIỮ NGUYÊN", async () => {
    await applyDomainChange(admin, PROJECT, {
      domainConfigId: configId,
      domainType: "MONITORING",
      selectedTool: "stub",
      capabilitiesOfOldTool: ["metrics.query"],
      rebind: [
        {
          capabilityId: "metrics.query",
          providedBy: "monitoring:stub",
          schemaVersion: "2.0.0",
          endpoint: "http://doi-tool.udp-system:9090",
        },
      ],
    });

    const row = await admin.domainConfig.findUniqueOrThrow({
      where: { id: configId },
      select: { adapterVersion: true },
    });
    /**
     * Bật, tắt hay đổi tool KHÔNG được chạm cột này.
     *
     * Đổi tool rồi vô tình ghi `adapter_version` của tool cũ sang tool mới làm mọi lượt
     * `detectDrift` so với một version của một tool khác - và nó báo trôi mãi mãi.
     */
    expect(row.adapterVersion).toBe("1.0.0");
  });
});

/**
 * [Plan #61 61d-3a] Cổng hạ về dựng từ chính adapter — quy tắc 3 của §8.6 lần đầu có hiệu lực thật.
 *
 * Trước đợt này job cắm cứng `rollback: () => FAILED` kèm chú thích thật thà "registry chỉ nạp một bản adapter,
 * không có bản cũ để hạ về". Hệ quả: MỌI lần nâng cấp thất bại ra `ROLLBACK_FAILED` với cụm không được hạ về —
 * trái đúng câu "không để trạng thái lửng lơ". Hai ô dưới đây chốt cả hai chiều của bản sửa.
 */
describe("restorePort - cổng hạ về dựng từ adapter (61d-3a)", () => {
  const failing = (): AdapterResult<CapabilityBinding[]> => ({
    status: "FAILED",
    message: "chart mới không lên",
  });

  it("adapter CÓ restoreTo ⇒ hạ về thật, luồng ra ROLLED_BACK chứ không ROLLBACK_FAILED", async () => {
    const restored: string[] = [];
    const { adapter } = stubAdapter({ upgradeResult: failing() });
    const withRestore: DomainAdapter = {
      ...adapter,
      restoreTo: (_ctx, _config, version) => {
        restored.push(version);
        return Promise.resolve({ status: "SUCCESS", data: [BINDING] });
      },
    };

    const base = ports(withRestore);
    const out = await upgradeDomain(request(withRestore), {
      ...base.ports,
      rollback: restorePort({
        adapter: withRestore,
        contextFor: base.ports.contextFor,
        config: CONFIG,
        fromVersion: "1.0.0",
      }),
    });

    expect(out.status).toBe("ROLLED_BACK");
    expect(restored).toEqual(["1.0.0"]);
    // Và KHÔNG ghi version mới: sổ phải khớp thực tế trên cụm
    expect(base.log.persisted).toEqual([]);
  });

  it("adapter KHÔNG có restoreTo ⇒ ROLLBACK_FAILED (kêu to, đúng như trước đợt này)", async () => {
    const { adapter } = stubAdapter({ upgradeResult: failing() });
    const base = ports(adapter);
    const out = await upgradeDomain(request(adapter), {
      ...base.ports,
      rollback: restorePort({
        adapter,
        contextFor: base.ports.contextFor,
        config: CONFIG,
        fromVersion: "1.0.0",
      }),
    });

    expect(out.status).toBe("ROLLBACK_FAILED");
    expect(base.log.persisted).toEqual([]);
    expect(base.log.errors.join(" ")).toContain("không mang định nghĩa bản cũ");
  });
});

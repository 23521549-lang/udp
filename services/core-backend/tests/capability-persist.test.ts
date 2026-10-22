import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient, type PrismaClient } from "@udp/db";
import { stableOwner } from "@udp/test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma as s1 } from "../src/core/db.js";
import {
  bindingRowOf,
  bindingsOfProject,
  deleteBindingsOfDomainConfig,
  rebindProvider,
  upsertBinding,
} from "../src/modules/capability/capability-binding.repository.js";
import {
  applyDomainChange,
  orphanPreferences,
} from "../src/modules/capability/domain-config.diff.js";

/**
 * [v4.10] Cổng P16 — AC-14: persist binding, trục environment, và dọn preference mồ côi.
 *
 * Ba tính chất mà chỉ database thật kiểm được:
 *
 *  1. `idx_binding_unique` là **expression index**, nên hai binding cluster-scoped
 *     (`environment_id IS NULL`) trùng nhau bị chặn — thứ mà một `UNIQUE` thường KHÔNG
 *     chặn, vì Postgres coi mỗi `NULL` là khác nhau.
 *  2. Rebind chạm **mọi** environment, không chỉ environment đang xem.
 *  3. Xoá preference nằm CÙNG transaction với việc đổi cấu hình.
 */

const admin: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_cap_persist_admin",
});

const PROJECT = "77777777-7777-4777-8777-777777777777";
const ENV_A = "77777777-aaaa-4777-8777-777777777771";
const ENV_B = "77777777-bbbb-4777-8777-777777777772";

let monitoringConfigId = "";

beforeAll(async () => {
  const owner = await stableOwner(admin);
  await admin.capabilityBinding.deleteMany({
    where: { domainConfig: { projectId: PROJECT } },
  });
  await admin.capabilityPreference.deleteMany({
    where: { projectId: PROJECT },
  });
  await admin.domainConfig.deleteMany({ where: { projectId: PROJECT } });
  await admin.environment.deleteMany({ where: { projectId: PROJECT } });
  await admin.project.deleteMany({ where: { id: PROJECT } });

  await admin.project.create({
    data: {
      id: PROJECT,
      ownerId: owner.id,
      name: "capability persist P16",
      creationMode: "CREATE_NEW",
      languageRuntime: "node20",
      resourceQuota: {},
    },
  });
  /** Hai environment — trục mà AC-14 nêu */
  await admin.environment.createMany({
    data: [
      {
        id: ENV_A,
        projectId: PROJECT,
        name: "dev",
        k8sNamespace: "p16-dev",
        rank: 1,
      },
      {
        id: ENV_B,
        projectId: PROJECT,
        name: "prod",
        k8sNamespace: "p16-prod",
        rank: 2,
        isProduction: true,
      },
    ],
  });
  const cfg = await admin.domainConfig.create({
    data: {
      projectId: PROJECT,
      domainType: "MONITORING",
      isEnabled: true,
      selectedTool: "prometheus-grafana",
    },
    select: { id: true },
  });
  monitoringConfigId = cfg.id;
});

afterAll(async () => {
  await admin.capabilityBinding.deleteMany({
    where: { domainConfig: { projectId: PROJECT } },
  });
  await admin.capabilityPreference.deleteMany({
    where: { projectId: PROJECT },
  });
  await admin.domainConfig.deleteMany({ where: { projectId: PROJECT } });
  await admin.environment.deleteMany({ where: { projectId: PROJECT } });
  await admin.project.deleteMany({ where: { id: PROJECT } });
  await admin.$disconnect();
});

beforeEach(async () => {
  await admin.capabilityBinding.deleteMany({
    where: { domainConfig: { projectId: PROJECT } },
  });
  await admin.capabilityPreference.deleteMany({
    where: { projectId: PROJECT },
  });
  await admin.domainConfig.update({
    where: { id: monitoringConfigId },
    data: { isEnabled: true, selectedTool: "prometheus-grafana" },
  });
});

describe("upsertBinding — idempotent theo expression index", () => {
  it("ghi hai lần cùng khoá ⇒ MỘT hàng, giá trị của lần sau", async () => {
    const row = {
      domainConfigId: monitoringConfigId,
      environmentId: null,
      capabilityId: "metrics.query",
      providedBy: "monitoring:prometheus-grafana",
      schemaVersion: "2.0.0",
      endpoint: "http://prometheus-server.udp-system:9090",
      attributes: null,
    };
    await upsertBinding(s1, row);
    await upsertBinding(s1, { ...row, endpoint: "http://doi-roi:9090" });

    const rows = await bindingsOfProject(s1, PROJECT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe("http://doi-roi:9090");
  });

  /**
   * Ca âm CỦA CHÍNH `idx_binding_unique`, và nó là lý do index đó phải là biểu thức.
   *
   * Hai binding cluster-scoped (`environment_id IS NULL`) cho cùng
   * `(domain_config, capability)` là TRÙNG NHAU về nghĩa. Nhưng Postgres coi mỗi `NULL`
   * là khác nhau, nên một `UNIQUE (domain_config_id, capability_id, environment_id)`
   * thường **cho cả hai vào**. Phép này chèn bằng `admin` — bỏ qua mọi logic của
   * repository — để khẳng định chính DATABASE chặn, không phải mã ứng dụng.
   */
  it("hai binding cluster-scoped trùng nhau bị DATABASE chặn", async () => {
    const base = {
      domainConfigId: monitoringConfigId,
      capabilityId: "metrics.query",
      providedBy: "monitoring:prometheus-grafana",
      schemaVersion: "2.0.0",
    };
    await admin.capabilityBinding.create({
      data: { id: randomUUID(), ...base, environmentId: null },
    });
    await expect(
      admin.capabilityBinding.create({
        data: { id: randomUUID(), ...base, environmentId: null },
      }),
    ).rejects.toThrow();
  });

  it("cùng capability nhưng KHÁC environment ⇒ hai hàng, hợp lệ", async () => {
    const base = {
      domainConfigId: monitoringConfigId,
      capabilityId: "metrics.query",
      providedBy: "monitoring:prometheus-grafana",
      schemaVersion: "2.0.0",
      endpoint: null,
      attributes: null,
    };
    await upsertBinding(s1, { ...base, environmentId: ENV_A });
    await upsertBinding(s1, { ...base, environmentId: ENV_B });
    await upsertBinding(s1, { ...base, environmentId: null });

    const rows = await bindingsOfProject(s1, PROJECT);
    expect(rows).toHaveLength(3);
  });

  it("bindingRowOf giữ nguyên hình của CapabilityBinding, cluster-scoped là null", () => {
    const row = bindingRowOf("cfg", {
      id: "metrics.query",
      version: "2.0.0",
      providedBy: "monitoring:prometheus-grafana",
    });
    expect(row.environmentId).toBeNull();
    expect(row.capabilityId).toBe("metrics.query");
    expect(row.schemaVersion).toBe("2.0.0");
  });
});

describe("rebind — MỌI environment, không chỉ environment đang xem (AC-14)", () => {
  /**
   * Đây là trục dễ làm sai nhất của cả P16: sửa đúng một hàng để lại những environment
   * khác trỏ tới provider ĐÃ TẮT, và chúng không báo lỗi gì — chúng chỉ đọc metrics từ
   * một endpoint không còn ai trả lời.
   */
  it("đổi provider ⇒ cả ba hàng (cluster, dev, prod) đổi theo", async () => {
    const base = {
      domainConfigId: monitoringConfigId,
      capabilityId: "metrics.query",
      providedBy: "monitoring:prometheus-grafana",
      schemaVersion: "2.0.0",
      endpoint: "http://prometheus:9090",
      attributes: null,
    };
    for (const environmentId of [null, ENV_A, ENV_B]) {
      await upsertBinding(s1, { ...base, environmentId });
    }

    const changed = await rebindProvider(s1, {
      projectId: PROJECT,
      domainConfigId: monitoringConfigId,
      capabilityId: "metrics.query",
      providedBy: "monitoring:victoriametrics",
      schemaVersion: "2.1.0",
      endpoint: "http://vmselect:8481",
    });
    expect(changed).toBe(3);

    const rows = await bindingsOfProject(s1, PROJECT);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.providedBy))).toEqual(
      new Set(["monitoring:victoriametrics"]),
    );
    expect(new Set(rows.map((r) => r.schemaVersion))).toEqual(
      new Set(["2.1.0"]),
    );
  });

  it("rebind KHÔNG chạm capability khác", async () => {
    const base = {
      domainConfigId: monitoringConfigId,
      environmentId: ENV_A,
      providedBy: "monitoring:prometheus-grafana",
      schemaVersion: "2.0.0",
      endpoint: null,
      attributes: null,
    };
    await upsertBinding(s1, { ...base, capabilityId: "metrics.query" });
    await upsertBinding(s1, { ...base, capabilityId: "metrics.scrape" });

    await rebindProvider(s1, {
      projectId: PROJECT,
      domainConfigId: monitoringConfigId,
      capabilityId: "metrics.query",
      providedBy: "monitoring:victoriametrics",
      schemaVersion: "2.1.0",
    });

    const rows = await bindingsOfProject(s1, PROJECT);
    const scrape = rows.find((r) => r.capabilityId === "metrics.scrape");
    expect(scrape?.providedBy).toBe("monitoring:prometheus-grafana");
  });

  it("[v4.11] rebind KHÔNG chạm binding của domain KHÁC cùng cung cấp capability đó", async () => {
    const logging = await admin.domainConfig.create({
      data: {
        projectId: PROJECT,
        domainType: "LOGGING",
        isEnabled: true,
        selectedTool: "victoria",
      },
      select: { id: true },
    });
    await upsertBinding(s1, {
      domainConfigId: logging.id,
      environmentId: null,
      capabilityId: "metrics.query",
      providedBy: "logging:victoria",
      schemaVersion: "2.1.0",
      endpoint: "http://vmselect:8481",
      attributes: null,
    });
    await upsertBinding(s1, {
      domainConfigId: monitoringConfigId,
      environmentId: null,
      capabilityId: "metrics.query",
      providedBy: "monitoring:prometheus-grafana",
      schemaVersion: "2.0.0",
      endpoint: "http://prometheus:9090",
      attributes: null,
    });

    const changed = await rebindProvider(s1, {
      projectId: PROJECT,
      domainConfigId: monitoringConfigId,
      capabilityId: "metrics.query",
      providedBy: "monitoring:grafana-cloud",
      schemaVersion: "2.0.0",
    });
    expect(changed).toBe(1);
    const rows = await bindingsOfProject(s1, PROJECT);
    expect(rows.find((r) => r.domainConfigId === logging.id)?.providedBy).toBe(
      "logging:victoria",
    );
    await admin.capabilityBinding.deleteMany({
      where: { domainConfigId: logging.id },
    });
    await admin.domainConfig.delete({ where: { id: logging.id } });
  });

  it("rebind KHÔNG chạm project khác", async () => {
    await upsertBinding(s1, {
      domainConfigId: monitoringConfigId,
      environmentId: null,
      capabilityId: "metrics.query",
      providedBy: "monitoring:prometheus-grafana",
      schemaVersion: "2.0.0",
      endpoint: null,
      attributes: null,
    });
    const changed = await rebindProvider(s1, {
      projectId: "88888888-8888-4888-8888-888888888888",
      domainConfigId: monitoringConfigId,
      capabilityId: "metrics.query",
      providedBy: "monitoring:victoriametrics",
      schemaVersion: "2.1.0",
    });
    expect(changed).toBe(0);
  });
});

describe("applyDomainChange — dọn trong CÙNG transaction", () => {
  it("tắt domain ⇒ xoá binding VÀ xoá preference mồ côi", async () => {
    await upsertBinding(s1, {
      domainConfigId: monitoringConfigId,
      environmentId: ENV_A,
      capabilityId: "metrics.query",
      providedBy: "monitoring:prometheus-grafana",
      schemaVersion: "2.0.0",
      endpoint: null,
      attributes: null,
    });
    await s1.capabilityPreference.create({
      data: {
        projectId: PROJECT,
        capabilityId: "metrics.query",
        providerToolId: "monitoring:prometheus-grafana",
      },
    });

    const out = await applyDomainChange(s1, PROJECT, {
      domainConfigId: monitoringConfigId,
      domainType: "MONITORING",
      selectedTool: null,
      capabilitiesOfOldTool: ["metrics.query"],
    });

    expect(out.bindingsRemoved).toBe(1);
    expect(out.preferencesRemoved).toBe(1);
    expect(await bindingsOfProject(s1, PROJECT)).toEqual([]);
    expect(
      await s1.capabilityPreference.findMany({ where: { projectId: PROJECT } }),
    ).toEqual([]);
  });

  it("đổi tool ⇒ rebind, và preference của capability CÒN provide thì GIỮ", async () => {
    await upsertBinding(s1, {
      domainConfigId: monitoringConfigId,
      environmentId: ENV_B,
      capabilityId: "metrics.query",
      providedBy: "monitoring:prometheus-grafana",
      schemaVersion: "2.0.0",
      endpoint: null,
      attributes: null,
    });
    await s1.capabilityPreference.create({
      data: {
        projectId: PROJECT,
        capabilityId: "metrics.query",
        providerToolId: "monitoring:victoriametrics",
      },
    });

    const out = await applyDomainChange(s1, PROJECT, {
      domainConfigId: monitoringConfigId,
      domainType: "MONITORING",
      selectedTool: "victoriametrics",
      capabilitiesOfOldTool: ["metrics.query"],
      rebind: [
        {
          capabilityId: "metrics.query",
          providedBy: "monitoring:victoriametrics",
          schemaVersion: "2.1.0",
        },
      ],
    });

    expect(out.bindingsRebound).toBe(1);
    /** Capability vẫn được provide ⇒ preference KHÔNG bị xoá */
    expect(out.preferencesRemoved).toBe(0);
    const prefs = await s1.capabilityPreference.findMany({
      where: { projectId: PROJECT },
    });
    expect(prefs).toHaveLength(1);
  });

  /**
   * Preference của một capability KHÔNG liên quan phải được giữ.
   *
   * Xoá mọi preference của project khi tắt một domain là bỏ im lặng một lựa chọn người
   * dùng vẫn muốn — cùng hạng lỗi với D-4' ở chỗ khác.
   */
  it("tắt domain KHÔNG xoá preference của capability không liên quan", async () => {
    await s1.capabilityPreference.createMany({
      data: [
        {
          projectId: PROJECT,
          capabilityId: "metrics.query",
          providerToolId: "monitoring:prometheus-grafana",
        },
        {
          projectId: PROJECT,
          capabilityId: "registry.oci",
          providerToolId: "registry:harbor",
        },
      ],
    });

    const out = await applyDomainChange(s1, PROJECT, {
      domainConfigId: monitoringConfigId,
      domainType: "MONITORING",
      selectedTool: null,
      capabilitiesOfOldTool: ["metrics.query"],
    });

    expect(out.preferencesRemoved).toBe(1);
    const left = await s1.capabilityPreference.findMany({
      where: { projectId: PROJECT },
    });
    expect(left.map((p) => p.capabilityId)).toEqual(["registry.oci"]);
  });

  /**
   * Nguyên tử: một lỗi ở bước cuối cuộn lại MỌI thứ.
   *
   * Nếu cấu hình mới commit mà lần xoá preference thì không, hệ thống ở đúng trạng thái
   * mà §5.3 gọi là lỗi khởi động — và lần khởi động kế tiếp là lần phát hiện. Phép này
   * dựng lỗi ở bước cuối bằng một `domainConfigId` không tồn tại.
   */
  it("bước cuối vỡ ⇒ preference KHÔNG bị xoá, cấu hình KHÔNG đổi", async () => {
    await s1.capabilityPreference.create({
      data: {
        projectId: PROJECT,
        capabilityId: "metrics.query",
        providerToolId: "monitoring:prometheus-grafana",
      },
    });

    await expect(
      applyDomainChange(s1, PROJECT, {
        domainConfigId: "99999999-9999-4999-8999-999999999999",
        domainType: "monitoring",
        selectedTool: null,
        capabilitiesOfOldTool: ["metrics.query"],
      }),
    ).rejects.toThrow();

    const prefs = await s1.capabilityPreference.findMany({
      where: { projectId: PROJECT },
    });
    expect(
      prefs,
      "preference phải còn vì transaction đã cuộn lại",
    ).toHaveLength(1);
  });
});

describe("orphanPreferences — phát hiện, còn NÉM là việc của resolver", () => {
  it("preference trỏ tới tool đang bật ⇒ KHÔNG mồ côi", async () => {
    await s1.capabilityPreference.create({
      data: {
        projectId: PROJECT,
        capabilityId: "metrics.query",
        providerToolId: "monitoring:prometheus-grafana",
      },
    });
    expect(await orphanPreferences(s1, PROJECT)).toEqual([]);
  });

  it("preference trỏ tới tool đã tắt ⇒ MỒ CÔI", async () => {
    await s1.capabilityPreference.create({
      data: {
        projectId: PROJECT,
        capabilityId: "metrics.query",
        providerToolId: "monitoring:victoriametrics",
      },
    });
    const orphans = await orphanPreferences(s1, PROJECT);
    expect(orphans).toEqual([
      {
        capabilityId: "metrics.query",
        providerToolId: "monitoring:victoriametrics",
      },
    ]);
  });

  it("domain bị tắt (isEnabled = false) ⇒ preference của nó thành mồ côi", async () => {
    await s1.capabilityPreference.create({
      data: {
        projectId: PROJECT,
        capabilityId: "metrics.query",
        providerToolId: "monitoring:prometheus-grafana",
      },
    });
    await admin.domainConfig.update({
      where: { id: monitoringConfigId },
      data: { isEnabled: false },
    });
    expect(await orphanPreferences(s1, PROJECT)).toHaveLength(1);
  });
});

describe("deleteBindingsOfDomainConfig", () => {
  it("xoá đúng binding của config đó, đếm đúng số hàng", async () => {
    const base = {
      domainConfigId: monitoringConfigId,
      capabilityId: "metrics.query",
      providedBy: "monitoring:prometheus-grafana",
      schemaVersion: "2.0.0",
      endpoint: null,
      attributes: null,
    };
    for (const environmentId of [null, ENV_A, ENV_B]) {
      await upsertBinding(s1, { ...base, environmentId });
    }
    const removed = await deleteBindingsOfDomainConfig(s1, monitoringConfigId);
    expect(removed).toBe(3);
    expect(await bindingsOfProject(s1, PROJECT)).toEqual([]);
  });
});

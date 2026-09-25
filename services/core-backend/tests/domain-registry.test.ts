import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DOMAIN_ADAPTER_METHODS,
  DOMAIN_ADAPTER_PROPERTIES,
} from "@udp/adapter-core";
import { env } from "@udp/config";
import { createPrismaClient, type PrismaClient } from "@udp/db";
import { afterAll, describe, expect, it } from "vitest";
import { prisma as s1 } from "../src/core/db.js";
import {
  assertIsDomainAdapter,
  createRegistry,
  InvalidAdapterError,
  loadAdapters,
  metricsSourceOf,
  pullCredentialOf,
  registryKey,
} from "../src/modules/domain/domain-adapter.registry.js";
import {
  assertRegistryCoveredByCatalog,
  RegistryCatalogMismatchError,
  syncDomainCatalog,
  type DeclaredDomain,
} from "../src/modules/domain/domain-catalog.sync.js";

/**
 * [v4.10] Cổng P17 — registry tự khám phá, type guard 7 + 6, và sync catalog.
 *
 * Registry ở đây trỏ vào một cây **fixture** dưới `tests/`, không vào `src/modules`. Hai
 * lý do, và lý do thứ hai quan trọng hơn:
 *
 *  1. Adapter thật đến ở P19/P20, nên một phép kiểm trỏ vào `src/modules` hôm nay sẽ
 *     xanh với danh sách rỗng — tức nó không kiểm gì.
 *  2. Cây fixture chứa được cả ca ÂM (adapter thiếu phương thức, thư mục không phải
 *     adapter), thứ mà cây sản phẩm không bao giờ nên có.
 */

const admin: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_registry_admin",
});

const FIXTURE_ROOT = resolve(import.meta.dirname, "fixtures/registry");

afterAll(async () => {
  await admin.$disconnect();
});

describe("registry tự khám phá hai tầng", () => {
  it("hậu tố sai thì bỏ qua IM LẶNG, hậu tố đúng mà adapter hỏng thì NÉM", async () => {
    /**
     * Một lượt chạy, hai hành vi khác nhau — và đó là điều cần khẳng định.
     *
     * Cây fixture có `not-an-adapter/` (hậu tố sai) và `monitoring-adapter/missing-method`
     * (hậu tố đúng, adapter thiếu `teardown`). Thông điệp lỗi phải nêu cái thứ hai và
     * KHÔNG nêu cái thứ nhất: `modules/` còn chứa `capability/`, `credential/`,
     * `provisioning/`, nên ném vì một thư mục không phải adapter sẽ làm registry không
     * bao giờ nạp được.
     */
    expect(readdirSync(FIXTURE_ROOT)).toContain("not-an-adapter");

    const problems: string[] = [];
    try {
      await loadAdapters({ root: FIXTURE_ROOT });
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
    /**
     * Cả cây fixture có một adapter HỎNG, nên `loadAdapters` phải NÉM — và nó ném vì
     * `missing-method`, không vì `not-an-adapter`. Đó là hai hành vi khác nhau trong cùng
     * một lượt chạy: hậu tố sai thì bỏ qua im lặng, hậu tố đúng mà adapter hỏng thì ném.
     */
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("missing-method");
    expect(problems[0]).toContain("teardown");
    expect(problems[0]).not.toContain("not-an-adapter");
  });

  it("gốc không tồn tại ⇒ NÉM, không trả danh sách rỗng", async () => {
    /**
     * Trả rỗng ở đây là hình dạng tệ nhất: hệ thống khởi động xanh với 0 adapter, và
     * Portal hiện "không có tool nào" cho mọi domain — một sự cố toàn hệ thống trông
     * giống một cấu hình trống.
     */
    await expect(
      loadAdapters({ root: join(FIXTURE_ROOT, "khong-ton-tai") }),
    ).rejects.toThrow(InvalidAdapterError);
  });

  it("registryKey là `<domainType>:<toolId>` viết thường", () => {
    expect(
      registryKey({
        domainType: "MONITORING",
        toolId: "Prometheus-Grafana",
      } as never),
    ).toBe("monitoring:prometheus-grafana");
  });
});

describe("§5.4 — adapter metrics.query PHẢI kèm nguồn metrics, kiểm lúc nạp (Plan #31)", () => {
  const providing = (version: string) =>
    ({
      capabilities: {
        provides: [{ id: "metrics.query", version }],
        requires: [],
      },
    }) as never;
  const source = (kind: string) => ({
    kind,
    of: () => ({ kind, baseUrl: "http://x", inCluster: true }),
  });

  it("khai đúng loại và version ⇒ nhận", () => {
    expect(
      metricsSourceOf(providing("2.1.0"), source("prometheus"), "x")?.kind,
    ).toBe("prometheus");
    expect(
      metricsSourceOf(providing("1.0.0"), source("datadog"), "x")?.kind,
    ).toBe("datadog");
  });

  it("thiếu, sai hình, hay lệch ngôn ngữ (PromQL@2 khai nguồn DQL@1) ⇒ NÉM", () => {
    expect(() => metricsSourceOf(providing("2.0.0"), undefined, "x")).toThrow(
      InvalidAdapterError,
    );
    expect(() =>
      metricsSourceOf(providing("2.0.0"), { kind: "prometheus" }, "x"),
    ).toThrow(/metricsSource hợp lệ/);
    expect(() =>
      metricsSourceOf(providing("2.0.0"), source("datadog"), "x"),
    ).toThrow(/metrics.query@1/);
    expect(() =>
      metricsSourceOf(providing("1.0.0"), source("khong-co"), "x"),
    ).toThrow(InvalidAdapterError);
  });

  it("chiều đảo: không provides metrics.query mà xuất metricsSource ⇒ NÉM; không xuất ⇒ vắng", () => {
    const plain = {
      capabilities: { provides: [{ id: "logs.sink", version: "1.0.0" }] },
    } as never;
    expect(() => metricsSourceOf(plain, source("prometheus"), "x")).toThrow(
      /không provides metrics.query/,
    );
    expect(metricsSourceOf(plain, undefined, "x")).toBeUndefined();
  });
});

describe("pullCredential chỉ ở adapter registry.oci, và phải là hàm (Plan #35)", () => {
  const providing = (id: string) =>
    ({
      capabilities: { provides: [{ id, version: "1.0.0" }], requires: [] },
    }) as never;
  const fn = () => null;

  it("adapter registry.oci xuất hàm ⇒ nhận; không xuất ⇒ vắng", () => {
    expect(pullCredentialOf(providing("registry.oci"), fn, "x")).toBe(fn);
    expect(
      pullCredentialOf(providing("registry.oci"), undefined, "x"),
    ).toBeUndefined();
  });

  it("không provides registry.oci, hay không phải hàm ⇒ NÉM lúc nạp", () => {
    expect(() => pullCredentialOf(providing("logs.sink"), fn, "x")).toThrow(
      /không provides registry.oci/,
    );
    expect(() =>
      pullCredentialOf(providing("registry.oci"), { server: "x" }, "x"),
    ).toThrow(/phải là một hàm/);
  });
});

describe("type guard 7 + 6 — hai danh sách là DỮ LIỆU, không viết lại", () => {
  it("đúng bảy phương thức và sáu thuộc tính", () => {
    expect(DOMAIN_ADAPTER_METHODS).toHaveLength(7);
    expect(DOMAIN_ADAPTER_PROPERTIES).toHaveLength(6);
  });

  /**
   * Guard phải đỏ khi THIẾU BẤT KỲ phương thức nào — kiểm từng cái, không chỉ một cái.
   *
   * Một guard kiểm `"deploy" in obj` rồi thôi vẫn cho qua một adapter thiếu `teardown`,
   * và điều đó chỉ lộ ra khi ai đó tắt domain — tức ở đúng lúc người ta cần nó chạy.
   */
  it("thiếu MỖI phương thức đều bị bắt, kèm tên phương thức", () => {
    const full = Object.fromEntries([
      ...DOMAIN_ADAPTER_METHODS.map((m) => [m, () => undefined]),
      ["domainType", "MONITORING"],
      ["toolId", "t"],
      ["version", "1.0.0"],
      ["scope", "cluster"],
      ["capabilities", { provides: [], requires: [] }],
      ["configSchema", {}],
    ]);

    for (const missing of DOMAIN_ADAPTER_METHODS) {
      const broken: Record<string, unknown> = { ...full };
      delete broken[missing];
      let message = "KHONG NEM";
      try {
        assertIsDomainAdapter(broken, "o-day");
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, `thiếu ${missing} phải bị bắt`).toContain(missing);
    }
  });

  it("thiếu MỖI thuộc tính đều bị bắt, kèm tên thuộc tính", () => {
    const full = Object.fromEntries([
      ...DOMAIN_ADAPTER_METHODS.map((m) => [m, () => undefined]),
      ["domainType", "MONITORING"],
      ["toolId", "t"],
      ["version", "1.0.0"],
      ["scope", "cluster"],
      ["capabilities", { provides: [], requires: [] }],
      ["configSchema", {}],
    ]);

    for (const missing of DOMAIN_ADAPTER_PROPERTIES) {
      const broken: Record<string, unknown> = { ...full };
      delete broken[missing];
      let message = "KHONG NEM";
      try {
        assertIsDomainAdapter(broken, "o-day");
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, `thiếu ${missing} phải bị bắt`).toContain(missing);
    }
  });

  /**
   * KIỂU của thuộc tính cũng được kiểm, không chỉ sự tồn tại.
   *
   * Một adapter khai `toolId: 42` đi qua mọi guard chỉ dùng `in`, rồi sinh khoá
   * `"monitoring:42"` không khớp gì trong catalog — và không có lỗi nào được phát ra.
   */
  it("toolId không phải chuỗi ⇒ bị bắt", () => {
    const broken = Object.fromEntries([
      ...DOMAIN_ADAPTER_METHODS.map((m) => [m, () => undefined]),
      ["domainType", "MONITORING"],
      ["toolId", 42],
      ["version", "1.0.0"],
      ["scope", "cluster"],
      ["capabilities", { provides: [], requires: [] }],
      ["configSchema", {}],
    ]);
    expect(() => assertIsDomainAdapter(broken, "o-day")).toThrow("toolId");
  });

  it("capabilities không phải object ⇒ bị bắt", () => {
    const broken = Object.fromEntries([
      ...DOMAIN_ADAPTER_METHODS.map((m) => [m, () => undefined]),
      ["domainType", "MONITORING"],
      ["toolId", "t"],
      ["version", "1.0.0"],
      ["scope", "cluster"],
      ["capabilities", "khong phai object"],
      ["configSchema", {}],
    ]);
    expect(() => assertIsDomainAdapter(broken, "o-day")).toThrow(
      "capabilities",
    );
  });

  it("không phải object ⇒ bị bắt, không vỡ ở một chỗ khác", () => {
    expect(() => assertIsDomainAdapter(null, "o-day")).toThrow("object");
    expect(() => assertIsDomainAdapter(42, "o-day")).toThrow("object");
  });
});

describe("syncDomainCatalog — UPSERT, và KHÔNG BAO GIỜ DELETE", () => {
  const SAMPLE = "P17_TAM";

  afterAll(async () => {
    await admin.domainCatalog.deleteMany({ where: { domainType: SAMPLE } });
  });

  /**
   * Bản khai RỖNG là một lỗi.
   *
   * Đường tới đây thường không phải ý muốn của ai: một lần đọc cấu hình thất bại trả về
   * mảng rỗng, và một hàm "làm theo bản khai" sẽ tắt cả 16 domain của mọi project.
   */
  it("bản khai rỗng ⇒ NÉM, không tắt gì cả", async () => {
    await expect(syncDomainCatalog(admin, [])).rejects.toThrow("rỗng");
  });

  /**
   * Ranh giới của ma trận writer §1.2, ở dạng kiểm được.
   *
   * Ba service chỉ có `SELECT ON domain_catalog`, nên `udp_s1` gọi sync nhận `42501`. Đó
   * là ranh giới ĐÚNG: catalog là dữ liệu nền tảng (16 domain của §5.5), không phải dữ
   * liệu tenant, nên nó thuộc đường migration/seed. Phép này tồn tại vì bản đầu của bộ
   * test gọi sync bằng `s1` và nhận `42501` — và phản ứng đúng không phải cấp thêm quyền.
   */
  it("gọi bằng role service (udp_s1) ⇒ database TỪ CHỐI", async () => {
    const declared = await currentDeclaration();
    const thrown = await syncDomainCatalog(s1, declared).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(thrown)).toContain("42501");
  });

  it("domain mới ⇒ thêm; chạy lại ⇒ không thêm hàng thứ hai", async () => {
    const declared = await currentDeclaration();
    const withSample: DeclaredDomain[] = [
      ...declared,
      {
        domainType: SAMPLE,
        tier: "STANDARD",
        displayName: "Domain tam cua P17",
        defaultOrder: 999,
      },
    ];
    await syncDomainCatalog(admin, withSample);
    await syncDomainCatalog(admin, withSample);

    const rows = await admin.domainCatalog.findMany({
      where: { domainType: SAMPLE },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isAvailable).toBe(true);
  });

  /**
   * Gỡ khỏi bản khai ⇒ `is_available = false`, HÀNG VẪN CÒN.
   *
   * `domain_catalog.domain_type` là khoá ngoại của `domain_configs`, nên xoá hàng là lỗi
   * khoá ngoại lúc chạy — hoặc, nếu ai đó "sửa" bằng cascade, là xoá im lặng cấu hình
   * domain của khách.
   */
  it("gỡ khỏi bản khai ⇒ đánh dấu không dùng được, KHÔNG xoá hàng", async () => {
    const declared = await currentDeclaration();
    const out = await syncDomainCatalog(
      admin,
      declared.filter((d) => d.domainType !== SAMPLE),
    );
    expect(out.markedUnavailable).toContain(SAMPLE);

    const row = await admin.domainCatalog.findUnique({
      where: { domainType: SAMPLE },
    });
    expect(row, "hàng phải CÒN").not.toBeNull();
    expect(row?.isAvailable).toBe(false);
  });

  it("khai lại ⇒ bật lại, và báo đúng trong reEnabled", async () => {
    const declared = await currentDeclaration();
    const out = await syncDomainCatalog(admin, [
      ...declared.filter((d) => d.domainType !== SAMPLE),
      {
        domainType: SAMPLE,
        tier: "STANDARD",
        displayName: "Domain tam cua P17",
        defaultOrder: 999,
      },
    ]);
    expect(out.reEnabled).toContain(SAMPLE);
    const row = await admin.domainCatalog.findUnique({
      where: { domainType: SAMPLE },
    });
    expect(row?.isAvailable).toBe(true);
  });

  /** Bản khai hiện tại của database, để mỗi phép chỉ đổi đúng thứ nó đang kiểm */
  async function currentDeclaration(): Promise<DeclaredDomain[]> {
    const rows = await admin.domainCatalog.findMany({
      where: { isAvailable: true, domainType: { not: SAMPLE } },
      select: {
        domainType: true,
        tier: true,
        displayName: true,
        defaultOrder: true,
      },
    });
    return rows;
  }
});

describe("registry vs catalog — HAI nguồn độc lập (G-34)", () => {
  it("adapter fixture có domainType thật ⇒ qua được", async () => {
    const registry = {
      get: () => undefined,
      all: () => [
        {
          key: "monitoring:good-tool",
          at: "fixture",
          adapter: { domainType: "MONITORING" } as never,
        },
      ],
    };
    await expect(
      assertRegistryCoveredByCatalog(s1, registry),
    ).resolves.toBeUndefined();
  });

  it("adapter khai domainType viết sai ⇒ NÉM, và nêu tên nó", async () => {
    const registry = {
      get: () => undefined,
      all: () => [
        {
          key: "moniterring:x",
          at: "fixture",
          adapter: { domainType: "MONITERRING" } as never,
        },
      ],
    };
    const thrown = await assertRegistryCoveredByCatalog(s1, registry).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(RegistryCatalogMismatchError);
    expect((thrown as Error).message).toContain("MONITERRING");
  });

  /**
   * `ignoreKeys` là tham số TƯỜNG MINH, không phải một cờ trên `DomainAdapter`.
   *
   * Interface `DomainAdapter` bị đóng băng ở 7 + 6 (cổng P18), nên thêm một `isFixture`
   * vào đó là nới interface vì lý do của test. Và cây adapter sản phẩm là
   * `src/modules/*-adapter/` còn fixture nằm dưới `tests/`, nên registry sản phẩm không
   * bao giờ thấy chúng — danh sách này chỉ cần cho test tự trỏ vào cây fixture.
   */
  it("ignoreKeys bỏ qua đúng adapter fixture", async () => {
    const registry = {
      get: () => undefined,
      all: () => [
        {
          key: "fixture:only",
          at: "fixture",
          adapter: { domainType: "KHONG_CO_THAT" } as never,
        },
      ],
    };
    await expect(
      assertRegistryCoveredByCatalog(s1, registry, {
        ignoreKeys: ["fixture:only"],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("createRegistry — tra theo (domainType, toolId)", () => {
  it("tra được adapter đã nạp, không phân biệt hoa thường", async () => {
    /** Cây con CHỈ có adapter hợp lệ — dựng tại chỗ để không phụ thuộc ca âm */
    const root = resolve(import.meta.dirname, "fixtures/registry-ok");
    const registry = await createRegistry({ root });
    expect(registry.all()).toHaveLength(1);
    expect(registry.get("MONITORING", "good-tool")).toBeDefined();
    expect(registry.get("monitoring", "GOOD-TOOL")).toBeDefined();
    expect(registry.get("monitoring", "khong-co")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import type { CostEstimate, ResourceQuota } from "../src/cloud.js";
import {
  classifyOrphans,
  EXPIRY_WARN_HOURS,
  expiryDecision,
  MANDATORY_COST_ITEMS,
  ORPHAN_HOURLY_USD,
  ORPHAN_PRICING_AS_OF,
  PRICING_MAX_AGE_DAYS,
  quotaViolations,
  validateCostEstimate,
} from "../src/guardrails.js";
import type { ProvisionedResourceRow } from "../src/ledger.js";

/**
 * [v4.10] Bốn lớp bảo vệ chi phí của §4.4.
 *
 * Trong mô hình BYOC, một lỗi ở đây tiêu tiền thật trong tài khoản của developer. Nên bộ
 * này không kiểm "hàm có chạy" mà kiểm những chỗ mà một hiện thực hợp lý vẫn **che chi
 * phí**: một tổng không bằng tổng các mục, một tài nguyên không định giá được bị tính là
 * 0, một lần TEARDOWN tự động trên project có production.
 */

const QUOTA: ResourceQuota = {
  maxNodes: 3,
  maxNodeSize: "medium",
  maxDatabases: 2,
  maxStorageGb: 50,
  maxLoadBalancers: 3,
};

describe("lớp 1 — quota, đủ năm chiều", () => {
  it("kế hoạch trong trần ⇒ không vi phạm nào", () => {
    expect(
      quotaViolations(
        {
          nodes: 3,
          nodeSize: "medium",
          databases: 2,
          storageGb: 50,
          loadBalancers: 3,
        },
        QUOTA,
      ),
    ).toEqual([]);
  });

  it("bắt được cả NĂM chiều, không chỉ node", () => {
    const v = quotaViolations(
      {
        nodes: 4,
        nodeSize: "large",
        databases: 3,
        storageGb: 51,
        loadBalancers: 4,
      },
      QUOTA,
    );
    expect(v.map((x) => x.dimension).sort()).toEqual([
      "maxDatabases",
      "maxLoadBalancers",
      "maxNodeSize",
      "maxNodes",
      "maxStorageGb",
    ]);
  });

  /**
   * `maxNodeSize` là một thứ tự, không phải một số. Một hiện thực so chuỗi sẽ cho
   * `"large" <= "medium"` là đúng (vì `l` < `m`) và để lọt đúng chiều tốn tiền nhất.
   */
  it("maxNodeSize so theo THỨ TỰ cỡ, không theo bảng chữ cái", () => {
    expect(quotaViolations({ nodeSize: "small" }, QUOTA)).toEqual([]);
    expect(quotaViolations({ nodeSize: "medium" }, QUOTA)).toEqual([]);
    expect(quotaViolations({ nodeSize: "large" }, QUOTA)).toHaveLength(1);
  });

  /**
   * "Không xin" khác "xin 0". Một kế hoạch chỉ dựng network không khai `nodes`, và chiều
   * đó không được kiểm — chứ không phải được coi là 0 rồi luôn qua.
   */
  it("chiều không khai thì KHÔNG kiểm, không mặc định thành 0", () => {
    expect(quotaViolations({}, QUOTA)).toEqual([]);
    expect(quotaViolations({ nodes: 0 }, QUOTA)).toEqual([]);
    const zeroCap: ResourceQuota = { ...QUOTA, maxNodes: 0 };
    expect(quotaViolations({}, zeroCap)).toEqual([]);
    expect(quotaViolations({ nodes: 1 }, zeroCap)).toHaveLength(1);
  });

  it("vi phạm mang theo số kế hoạch và trần, để thông báo nói được điều gì cụ thể", () => {
    const [v] = quotaViolations({ nodes: 10 }, QUOTA);
    expect(v?.planned).toBe(10);
    expect(v?.limit).toBe(3);
  });
});

describe("lớp 2 — estimateCost phải trung thực", () => {
  const good = (over: Partial<CostEstimate> = {}): CostEstimate => ({
    monthlyUsd: 180,
    breakdown: [
      { item: "control-plane", monthlyUsd: 73 },
      { item: "nat-gateway", monthlyUsd: 32 },
      { item: "load-balancer", monthlyUsd: 18 },
      { item: "nodes", monthlyUsd: 57 },
    ],
    isEstimate: true,
    pricingAsOf: new Date().toISOString().slice(0, 10),
    ...over,
  });

  it("bản đầy đủ ⇒ không vấn đề nào", () => {
    expect(validateCostEstimate(good())).toEqual([]);
  });

  it("ba mục bắt buộc là control-plane, nat-gateway, load-balancer", () => {
    expect([...MANDATORY_COST_ITEMS].sort()).toEqual([
      "control-plane",
      "load-balancer",
      "nat-gateway",
    ]);
  });

  it("thiếu mỗi mục bắt buộc là một vấn đề riêng", () => {
    for (const missing of MANDATORY_COST_ITEMS) {
      const est = good();
      const kept = est.breakdown.filter((b) => b.item !== missing);
      const problems = validateCostEstimate({
        ...est,
        breakdown: kept,
        monthlyUsd: kept.reduce((a, b) => a + b.monthlyUsd, 0),
      });
      expect(
        problems.filter((p) => p.code === "MISSING_ITEM"),
        missing,
      ).toHaveLength(1);
    }
  });

  /**
   * Phép kiểm quan trọng nhất của lớp 2.
   *
   * Một bản ước tính mà tổng KHÔNG bằng tổng các mục là một bản mà con số tổng đã được
   * sửa bằng tay — và khi đó ba mục bắt buộc chỉ còn là trang trí, vì người dùng đọc con
   * số tổng.
   */
  it("tổng phải bằng tổng các mục", () => {
    const problems = validateCostEstimate(good({ monthlyUsd: 99 }));
    expect(problems.map((p) => p.code)).toContain("TOTAL_MISMATCH");
  });

  it("sai số một cent được tha, hai cent thì không", () => {
    expect(validateCostEstimate(good({ monthlyUsd: 180.01 }))).toEqual([]);
    expect(
      validateCostEstimate(good({ monthlyUsd: 180.02 })).map((p) => p.code),
    ).toContain("TOTAL_MISMATCH");
  });

  it("mục mang số âm bị bắt", () => {
    const est = good();
    const problems = validateCostEstimate({
      ...est,
      breakdown: [...est.breakdown, { item: "giam-gia", monthlyUsd: -50 }],
      monthlyUsd: 130,
    });
    expect(problems.map((p) => p.code)).toContain("NEGATIVE_AMOUNT");
  });

  it("pricingAsOf không phân tích được thì bị bắt", () => {
    expect(
      validateCostEstimate(good({ pricingAsOf: "hom-qua" })).map((p) => p.code),
    ).toContain("PRICING_AS_OF_INVALID");
  });

  /** Một bảng giá quá cũ là một bản ước tính sai mà không ai biết nó sai */
  it("bảng giá quá cũ thì bị bắt", () => {
    const old = new Date();
    old.setDate(old.getDate() - PRICING_MAX_AGE_DAYS - 10);
    expect(
      validateCostEstimate(
        good({ pricingAsOf: old.toISOString().slice(0, 10) }),
      ).map((p) => p.code),
    ).toContain("PRICING_TOO_OLD");
  });
});

describe("lớp 3 — TTL, và vì sao nó KHÔNG tự xoá", () => {
  const at = (iso: string): Date => new Date(iso);
  const base = {
    expiryAction: "WARN" as const,
    hasDeployedProductionEnv: false,
  };

  it("không có expiresAt ⇒ không quyết định gì", () => {
    expect(
      expiryDecision({ ...base, expiresAt: null }, at("2026-09-24T00:00:00Z")),
    ).toEqual({ kind: "none" });
  });

  it("ba mốc cảnh báo là 72h, 24h, 1h", () => {
    expect([...EXPIRY_WARN_HOURS].sort((a, b) => a - b)).toEqual([1, 24, 72]);
  });

  it("còn xa hơn mốc lớn nhất ⇒ chưa cảnh báo", () => {
    const d = expiryDecision(
      { ...base, expiresAt: at("2026-10-01T00:00:00Z") },
      at("2026-09-24T00:00:00Z"),
    );
    expect(d.kind).toBe("none");
  });

  /** Gần hết hạn thì cảnh báo GẤP hơn: chọn mốc nhỏ nhất còn chứa thời gian còn lại */
  it("chọn mốc NHỎ NHẤT còn chứa thời gian còn lại", () => {
    const now = at("2026-09-24T00:00:00Z");
    const cases: [string, number][] = [
      ["2026-09-26T23:00:00Z", 72],
      ["2026-09-24T20:00:00Z", 24],
      ["2026-09-24T00:30:00Z", 1],
    ];
    for (const [expires, expected] of cases) {
      const d = expiryDecision({ ...base, expiresAt: at(expires) }, now);
      expect(d.kind, expires).toBe("warn");
      if (d.kind === "warn") expect(d.threshold, expires).toBe(expected);
    }
  });

  /**
   * `WARN` là mặc định của BYOC, và nó **không đụng tài nguyên**.
   *
   * Bản v3 để cron tự xoá mọi project quá hạn. §4.4 gọi đó là rủi ro pháp lý chứ không
   * phải một bug: xoá nhầm cluster production trong tài khoản người khác không sửa được
   * bằng một bản vá.
   */
  it("quá hạn với WARN ⇒ chỉ đánh dấu, KHÔNG teardown", () => {
    const d = expiryDecision(
      { ...base, expiresAt: at("2026-09-20T00:00:00Z") },
      at("2026-09-24T00:00:00Z"),
    );
    expect(d).toEqual({ kind: "expired-warn-only" });
  });

  it("quá hạn với TEARDOWN và không có production ⇒ được dọn", () => {
    const d = expiryDecision(
      {
        expiresAt: at("2026-09-20T00:00:00Z"),
        expiryAction: "TEARDOWN",
        hasDeployedProductionEnv: false,
      },
      at("2026-09-24T00:00:00Z"),
    );
    expect(d).toEqual({ kind: "teardown" });
  });

  /** Chốt an toàn cuối: có production đã deploy thì TEARDOWN tự động bị chặn */
  it("quá hạn với TEARDOWN nhưng CÓ production đã deploy ⇒ bị chặn, có lý do", () => {
    const d = expiryDecision(
      {
        expiresAt: at("2026-09-20T00:00:00Z"),
        expiryAction: "TEARDOWN",
        hasDeployedProductionEnv: true,
      },
      at("2026-09-24T00:00:00Z"),
    );
    expect(d.kind).toBe("teardown-blocked");
    if (d.kind === "teardown-blocked") {
      expect(d.reason).toContain("is_production");
    }
  });

  /**
   * Hàm này trả về QUYẾT ĐỊNH, không thực hiện nó.
   *
   * Đó là cách "ghi `AuditLog(SYSTEM)` TRƯỚC khi xoá" trở thành một thứ kiểm được: bên
   * gọi nhận `{kind: "teardown"}` rồi mới ghi vết rồi mới xoá, và thứ tự đó là hợp đồng.
   * Một hàm vừa quyết định vừa xoá thì không có chỗ nào chen phép ghi vết vào.
   */
  it("không có nhánh nào trả về thứ gì ngoài một QUYẾT ĐỊNH", () => {
    const kinds = new Set<string>();
    for (const action of ["WARN", "TEARDOWN"] as const) {
      for (const prod of [true, false]) {
        for (const expires of [null, at("2026-09-20T00:00:00Z")]) {
          kinds.add(
            expiryDecision(
              {
                expiresAt: expires,
                expiryAction: action,
                hasDeployedProductionEnv: prod,
              },
              at("2026-09-24T00:00:00Z"),
            ).kind,
          );
        }
      }
    }
    expect([...kinds].sort()).toEqual([
      "expired-warn-only",
      "none",
      "teardown",
      "teardown-blocked",
    ]);
  });
});

describe("lớp 4 — orphan kèm chi phí đang chạy", () => {
  const row = (
    over: Partial<ProvisionedResourceRow> = {},
  ): ProvisionedResourceRow => ({
    projectId: "p",
    step: "NETWORK",
    kind: "nat-gateway",
    idempotencyKey: `p:NETWORK:nat-gateway:${String(Math.random())}`,
    providerId: "nat-1",
    provider: "aws",
    region: "ap-southeast-1",
    status: "ORPHAN_SUSPECTED",
    ...over,
  });

  it("chỉ hàng ORPHAN_SUSPECTED được tính", () => {
    const report = classifyOrphans({
      ledgerRows: [
        row(),
        row({ status: "READY" }),
        row({ status: "DELETED" }),
        row({ status: "CREATING" }),
      ],
      cloudIdsWithProjectTag: [],
    });
    expect(report.suspected).toHaveLength(1);
  });

  it("cộng USD/giờ của những kind định giá được", () => {
    const report = classifyOrphans({
      ledgerRows: [
        row({ kind: "nat-gateway" }),
        row({ kind: "cluster" }),
        row({ kind: "elastic-ip" }),
      ],
      cloudIdsWithProjectTag: [],
    });
    const expected =
      (ORPHAN_HOURLY_USD["nat-gateway"] ?? 0) +
      (ORPHAN_HOURLY_USD["cluster"] ?? 0) +
      (ORPHAN_HOURLY_USD["elastic-ip"] ?? 0);
    expect(report.estimatedUsdPerHour).toBeCloseTo(expected, 4);
  });

  /**
   * Phép kiểm quan trọng nhất của lớp 4.
   *
   * Trả `0` cho một tài nguyên ta không biết giá là **che chi phí** — đúng thứ mà lớp này
   * tồn tại để chống. Nó phải được NÊU RA, và tổng không được lặng lẽ cộng thêm 0.
   */
  it("kind không định giá được thì NÊU RA, không tính là 0", () => {
    const report = classifyOrphans({
      ledgerRows: [row({ kind: "route-table" }), row({ kind: "nat-gateway" })],
      cloudIdsWithProjectTag: [],
    });
    expect(report.unpriced).toEqual(["route-table"]);
    expect(report.estimatedUsdPerHour).toBeCloseTo(
      ORPHAN_HOURLY_USD["nat-gateway"] ?? 0,
      4,
    );
  });

  it("kind trùng chỉ nêu một lần trong unpriced", () => {
    const report = classifyOrphans({
      ledgerRows: [row({ kind: "route-table" }), row({ kind: "route-table" })],
      cloudIdsWithProjectTag: [],
    });
    expect(report.unpriced).toEqual(["route-table"]);
  });

  /**
   * Tài nguyên trên cloud mang tag của project mà sổ không biết.
   *
   * Đây là chiều mà chỉ quét cloud mới thấy: một job chết sau `create` nhưng trước khi ghi
   * `provider_id` để lại đúng thứ này, và sổ không có cách nào tự phát hiện.
   */
  it("tài nguyên trên cloud mà sổ không biết ⇒ vào unmatchedOnCloud", () => {
    const report = classifyOrphans({
      ledgerRows: [row({ providerId: "nat-1", status: "READY" })],
      cloudIdsWithProjectTag: ["nat-1", "vpc-lac-loai", "eip-lac-loai"],
    });
    expect(report.unmatchedOnCloud).toEqual(["vpc-lac-loai", "eip-lac-loai"]);
  });

  it("hàng chưa có providerId không làm mọi thứ trên cloud thành unmatched", () => {
    const report = classifyOrphans({
      ledgerRows: [row({ providerId: null, status: "CREATING" })],
      cloudIdsWithProjectTag: ["nat-1"],
    });
    expect(report.unmatchedOnCloud).toEqual(["nat-1"]);
  });

  it("báo cáo mang ngày của bảng giá", () => {
    const report = classifyOrphans({
      ledgerRows: [],
      cloudIdsWithProjectTag: [],
    });
    expect(report.pricingAsOf).toBe(ORPHAN_PRICING_AS_OF);
    expect(Number.isNaN(new Date(ORPHAN_PRICING_AS_OF).getTime())).toBe(false);
  });

  it("bảng giá chỉ chứa kind tính tiền theo GIỜ kể cả khi không ai dùng", () => {
    for (const kind of Object.keys(ORPHAN_HOURLY_USD)) {
      expect(
        [
          "nat-gateway",
          "elastic-ip",
          "cluster",
          "k8s-loadbalancer",
          "k8s-volume",
          "nodegroup",
        ],
        kind,
      ).toContain(kind);
    }
  });
});

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adapterVersionOf,
  chartPinsOf,
  checkChartBump,
  excusedCharts,
  frozenChartVersionsOf,
} from "../src/chart-bump.js";
import { chartBumpGate } from "../src/chart-bump-gate.js";

/**
 * [Plan #61 61d-3c-2] Cổng F3 — đổi ghim chart phải đi kèm bump version adapter VÀ `upgradesFrom` mang bản cũ.
 *
 * Vì sao cổng này cần thiết, bằng mã chứ không bằng chữ: `upgradesFrom` là trường **tuỳ chọn** của
 * `HelmAdapterSpec`, và `requestReapply` chỉ chặn khi `row.adapterVersion !== adapter.version` — nên sửa ghim chart
 * tại chỗ mà giữ version adapter thì `reapply` áp bình thường, **không** validator capability, **không** đường hạ
 * về. Lối sai dễ hơn lối đúng, và 61d-3c-1 vừa dựng một vòi báo 29 bản vá chart mỗi tuần.
 */

const PINS = (version: string): string => `
export const HELM_CHART_PINS = {
  "kyverno": {
    name: "kyverno",
    version: "${version}",
    repo: "https://kyverno.github.io/kyverno/",
  },
  "raw": {
    name: "raw",
    version: "v0.3.2",
    repo: "https://dysnix.github.io/charts",
  },
};
`;

/** Tệp adapter tối thiểu nhưng ĐÚNG hình dạng mà `createHelmBasedAdapter` nhận */
const ADAPTER = (opts: { version: string; upgradesFrom?: string }): string => `
const adapter = createHelmBasedAdapter({
  domainType: "POLICY",
  toolId: "kyverno",
  version: "${opts.version}",
${
  opts.upgradesFrom === undefined
    ? ""
    : `  upgradesFrom: [
    {
      version: "1.0.0",
      chart: { name: "kyverno", version: "${opts.upgradesFrom}", repo: REPO },
      values: engineValues,
    },
  ],
`
}  chart: helmChart("kyverno"),
});
`;

const file = (content: string) => ({
  path: "services/core-backend/src/modules/policy-adapter/kyverno/index.ts",
  before: ADAPTER({ version: "2.0.0" }),
  after: content,
});

describe("phần đọc của cổng F3", () => {
  it("chartPinsOf đọc đúng tên ⇒ version", () => {
    expect([...chartPinsOf(PINS("3.9.1"))]).toEqual([
      ["kyverno", "3.9.1"],
      ["raw", "v0.3.2"],
    ]);
  });

  it("adapterVersionOf lấy version của ADAPTER, không lấy version của chart", () => {
    expect(adapterVersionOf(ADAPTER({ version: "2.0.0" }))).toBe("2.0.0");
    expect(
      adapterVersionOf(ADAPTER({ version: "2.1.0", upgradesFrom: "3.2.7" })),
    ).toBe("2.1.0");
    expect(adapterVersionOf("không có gì")).toBeNull();
  });

  it("frozenChartVersionsOf chỉ lấy version trong vùng upgradesFrom", () => {
    const src = ADAPTER({ version: "2.1.0", upgradesFrom: "3.2.7" });
    expect(frozenChartVersionsOf(src, "kyverno")).toEqual(["3.2.7"]);
    expect(frozenChartVersionsOf(src, "raw")).toEqual([]);
    // Không có upgradesFrom ⇒ rỗng, không ném
    expect(
      frozenChartVersionsOf(ADAPTER({ version: "2.0.0" }), "kyverno"),
    ).toEqual([]);
  });

  it("excusedCharts đọc dòng `Ghim-hỏng:` của thông điệp commit", () => {
    expect(
      excusedCharts("sửa ghim\n\nGhim-hỏng: zipkin\nGhim-hỏng: raw\n"),
    ).toEqual(["zipkin", "raw"]);
    expect(excusedCharts("không có gì")).toEqual([]);
    // Phải là một dòng riêng — nhắc trong văn xuôi không thành lời miễn trừ
    expect(excusedCharts("nói về Ghim-hỏng: zipkin ở giữa câu nào đó")).toEqual(
      [],
    );
  });
});

describe("phán quyết F3", () => {
  const verdict = (args: {
    to: string;
    adapterAfter: string;
    message?: string;
  }) =>
    checkChartBump({
      pinsBefore: PINS("3.9.1"),
      pinsAfter: PINS(args.to),
      adapters: [file(args.adapterAfter)],
      commitMessage: args.message ?? "đổi ghim chart",
    });

  it("bump đủ cả hai thứ ⇒ ĐẠT", () => {
    const v = verdict({
      to: "3.9.2",
      adapterAfter: ADAPTER({ version: "2.1.0", upgradesFrom: "3.9.1" }),
    });
    expect(v.changed).toEqual([
      { chart: "kyverno", from: "3.9.1", to: "3.9.2" },
    ]);
    expect(v.violations).toEqual([]);
  });

  it("đổi ghim mà KHÔNG bump adapter ⇒ VI PHẠM, và lý do nói đúng hậu quả", () => {
    const v = verdict({
      to: "3.9.2",
      adapterAfter: ADAPTER({ version: "2.0.0", upgradesFrom: "3.9.1" }),
    });
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]?.reason).toContain("reapply KHÔNG chạy validator");
  });

  it("bump adapter mà upgradesFrom KHÔNG mang version chart cũ ⇒ VI PHẠM", () => {
    /**
     * Đây là nửa dễ quên nhất, và nó là nửa duy nhất làm `restoreTo` chạy ĐÚNG: `upgradesFrom` mang `3.2.7` trong
     * khi bản đang hạ về là `3.9.1` thì cụm "đã hạ về" sẽ chạy chart cũ với `values` của bản mới.
     */
    const v = verdict({
      to: "3.9.2",
      adapterAfter: ADAPTER({ version: "2.1.0", upgradesFrom: "3.2.7" }),
    });
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]?.reason).toContain("values của bản MỚI");
  });

  it("commit không mang tệp adapter nào ⇒ VI PHẠM", () => {
    const v = checkChartBump({
      pinsBefore: PINS("3.9.1"),
      pinsAfter: PINS("3.9.2"),
      adapters: [],
      commitMessage: "chỉ sửa bảng ghim",
    });
    expect(v.violations[0]?.reason).toContain("không tệp adapter nào");
  });

  it("`Ghim-hỏng: <chart>` miễn trừ — sửa một ghim chưa bao giờ tải được", () => {
    const v = verdict({
      to: "3.9.2",
      adapterAfter: ADAPTER({ version: "2.0.0" }),
      message: "sửa ghim không tồn tại\n\nGhim-hỏng: kyverno\n",
    });
    expect(v.excused).toEqual(["kyverno"]);
    expect(v.violations).toEqual([]);
  });

  it("thêm chart MỚI hay bỏ một chart ⇒ không phải một lượt đổi ghim", () => {
    const withoutRaw = PINS("3.9.1").replace(/\s*"raw": \{[^}]*\},/, "");
    expect(
      checkChartBump({
        pinsBefore: withoutRaw,
        pinsAfter: PINS("3.9.1"),
        adapters: [],
        commitMessage: "thêm chart raw",
      }).changed,
    ).toEqual([]);
    expect(
      checkChartBump({
        pinsBefore: PINS("3.9.1"),
        pinsAfter: withoutRaw,
        adapters: [],
        commitMessage: "bỏ chart raw",
      }).changed,
    ).toEqual([]);
  });
});

describe("cổng F3 trên lịch sử git THẬT của repo", () => {
  const REPO = resolve(import.meta.dirname, "../../..");

  it("mọi commit từ lúc bảng ghim ra đời tới HEAD đều ĐẠT", () => {
    /**
     * Phép kiểm này đi qua lịch sử thật, nên nó cũng là phép kiểm "cổng không tố oan": commit dựng bảng
     * (61d-3c-1) đổi năm ghim mà **không** bump adapter nào — nhưng cả năm là ghim chưa bao giờ tải về được, nên
     * commit đó phải được miễn. Nếu cổng tố nó, lời miễn trừ chưa đúng chỗ.
     */
    const report = chartBumpGate({ cwd: REPO, base: "HEAD~8", head: "HEAD" });
    const offenders = report.violations.map((v) => ({
      commit: v.commit.slice(0, 7),
      subject: v.subject,
      reasons: v.verdict.violations.map((x) => `${x.chart}: ${x.reason}`),
    }));
    expect(offenders).toEqual([]);
  });
});

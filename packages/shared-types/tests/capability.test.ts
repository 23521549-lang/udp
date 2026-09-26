import { describe, expect, it } from "vitest";
import {
  CAPABILITY_IDS,
  isAnyOf,
  type CapabilityDeclaration,
  type CapabilityId,
  type CapabilityRequires,
} from "../src/capability.js";

/**
 * [v4.10] Phần THUẦN của capability model (§5.3).
 *
 * Hai thứ được chốt ở đây vì chúng là chỗ sai âm thầm: `CAPABILITY_IDS` lệch khỏi
 * union `CapabilityId` (type guard của registry duyệt theo mảng, nên một giá trị
 * thiếu trong mảng là một capability không ai khai được mà chẳng có lỗi nào báo),
 * và `isAnyOf` phân biệt sai hai hình dạng của `requires` (nhánh sai làm validator
 * trả về mã lỗi sai, mà `MISSING_ANY_OF` với `MISSING_CAPABILITY` dẫn tới hai thông
 * báo khác nhau trên UI).
 */

describe("CAPABILITY_IDS", () => {
  it("đúng 17 giá trị, không trùng", () => {
    expect(CAPABILITY_IDS).toHaveLength(17);
    expect(new Set(CAPABILITY_IDS).size).toBe(17);
  });

  /**
   * Chốt mảng KHỚP union, cả hai chiều.
   *
   * Chiều mảng ⊆ union do kiểu `readonly CapabilityId[]` lo lúc biên dịch. Chiều
   * union ⊆ mảng thì trình biên dịch KHÔNG thấy được, nên phải liệt kê tay ở đây:
   * `Record<CapabilityId, true>` đỏ lúc biên dịch nếu thêm một giá trị vào union
   * mà quên thêm vào đây, và `expect` dưới đây đỏ nếu quên thêm vào `CAPABILITY_IDS`.
   */
  it("phủ MỌI giá trị của union CapabilityId", () => {
    const every: Record<CapabilityId, true> = {
      "registry.oci": true,
      "metrics.query": true,
      "metrics.scrape": true,
      "logs.sink": true,
      "traces.sink": true,
      "mesh.traffic-split": true,
      "ingress.traffic-split": true,
      "traffic.control": true,
      "secrets.store": true,
      "gitops.sync": true,
      "policy.admission": true,
      "pipeline.trigger": true,
      "db.instance": true,
      "cost.query": true,
      "packages.store": true,
      "infra.provision": true,
      "security.scan": true,
    };
    expect([...CAPABILITY_IDS].sort()).toEqual(Object.keys(every).sort());
  });

  it("hai capability EXCLUSIVE của §5.3 có trong danh sách", () => {
    expect(CAPABILITY_IDS).toContain("traffic.control");
    expect(CAPABILITY_IDS).toContain("gitops.sync");
  });

  it("tách riêng mesh và ingress traffic-split (v4 tách khỏi nhau)", () => {
    expect(CAPABILITY_IDS).toContain("mesh.traffic-split");
    expect(CAPABILITY_IDS).toContain("ingress.traffic-split");
  });
});

describe("isAnyOf", () => {
  it("phân biệt nhóm anyOf với ràng buộc đơn lẻ", () => {
    const single: CapabilityRequires = {
      id: "metrics.query",
      constraint: "^2",
    };
    const group: CapabilityRequires = {
      anyOf: [{ id: "mesh.traffic-split" }, { id: "ingress.traffic-split" }],
    };
    expect(isAnyOf(single)).toBe(false);
    expect(isAnyOf(group)).toBe(true);
  });

  /**
   * Một ràng buộc đơn lẻ mang `id` là một capability mà TÊN nó không chứa "anyOf"
   * vẫn phải ra `false`. Phép kiểm này bắt hiện thực dò bằng chuỗi thay vì dò khoá.
   */
  it("không bị lừa bởi giá trị của id", () => {
    expect(isAnyOf({ id: "cost.query" })).toBe(false);
  });
});

describe("CapabilityDeclaration — hình dạng của ví dụ trong §5.3", () => {
  /**
   * Chốt rằng khai báo của Flagger trong tài liệu VIẾT ĐƯỢC bằng các kiểu này.
   * Nếu một kiểu bị thu hẹp sai, test này đỏ lúc biên dịch chứ không phải lúc
   * người ta ngồi viết adapter thật.
   */
  it("khai báo của Flagger dịch được", () => {
    const flagger: CapabilityDeclaration = {
      provides: [{ id: "traffic.control", version: "1.0.0", exclusive: true }],
      requires: [
        {
          anyOf: [
            { id: "mesh.traffic-split" },
            { id: "ingress.traffic-split" },
          ],
        },
        { id: "metrics.query", constraint: "^2" },
      ],
      recommends: ["traces.sink"],
      hint: {
        "mesh.traffic-split":
          "Flagger cần Istio/Linkerd (mesh) hoặc NGINX/Traefik (ingress).",
      },
    };
    expect(flagger.provides[0]?.exclusive).toBe(true);
    expect(flagger.requires.filter(isAnyOf)).toHaveLength(1);
  });

  it("khai báo của Prometheus dịch được, và requires rỗng là hợp lệ", () => {
    const prometheus: CapabilityDeclaration = {
      provides: [
        { id: "metrics.query", version: "2.0.0" },
        { id: "metrics.scrape", version: "1.0.0" },
      ],
      requires: [],
    };
    expect(prometheus.requires).toHaveLength(0);
    expect(prometheus.provides.some((p) => p.exclusive === true)).toBe(false);
  });
});

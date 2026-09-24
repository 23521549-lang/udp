import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLOUD_ADAPTER_METHODS,
  CONDITIONAL_TTL_TAG_KEY,
  expectedTagKeys,
  REQUIRED_TAG_KEYS,
  TEARDOWN_ORDER,
} from "../src/cloud.js";
import {
  DOMAIN_ADAPTER_METHODS,
  DOMAIN_ADAPTER_PROPERTIES,
} from "../src/domain.js";
import {
  IDENTITY_SERVICE_ACCOUNTS,
  K8S_READ_VERBS,
  K8S_WRITE_VERBS,
} from "../src/cluster.js";
import { CONTRACT_RELAXATIONS } from "../src/contract/index.js";

/**
 * [v4.10] Bề mặt của hợp đồng, ĐỐI CHIẾU VỚI TÀI LIỆU.
 *
 * Vì sao đọc thẳng `docs/UDP_design.md`: hai con số dưới đây đã sai một lần trong một
 * bản nháp của plan ("tám phương thức" cho `DomainAdapter`, thực tế là bảy), và cách
 * duy nhất để một con số trong mã không trôi khỏi tài liệu là đọc tài liệu. Đây là cùng
 * lối với `packages/design-lint/tests/references.test.ts`.
 *
 * Bề mặt này là thứ sẽ bị **đóng băng bằng git tag** `adapter-interface-v1` trước khi
 * viết adapter đầu tiên được E1 đếm. Đóng băng một interface còn thiếu phương thức làm
 * kiểm soát (a) của E1 báo số sai theo hướng có lợi cho mình, nên các phép kiểm ở đây là
 * điều kiện của cái cổng đó.
 */

const DESIGN = readFileSync(
  new URL("../../../docs/UDP_design.md", import.meta.url),
  "utf8",
);

/** Cắt đoạn giữa hai mốc trong tài liệu, để đếm trong đúng phạm vi */
function sectionBetween(start: string, end: string): string {
  const from = DESIGN.indexOf(start);
  const to = DESIGN.indexOf(end, from + start.length);
  expect(from, `không thấy mốc "${start}"`).toBeGreaterThan(-1);
  expect(to, `không thấy mốc "${end}"`).toBeGreaterThan(from);
  return DESIGN.slice(from, to);
}

describe("CloudAdapter — mười phương thức", () => {
  it("hằng số có đúng mười tên, không trùng", () => {
    expect(CLOUD_ADAPTER_METHODS).toHaveLength(10);
    expect(new Set(CLOUD_ADAPTER_METHODS).size).toBe(10);
  });

  it("mọi tên trong hằng số đều xuất hiện trong khối interface của §4.2", () => {
    const block = sectionBetween(
      "interface CloudAdapter {",
      "interface ResourceStep {",
    );
    for (const name of CLOUD_ADAPTER_METHODS) {
      expect(block, name).toContain(`${name}(`);
    }
  });

  /**
   * Chiều ngược: tài liệu không được có phương thức nào mà hằng số thiếu.
   *
   * Không có chiều này thì bỏ một phương thức khỏi hằng số vẫn xanh, và bề mặt đóng băng
   * sẽ thiếu đúng thứ vừa bị bỏ.
   */
  it("khối interface của §4.2 không có phương thức nào ngoài mười tên đó", () => {
    const block = sectionBetween(
      "interface CloudAdapter {",
      "interface ResourceStep {",
    );
    const declared = [...block.matchAll(/^ {2}([a-z][A-Za-z]*)\(/gm)].map(
      (m) => m[1],
    );
    expect([...new Set(declared)].sort()).toEqual(
      [...CLOUD_ADAPTER_METHODS].sort(),
    );
  });
});

describe("DomainAdapter — bảy phương thức và sáu thuộc tính", () => {
  it("hằng số có đúng bảy và sáu", () => {
    expect(DOMAIN_ADAPTER_METHODS).toHaveLength(7);
    expect(DOMAIN_ADAPTER_PROPERTIES).toHaveLength(6);
  });

  it("bảy tên khớp khối interface của §5.2, cả hai chiều", () => {
    const block = sectionBetween(
      "interface DomainAdapter {",
      "interface WebhookDeployEvent {",
    );
    const declared = [...block.matchAll(/^ {2}([a-z][A-Za-z]*)\(/gm)].map(
      (m) => m[1],
    );
    expect([...new Set(declared)].sort()).toEqual(
      [...DOMAIN_ADAPTER_METHODS].sort(),
    );
  });

  it("sáu thuộc tính đều là readonly trong §5.2", () => {
    const block = sectionBetween(
      "interface DomainAdapter {",
      "interface WebhookDeployEvent {",
    );
    for (const prop of DOMAIN_ADAPTER_PROPERTIES) {
      expect(block, prop).toContain(`readonly ${prop}:`);
    }
  });
});

describe("Lược đồ tag — bốn bắt buộc, udp.ttl có điều kiện", () => {
  it("bốn khoá bắt buộc", () => {
    expect([...REQUIRED_TAG_KEYS].sort()).toEqual([
      "udp.key",
      "udp.managed",
      "udp.owner",
      "udp.project",
    ]);
  });

  /**
   * §4.5 khai `udp.ttl` là CÓ ĐIỀU KIỆN ("nếu project có `expires_at`"). Đòi đúng năm
   * khoá làm một project `expiry_action = WARN` không đặt `expires_at` — mặc định của
   * BYOC — hoặc đỏ, hoặc buộc hiện thực gắn một tag bịa.
   */
  it("project không có expires_at thì mong đợi ĐÚNG bốn khoá", () => {
    expect(expectedTagKeys(false)).toHaveLength(4);
    expect(expectedTagKeys(false)).not.toContain(CONDITIONAL_TTL_TAG_KEY);
  });

  it("project có expires_at thì mong đợi năm khoá", () => {
    expect(expectedTagKeys(true)).toHaveLength(5);
    expect(expectedTagKeys(true)).toContain(CONDITIONAL_TTL_TAG_KEY);
  });

  it("udp.managed nằm trong tập bắt buộc (§4.2 trước v4.10 thiếu nó)", () => {
    expect(REQUIRED_TAG_KEYS).toContain("udp.managed");
  });
});

describe("TEARDOWN_ORDER — chín bậc", () => {
  it("đúng chín bậc, không trùng", () => {
    expect(TEARDOWN_ORDER).toHaveLength(9);
    expect(new Set(TEARDOWN_ORDER).size).toBe(9);
  });

  /**
   * Thứ tự là toàn bộ nội dung của phép kiểm này: tài nguyên do K8s sinh phải đi TRƯỚC
   * network, và `vpc` phải là bậc cuối. Sai thứ tự thì `DeleteVpc` thất bại vĩnh viễn và
   * NAT gateway tiếp tục tính tiền trong tài khoản của khách.
   */
  it("k8s-managed trước, vpc cuối, và chờ đứng ngay sau k8s-managed", () => {
    expect(TEARDOWN_ORDER[0]).toBe("k8s-managed");
    expect(TEARDOWN_ORDER[1]).toBe("wait-k8s-gone");
    expect(TEARDOWN_ORDER.at(-1)).toBe("vpc");
    expect(TEARDOWN_ORDER.indexOf("cluster")).toBeLessThan(
      TEARDOWN_ORDER.indexOf("nat"),
    );
  });
});

describe("Cổng Kubernetes — tách verb đọc/ghi", () => {
  it("ba verb đọc, bảy verb ghi, không giao nhau", () => {
    expect(K8S_READ_VERBS).toHaveLength(3);
    expect(K8S_WRITE_VERBS).toHaveLength(7);
    const read = new Set<string>(K8S_READ_VERBS);
    expect(K8S_WRITE_VERBS.some((v) => read.has(v))).toBe(false);
  });

  it("ba identity ánh xạ tới ba ServiceAccount rời nhau trong udp-system", () => {
    const sas = Object.values(IDENTITY_SERVICE_ACCOUNTS);
    expect(sas).toHaveLength(3);
    expect(new Set(sas).size).toBe(3);
    for (const sa of sas) expect(sa.startsWith("udp-system/")).toBe(true);
  });

  it("ba ServiceAccount khớp tên trong bảng §12.2", () => {
    for (const sa of Object.values(IDENTITY_SERVICE_ACCOUNTS)) {
      const bare = sa.slice("udp-system/".length);
      expect(DESIGN, bare).toContain(`\`${bare}\``);
    }
  });
});

describe("Sổ nới lỏng hợp đồng (số liệu E1)", () => {
  /**
   * Bắt đầu từ rỗng là có chủ đích: §13.2 nói số lần phải nới lỏng bộ test chính là số
   * liệu báo cáo, nên con số đó phải TĂNG một cách nhìn thấy được trong diff, không phải
   * xuất hiện dưới dạng một `it.skip` nào đó.
   */
  it("rỗng lúc bắt đầu, và mỗi hàng đều phải có lý do", () => {
    expect(CONTRACT_RELAXATIONS).toHaveLength(0);
    for (const r of CONTRACT_RELAXATIONS) {
      expect(r.reason.length).toBeGreaterThan(20);
    }
  });
});

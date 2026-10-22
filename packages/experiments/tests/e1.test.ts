import { describe, expect, it } from "vitest";
import {
  countByKind,
  diffNames,
  interfaceMembers,
  kindOf,
  listConst,
  toolDirOf,
} from "../src/e1.js";

/**
 * [Plan #42] Phần thuần của E1: phân loại tệp của commit thêm tool, và đọc bề mặt interface từ mã
 * nguồn ở một commit bất kỳ (`git show`).
 */

describe("kindOf", () => {
  it("adapter, lớp nền, lõi, danh mục, schema, test, tài liệu, còn lại là mã sản phẩm", () => {
    const cases: [string, string][] = [
      [
        "services/core-backend/src/modules/database-adapter/redis/index.ts",
        "adapter",
      ],
      [
        "services/core-backend/src/modules/database-adapter/redis/contract.test.ts",
        "test",
      ],
      [
        "services/core-backend/src/modules/adapter-base/helm.ts",
        "adapter-base",
      ],
      ["packages/adapter-core/src/domain.ts", "adapter-core"],
      ["packages/config/src/domains.ts", "catalog"],
      ["packages/db/prisma/schema.prisma", "schema"],
      ["services/core-backend/tests/fixtures/wire/GET_x.json", "test"],
      ["docs/UDP_design.md", "docs"],
      ["README.md", "docs"],
      ["services/core-backend/src/modules/cost/cost.service.ts", "product"],
      ["apps/portal/src/features/x.tsx", "product"],
    ];
    for (const [path, kind] of cases) expect(kindOf(path), path).toBe(kind);
  });

  it("thư mục tool từ index.ts; tệp khác ⇒ null", () => {
    expect(
      toolDirOf(
        "services/core-backend/src/modules/cost-adapter/opencost/index.ts",
      ),
    ).toBe("services/core-backend/src/modules/cost-adapter/opencost");
    expect(
      toolDirOf(
        "services/core-backend/src/modules/cost-adapter/opencost/chart.ts",
      ),
    ).toBeNull();
  });

  it("đếm theo nhóm cộng đủ số tệp, nhóm vắng là 0", () => {
    const counts = countByKind(["docs/a.md", "packages/adapter-core/src/x.ts"]);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(2);
    expect(counts.schema).toBe(0);
  });
});

describe("đọc bề mặt interface", () => {
  const source = `
export const DOMAIN_ADAPTER_METHODS: readonly string[] = [
  "deploy",
  "teardown",
];

export interface DomainAdapterContext {
  /** chú thích: không phải thành viên */
  k8s: ClusterAccess;
  environment?: AdapterEnvironment;
  readonly environments: readonly AdapterEnvironment[];
  progress: (message: string) => void;
  nested: {
    inner: string;
  };
}

export interface CicdDomainAdapter extends DomainAdapter {
  verifySignature(
    raw: Buffer,
  ): boolean;
  parsePayload(rawBody: Buffer): WebhookDeployEvent;
}
`;

  it("mảng hằng: đúng thứ tự khai", () => {
    expect(listConst(source, "DOMAIN_ADAPTER_METHODS")).toEqual([
      "deploy",
      "teardown",
    ]);
    expect(listConst(source, "KHONG_CO")).toEqual([]);
  });

  it("interface: thành viên trực tiếp, bỏ chú thích và thân kiểu lồng", () => {
    expect(interfaceMembers(source, "DomainAdapterContext")).toEqual([
      "k8s",
      "environment",
      "environments",
      "progress",
      "nested",
    ]);
    expect(interfaceMembers(source, "CicdDomainAdapter")).toEqual([
      "verifySignature",
      "parsePayload",
    ]);
  });

  it("so hai bề mặt: thêm và bớt", () => {
    expect(diffNames(["a", "b"], ["b", "c"])).toEqual({
      added: ["c"],
      removed: ["a"],
    });
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [Plan #61 QĐ-17, 61d-2a] Bảng nhà cung cấp OIDC của Trusted Deploy — ghi SỔ KÉP.
 *
 * Bản thứ nhất: `TRUSTED_DEPLOY_PROVIDERS` trong `services/core-backend/src/modules/cicd/trusted-deploy.ts`
 * — nguồn sự thật, và là thứ `expectationOf` đọc lúc chạy.
 * Bản thứ hai: bảng trong §8.3 của `docs/UDP_design.md` — bản báo cáo.
 *
 * Vì sao cần chốt này, và vì sao nó khác mọi phép kiểm khác của Trusted Deploy: một lỗi chính tả trong
 * chuỗi issuer hay trong tên một claim KHÔNG làm bộ test nào khác đỏ. Nó chỉ làm mọi token bị từ chối ở
 * production, với một lý do rất khó truy — và nếu chế độ bắt buộc đang bật thì project tắc hẳn. Phép kiểm
 * này biến đúng cái lỗi đó thành một test đỏ ngay lúc sửa mã.
 *
 * Đọc mã nguồn dạng VĂN BẢN chứ không import: `@udp/design-lint` không phụ thuộc `@udp/core-backend`
 * (ranh giới package là một quyết định hạng nhất), nên mọi phép kiểm của nó soi backend đều đi bằng đường
 * đọc tệp — cùng khuôn với `cicd-signature.test.ts` và `drift-readonly.test.ts`.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const SOURCE = resolve(
  ROOT,
  "services/core-backend/src/modules/cicd/trusted-deploy.ts",
);
const DESIGN = resolve(ROOT, "docs/UDP_design.md");

/** Thứ tự cột của bảng trong §8.3, và cũng là thứ tự trường trong bảng khai báo của mã */
const FIELDS = [
  "issuer",
  "jwksPath",
  "alg",
  "tokenIdClaim",
  "repoClaim",
  "refClaim",
  "audience",
] as const;

type Row = Record<(typeof FIELDS)[number], string>;

/** Bảng trong mã: lấy từng khối `"<provider>": { … }` rồi bóc các cặp `khoá: "giá trị"` */
function tableInCode(): Record<string, Row> {
  const src = readFileSync(SOURCE, "utf8");
  const start = src.indexOf("export const TRUSTED_DEPLOY_PROVIDERS = {");
  expect(start, "không thấy TRUSTED_DEPLOY_PROVIDERS trong mã").toBeGreaterThan(
    -1,
  );
  const body = src.slice(start, src.indexOf("} as const;", start));

  const out: Record<string, Row> = {};
  for (const block of body.matchAll(
    /^ {2}"?([a-z-]+)"?: \{$([\s\S]*?)^ {2}\},$/gm,
  )) {
    const provider = block[1] ?? "";
    const inner = block[2] ?? "";
    const row: Partial<Row> = {};
    for (const field of FIELDS) {
      const found = new RegExp(`^ {4}${field}: "([^"]*)",$`, "m").exec(inner);
      expect(found, `${provider} thiếu trường ${field}`).not.toBeNull();
      row[field] = found?.[1] ?? "";
    }
    out[provider] = row as Row;
  }
  return out;
}

/** Bảng trong §8.3: các hàng bắt đầu bằng `> | ` và ô đầu là `` `<provider>` `` */
function tableInDesign(): Record<string, Row> {
  const doc = readFileSync(DESIGN, "utf8");
  const out: Record<string, Row> = {};
  for (const line of doc.split("\n")) {
    if (!line.startsWith("> | `")) continue;
    const cells = line
      .slice(2)
      .split("|")
      .map((c) => c.trim().replace(/^`|`$/g, ""))
      .filter((c) => c.length > 0);
    if (cells.length !== FIELDS.length + 1) continue;
    const [provider, ...values] = cells;
    const row: Partial<Row> = {};
    FIELDS.forEach((field, i) => {
      row[field] = values[i] ?? "";
    });
    out[provider ?? ""] = row as Row;
  }
  return out;
}

describe("bảng nhà cung cấp Trusted Deploy (Plan #61 QĐ-17)", () => {
  it("§8.3 và mã khai ĐÚNG cùng một bảng", () => {
    const code = tableInCode();
    const design = tableInDesign();

    // Cùng tập nhà cung cấp: thêm một nhà cung cấp ở một bên mà quên bên kia là một test đỏ
    expect(Object.keys(design).sort()).toEqual(Object.keys(code).sort());
    expect(design).toEqual(code);
  });

  it("ba nhà cung cấp SaaS đều ghim RS256 — đóng lớp alg-confusion", () => {
    for (const [provider, row] of Object.entries(tableInCode())) {
      expect(row.alg, `${provider} không ghim thuật toán`).toBe("RS256");
    }
  });

  it("ba CI trong cụm khai ở MỘT chỗ, và không chồng lên ba nhà cung cấp SaaS", () => {
    const src = readFileSync(SOURCE, "utf8");
    const found = /export const IN_CLUSTER_CI = \[([^\]]*)\] as const;/.exec(
      src,
    );
    expect(found, "không thấy IN_CLUSTER_CI trong mã").not.toBeNull();
    const inCluster = [...(found?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map(
      (m) => m[1],
    );
    expect(inCluster.sort()).toEqual(["drone", "jenkins", "tekton"]);
    for (const name of inCluster) {
      expect(
        Object.keys(tableInCode()),
        `${name ?? ""} vừa là CI trong cụm vừa là nhà cung cấp SaaS`,
      ).not.toContain(name);
    }
  });
});

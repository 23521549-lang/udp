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
/** [61d-2b-1] `IN_CLUSTER_CI` sống ở shared-types vì Portal cũng cần đúng tập đó */
const SHARED_BUILD = resolve(ROOT, "packages/shared-types/src/build.ts");

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
    /**
     * [61d-2b-1] Hằng này ở `@udp/shared-types` chứ không ở backend: cả Service 1 và Portal cần đúng tập
     * đó (Portal để nói ra bậc bảo đảm yếu hơn), và một bản chép thứ hai trong Portal sẽ trôi khỏi bản của
     * backend đúng vào ngày thêm CI thứ bảy.
     */
    const src = readFileSync(SHARED_BUILD, "utf8");
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

/**
 * [Plan #61 61d-2b-1] Bảng THỨ HAI: ba CI chạy trong cụm — cũng ghi sổ kép.
 *
 * Vì sao cần một phép kiểm riêng chứ không nhồi vào bảng nhà cung cấp SaaS: ba CI đó kiểm bằng một đường
 * KHÁC (khoá đọc từ chính cụm, không có issuer ghim, không có claim repo hay ref), nên nhồi chung sẽ làm
 * bảng SaaS nói sai. Bảng mới có 4 cột nên nó không lọt vào bộ đọc 7 cột ở trên.
 *
 * Và nó chốt thêm một thứ mà bảng SaaS không có: câu "KHÔNG chứng minh được nhánh". Đó là giới hạn đã công
 * bố của lớp này; mất câu đó khỏi tài liệu là tài liệu nói quá phần thu được.
 */
describe("bảng ba CI trong cụm (Plan #61 61d-2b-1)", () => {
  /** `IN_CLUSTER_TRUSTED_DEPLOY` trong mã — đọc dạng VĂN BẢN, cùng lý do như bảng trên */
  function inClusterInCode(): Record<string, string> {
    const src = readFileSync(SOURCE, "utf8");
    const start = src.indexOf("export const IN_CLUSTER_TRUSTED_DEPLOY = {");
    expect(start, "không thấy IN_CLUSTER_TRUSTED_DEPLOY").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("} as const;", start));
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/^ {2}(\w+): (?:`([^`]*)`|"([^"]*)")/gm)) {
      out[m[1] ?? ""] = resolveConstants(m[2] ?? m[3] ?? "");
    }
    return out;
  }

  /**
   * Chuỗi chủ thể trong mã ghép từ hai hằng của `adapter-base/packaging/build-script.ts`, nên phép kiểm
   * phải giải chúng ra — và như vậy nó kiểm luôn CẢ CHUỖI: đổi `BUILD_NAMESPACE` mà không sửa §8.3 cũng đỏ.
   */
  function resolveConstants(text: string): string {
    const src = readFileSync(
      resolve(
        ROOT,
        "services/core-backend/src/modules/adapter-base/packaging/build-script.ts",
      ),
      "utf8",
    );
    return text.replaceAll(/\$\{(\w+)\}/g, (_whole, name: string) => {
      const found = new RegExp(`export const ${name} = "([^"]*)";`).exec(src);
      expect(
        found,
        `không thấy hằng ${name} trong build-script.ts`,
      ).not.toBeNull();
      return found?.[1] ?? "";
    });
  }

  /** Các hàng 4 cột của §8.3: ô đầu là tên tool trong dấu nháy ngược */
  function inClusterInDesign(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const line of readFileSync(DESIGN, "utf8").split("\n")) {
      if (!line.startsWith("> | `")) continue;
      const cells = line
        .slice(2)
        .split("|")
        .map((c) => c.trim().replace(/^`|`$/g, ""))
        .filter((c) => c.length > 0);
      if (cells.length !== 4) continue;
      const [tool, ...rest] = cells;
      out[tool ?? ""] = rest;
    }
    return out;
  }

  it("§8.3 khai ĐÚNG ba tool, với đúng chủ thể và đúng nguồn `aud` của mã", () => {
    const code = inClusterInCode();
    const design = inClusterInDesign();

    expect(Object.keys(design).sort()).toEqual(["drone", "jenkins", "tekton"]);
    for (const [tool, cells] of Object.entries(design)) {
      expect(cells[0], `${tool}: chủ thể lệch mã`).toBe(code.subject);
      expect(cells[1], `${tool}: nguồn aud lệch mã`).toBe(code.audience);
      expect(cells[2], `${tool}: điều không chứng minh được lệch mã`).toBe(
        code.cannotProve,
      );
    }
  });

  it("chủ thể là ĐÚNG ServiceAccount build, không phải một SA nào khác", () => {
    // Chuỗi này là phép kiểm chặn leo thang nội cụm; một lỗi chính tả ở đây mở cửa cho mọi pod trong cụm
    expect(inClusterInCode().subject).toBe(
      "system:serviceaccount:udp-build:udp-builder",
    );
  });

  it("allowlist thuật toán của nhánh cụm không có HS* hay none", () => {
    const src = readFileSync(SOURCE, "utf8");
    const found = /algorithms: \[([^\]]*)\]/.exec(
      src.slice(src.indexOf("export const IN_CLUSTER_TRUSTED_DEPLOY = {")),
    );
    const algs = [...(found?.[1] ?? "").matchAll(/"([A-Z0-9]+)"/g)].map(
      (m) => m[1],
    );
    expect(algs.sort()).toEqual(["ES256", "ES384", "ES512", "RS256"]);
  });

  it("§8.3 nói rõ lớp này KHÔNG chứng minh nhánh", () => {
    const doc = readFileSync(DESIGN, "utf8");
    const start = doc.indexOf("Trusted Deploy cho ba CI chạy TRONG CỤM");
    expect(start, "không thấy đoạn 61d-2b-1 trong §8.3").toBeGreaterThan(-1);
    const block = doc.slice(start, start + 6000);
    expect(block).toContain("không** chứng minh nhánh");
    // Và nói rõ quyền đọc khoá là quyền MẶC ĐỊNH của Kubernetes, không do UDP cấp
    expect(block).toContain("system:service-account-issuer-discovery");
  });
});

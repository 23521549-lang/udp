import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [v4.12, Plan #61 61d-2b-1] Bootstrap KHÔNG cấp quyền đọc khoá issuer — và đó là câu chịu lực của §8.3.
 *
 * Đường kiểm token của ba CI chạy trong cụm đọc `/.well-known/openid-configuration` và `/openid/v1/jwks`
 * bằng `udp-tooling`. Cả lối đó rẻ (không bootstrap lại cụm nào đang chạy) CHỈ VÌ quyền ấy đến từ
 * ClusterRoleBinding **mặc định** của Kubernetes cho nhóm `system:serviceaccounts`, không từ Role nào của
 * UDP. Nếu một ngày ai đó "tiện tay" cấp nó trong bootstrap thì ba điều cùng sai: §12.2 nói sai sự thật,
 * mọi cụm đang chạy cần một lượt bootstrap lại, và lý lẽ "không thêm verb nào" của §8.3 mất hiệu lực.
 *
 * Phép kiểm này biến đúng lần sửa đó thành một test đỏ, chứ không để nó trôi vào một commit "dọn RBAC".
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

describe("quyền đọc khoá issuer của cụm là quyền MẶC ĐỊNH của Kubernetes", () => {
  it("bootstrap không khai nonResourceURLs, không nhắc openid hay issuer-discovery", () => {
    const src = read("services/core-backend/src/modules/cluster/bootstrap.ts");
    for (const needle of [
      "nonResourceURLs",
      "openid",
      "issuer-discovery",
      "tokenreviews",
    ]) {
      expect(
        src.includes(needle),
        `bootstrap nhắc "${needle}": nếu UDP bắt đầu tự cấp quyền này thì §8.3 và §12.2 phải viết lại`,
      ).toBe(false);
    }
  });

  it("§12.2 nói rõ quyền đó không do UDP cấp và không thu hồi được", () => {
    const design = read("docs/UDP_design.md");
    const start = design.indexOf("### 12.2");
    expect(start).toBeGreaterThan(-1);
    const section = design.slice(start, design.indexOf("\n### ", start + 10));
    expect(section).toContain("system:service-account-issuer-discovery");
    expect(section).toContain("system:serviceaccounts");
    expect(section).toContain("không thu");
  });

  it("đường đọc khoá dùng ĐÚNG identity tooling, không workload hay traffic", () => {
    const src = read("packages/cluster-access/src/direct.ts");
    const start = src.indexOf("async issuerKeys()");
    expect(start, "không thấy issuerKeys trong direct.ts").toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf("\n    },", start));
    expect(fn).toContain('tokenFor("tooling")');
    for (const other of ['tokenFor("workload")', 'tokenFor("traffic")']) {
      expect(fn.includes(other), `issuerKeys dùng ${other}`).toBe(false);
    }
    // Và KHÔNG đi theo `jwks_uri` của discovery — đó là một địa chỉ ngoài
    expect(fn.includes("jwks_uri")).toBe(false);
  });
});

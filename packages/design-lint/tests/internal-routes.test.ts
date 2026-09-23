import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readDesignDoc } from "../src/design-doc.js";

/**
 * §9 nói `/internal/*` là hợp đồng giữa Service 1, Service 3 và Service 2, và nói
 * thêm một câu mạnh hơn: "`/internal/*` không được phơi ra Internet". Cả hai câu
 * chỉ đúng khi DANH SÁCH ở §9 là danh sách THẬT.
 *
 * Vì sao một route nội bộ không có trong §9 là lỗi, không phải thiếu sót tài liệu:
 *
 *   - NetworkPolicy và cấu hình ingress được viết từ §9. Một route không có trong
 *     tài liệu là một route không ai nghĩ tới khi viết luật mạng.
 *   - §9 cũng là nơi ghi route nào BẮT BUỘC `X-Udp-Actor-Id`. Một route ghi không
 *     có trong bảng thì cũng không có trong câu nói về audit, và I40 mất một mặt.
 *   - Cả hai điều trên im lặng: mọi test chức năng vẫn xanh, vì test chức năng gọi
 *     route bằng đúng client đã biết nó tồn tại.
 *
 * Chiều được cưỡng chế là code ⇒ tài liệu (thêm route mà quên §9 là fail build).
 * Chiều ngược lại, tài liệu ⇒ code, được canh MỀM bằng danh sách miễn trừ dưới
 * đây, giống cách `project-route-guard` xử lý ngoại lệ của I10: một route đã đặc tả
 * mà chưa hiện thực thì phải khai ra và nói ở §16, không được lặng lẽ nằm đó.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const S2 = join(ROOT, "services", "flag-service", "src");
const PREFIX = "/internal";

/**
 * Route CÓ ở §9 mà CHƯA có trong code, kèm lý do phải đọc được.
 *
 * Mỗi mục ở đây là một lời hứa còn nợ, nên nó phải trỏ tới chỗ §16 ghi nhận nó.
 * Test cuối cùng buộc danh sách này không mọc rêu theo chiều ngược lại: một mục
 * trỏ tới route §9 đã bị xoá cũng là lỗi.
 */
const NOT_IMPLEMENTED: Record<string, string> = {
  "PUT /internal/flags/:param/variants":
    "PUT variants chưa hiện thực — §16 ghi nhận trong hàng 'Luồng 4 ở Service 1 chưa đủ route §9'",
};

/** `:id`, `:ruleId`, `:sessionId`… là cùng một thứ với lint này */
const normalize = (path: string): string =>
  path.replace(/:[A-Za-z0-9_]+/g, ":param").replace(/\/$/, "");

const keyOf = (method: string, path: string): string =>
  `${method.toUpperCase()} ${normalize(path)}`;

// ------------------------------------------------------------- phía code

const appText = readFileSync(join(S2, "app.ts"), "utf8");

/**
 * Router nào được gắn dưới `/internal`.
 *
 * Hai hình dạng cùng tồn tại trong `app.ts` và cả hai đều có lý do đã ghi ở đó:
 * `app.use("/internal", oneRouter)` cho router cần mount TRƯỚC parser toàn cục, và
 * một lời gọi mang nhiều router cho phần còn lại. Đọc cả hai bằng một biểu thức
 * trên phần đối số, chứ không giả định số lượng.
 */
const mountedRouters = [
  ...appText.matchAll(/app\.use\(\s*"\/internal"\s*,([\s\S]*?)\);/g),
].flatMap((m) =>
  [...(m[1] as string).matchAll(/\b(\w*Router)\b/g)].map((r) => r[1] as string),
);

interface CodeRoute {
  file: string;
  router: string;
  method: string;
  path: string;
}

function codeRoutes(): CodeRoute[] {
  const dir = join(S2, "internal");
  const out: CodeRoute[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".ts")) continue;
    const text = readFileSync(join(dir, entry), "utf8");
    /**
     * Chỉ định danh kết thúc bằng `Router`, và đường dẫn phải bắt đầu bằng `/`.
     * Cả hai điều kiện đều cần: `req.get("If-Match")` khớp một biểu thức lỏng hơn
     * và sẽ được ghi vào danh sách route như `GET /internalIf-Match` — một dòng
     * rác không bao giờ có ở §9, tức lint đỏ vĩnh viễn vì lý do sai.
     */
    for (const m of text.matchAll(
      /(\w*Router)\.(get|post|put|patch|delete)\(\s*"(\/[^"]*)"/g,
    )) {
      out.push({
        file: `services/flag-service/src/internal/${entry}`,
        router: m[1] as string,
        method: m[2] as string,
        path: m[3] as string,
      });
    }
  }
  return out;
}

const routes = codeRoutes();

// ------------------------------------------------------------- phía tài liệu

/**
 * Chỉ khối "Internal" trong mục Service 2 của §9.
 *
 * Không grep toàn tài liệu: Service 1 cũng có một route `/internal`
 * (`POST /internal/clusters/:id/token` cho Service 3), và gộp nó vào đây sẽ làm
 * lint này đòi Service 2 hiện thực một route của Service 1.
 */
function documentedRoutes(): string[] {
  const lines = readDesignDoc();
  const start = lines.findIndex((l) =>
    l.startsWith("Internal — chỉ Core Backend và PD Controller gọi"),
  );
  if (start < 0)
    throw new Error("§9: không tìm thấy khối Internal của Service 2");

  const end = lines.findIndex((l, i) => i > start && l.trim() === "```");
  if (end < 0) throw new Error("§9: khối Internal không đóng");

  const out: string[] = [];
  for (const line of lines.slice(start, end)) {
    const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/internal\/\S+)/.exec(line);
    if (m === null) continue;
    // Bỏ phần query string minh hoạ (`?projectId=&limit=`)
    const path = (m[2] as string).split("?")[0] as string;
    out.push(keyOf(m[1] as string, path));
  }
  return out;
}

const documented = documentedRoutes();

describe("§9 — mọi route /internal/* của Service 2 đều có trong tài liệu", () => {
  it("đọc được cả hai phía — nếu không, mọi test dưới rỗng", () => {
    // Chốt chống rỗng, cả ba nguồn: mount, khai báo route, và khối §9.
    expect(mountedRouters.length).toBeGreaterThanOrEqual(2);
    expect(routes.length).toBeGreaterThanOrEqual(14);
    expect(documented.length).toBeGreaterThanOrEqual(14);
  });

  it("mọi router có khai báo route đều được gắn dưới /internal", () => {
    /**
     * Nếu một controller mới ra đời mà không ai gắn nó, route của nó không tồn tại
     * trên dây — và phép so với §9 dưới đây sẽ xanh vì cả hai phía đều không có
     * nó. Chốt này giữ cho "phía code" là thứ chạy thật, không phải thứ được viết.
     */
    const orphans = [...new Set(routes.map((r) => r.router))]
      .filter((name) => !mountedRouters.includes(name))
      .map(
        (name) =>
          `${name} khai route /internal nhưng không được app.use("/internal", …) gắn`,
      );

    expect(orphans).toEqual([]);
  });

  it("route trong code đều có một dòng ở §9", () => {
    const known = new Set(documented);
    const missing = routes
      .filter((r) => !known.has(keyOf(r.method, PREFIX + r.path)))
      .map(
        (r) =>
          `${r.file}: ${r.method.toUpperCase()} ${PREFIX}${r.path} chưa có ở §9 ` +
          `(khối Internal của Service 2)`,
      )
      .sort();

    expect(missing).toEqual([]);
  });

  it("dòng ở §9 không có trong code thì phải được khai là chưa hiện thực", () => {
    const inCode = new Set(routes.map((r) => keyOf(r.method, PREFIX + r.path)));
    const undeclared = documented
      .filter((k) => !inCode.has(k))
      .filter((k) => NOT_IMPLEMENTED[k] === undefined)
      .sort();

    expect(undeclared).toEqual([]);
  });

  it("danh sách chưa-hiện-thực không có mục mọc rêu", () => {
    // Một mục trỏ tới route §9 đã bị xoá là một lời hứa về thứ không còn được hứa.
    const known = new Set(documented);
    const stale = Object.keys(NOT_IMPLEMENTED).filter((k) => !known.has(k));

    expect(stale).toEqual([]);
  });
});

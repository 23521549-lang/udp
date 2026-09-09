import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Bất biến I10 — "Mọi route có id project đều qua `requireProjectRole`, so với
 * **danh sách route được miễn trừ tường minh**".
 *
 * Vế sau của câu đó quan trọng ngang vế trước. Một lint chỉ kiểm "route nào có
 * id thì phải có middleware" sẽ im lặng khi ai đó thêm route mới rồi tự cho nó
 * là ngoại lệ. Danh sách dưới đây buộc mỗi ngoại lệ phải được viết ra, và test
 * cuối cùng buộc nó không được mọc rêu: một mục trỏ tới route không còn tồn tại
 * cũng là lỗi.
 *
 * §12 T4 nói vì sao I10 đáng có một lint riêng: thiếu middleware ở đúng một
 * route là đủ để người dùng đọc project của người khác bằng cách đổi id trên
 * URL — và đó là loại lỗi không lộ ra trong bất kỳ test chức năng nào, vì test
 * chức năng bao giờ cũng gọi bằng đúng người có quyền.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const SRC = join(ROOT, "services", "core-backend", "src");

/**
 * Route KHÔNG cần `requireMinProjectRole`, kèm lý do.
 *
 * Chỉ có hai, và cả hai vì cùng một lẽ: chúng không mang id project nên không
 * có gì để kiểm vai trò. Cả hai vẫn phải qua `requireAuth`, và cả hai tự lọc
 * theo tư cách thành viên trong chính câu truy vấn (§12.2 tầng 1).
 */
const EXEMPT: Record<string, string> = {
  "POST /": "Tạo project — chưa có project nào để kiểm vai trò",
  "GET /":
    "Danh sách project của chính người gọi — repository lọc theo ProjectMember",
};

const GUARD = "requireMinProjectRole";
const METHODS = "get|post|put|patch|delete";

interface Route {
  file: string;
  router: string;
  method: string;
  path: string;
  /** Phần giữa đường dẫn và dấu đóng ngoặc — nơi middleware được liệt kê */
  chain: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === "dist" || entry === "generated")
        continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const files = sourceFiles(SRC).map((path) => ({
  rel: path.replace(ROOT, "").replace(/\\/g, "/"),
  text: readFileSync(path, "utf8"),
}));

const all = files.map((f) => f.text).join("\n");

/**
 * Router nào phục vụ vùng project.
 *
 * Hai đường: router gắn thẳng vào `/projects` trong `app.ts`, và mọi router con
 * gắn qua `use("/:id", ...)` — nhóm sau nguy hiểm hơn vì đường dẫn của chúng
 * (`/members`, `/transfer-ownership`) KHÔNG chứa `:id` khi đọc riêng lẻ, nên
 * một lint chỉ soi chuỗi đường dẫn sẽ bỏ sót toàn bộ.
 */
const mountedAtProjects = [
  ...all.matchAll(/app\.use\([^,]*\/projects`?,\s*(\w+)\)/g),
].map((m) => m[1] as string);

const scopedSubRouters = [
  ...all.matchAll(/(\w+)\.use\("\/:id",\s*(\w+)\)/g),
].map((m) => m[2] as string);

function routesOf(): Route[] {
  const out: Route[] = [];
  const pattern = new RegExp(
    `(\\w+)\\.(${METHODS})\\(\\s*"([^"]*)",([\\s\\S]*?)\\n\\);`,
    "g",
  );

  for (const file of files) {
    for (const m of file.text.matchAll(pattern)) {
      out.push({
        file: file.rel,
        router: m[1] as string,
        method: (m[2] as string).toUpperCase(),
        path: m[3] as string,
        chain: m[4] as string,
      });
    }
  }
  return out;
}

const routes = routesOf();

/** Route thuộc vùng project: router gắn ở `/projects`, hoặc router con dưới `/:id` */
const projectRoutes = routes.filter(
  (r) =>
    mountedAtProjects.includes(r.router) || scopedSubRouters.includes(r.router),
);

const keyOf = (r: Route): string => `${r.method} ${r.path}`;

describe("I10 — mọi route có id project đều qua requireMinProjectRole", () => {
  it("nhận diện được router của vùng project — nếu không, mọi test dưới rỗng", () => {
    // Chốt chống rỗng. Nếu ai đó đổi cách gắn router, các test dưới sẽ duyệt
    // một danh sách trống và xanh mà chẳng kiểm gì.
    expect(mountedAtProjects.length).toBeGreaterThan(0);
    expect(scopedSubRouters.length).toBeGreaterThan(0);
    expect(projectRoutes.length).toBeGreaterThanOrEqual(5);
  });

  it("route không được miễn trừ thì phải gắn requireMinProjectRole", () => {
    const missing = projectRoutes
      .filter((r) => EXEMPT[keyOf(r)] === undefined)
      .filter((r) => !r.chain.includes(GUARD))
      .map((r) => `${r.file}: ${keyOf(r)} thiếu ${GUARD}`);

    expect(missing).toEqual([]);
  });

  it("route đã miễn trừ thì KHÔNG được mang id project trên đường dẫn", () => {
    // Miễn trừ chỉ hợp lệ khi route thật sự không có gì để kiểm. Một route vừa
    // được miễn vừa nhận `:id` là đúng lỗ hổng mà §12 T4 mô tả.
    const wrong = projectRoutes
      .filter((r) => EXEMPT[keyOf(r)] !== undefined)
      .filter(
        (r) => r.path.includes(":id") || scopedSubRouters.includes(r.router),
      )
      .map(
        (r) => `${r.file}: ${keyOf(r)} được miễn trừ nhưng vẫn mang id project`,
      );

    expect(wrong).toEqual([]);
  });

  it("mọi route vùng project đều qua requireAuth", () => {
    // `requireMinProjectRole` đọc `req.user`, nên thiếu `requireAuth` thì nó ném
    // 401 thay vì kiểm quyền — đúng kết quả, nhưng vì lý do sai, và sẽ thành
    // sai kết quả ngay khi ai đó đổi thứ tự.
    const missing = projectRoutes
      .filter((r) => !r.chain.includes("requireAuth"))
      .map((r) => `${r.file}: ${keyOf(r)} thiếu requireAuth`);

    expect(missing).toEqual([]);
  });

  it("danh sách miễn trừ không có mục mọc rêu", () => {
    const known = new Set(projectRoutes.map(keyOf));
    const stale = Object.keys(EXEMPT).filter((k) => !known.has(k));

    expect(stale).toEqual([]);
  });
});

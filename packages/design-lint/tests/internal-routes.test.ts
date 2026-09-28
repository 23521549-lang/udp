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
 *
 * [v4.11, Plan #39] Hai service có route nội bộ, mỗi bên một khối riêng ở §9: Service 2
 * (bên gọi S1, S3) và Service 1 (bên gọi S3 — đo metrics thay S3, D-P30). Mỗi bên chỉ so
 * với khối CỦA NÓ: gộp là đòi một service hiện thực route của service kia.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const PREFIX = "/internal";

interface InternalService {
  name: string;
  /** Thư mục `src` của service — route nội bộ ở `src/internal/`, mount ở `src/app.ts` */
  src: string;
  /** Dòng mở khối Internal của service này ở §9 */
  heading: string;
  /** Dòng đóng khối — khối của S2 đóng bằng rào mã, khối của S1 bằng dòng trống */
  closes: (line: string) => boolean;
  /** Chốt chống rỗng: ít nhất chừng này mount, route trong code, dòng ở §9 */
  floor: { mounts: number; routes: number; documented: number };
  /**
   * Route CÓ ở §9 mà CHƯA có trong code, kèm lý do phải đọc được.
   *
   * Mỗi mục ở đây là một lời hứa còn nợ, nên nó phải trỏ tới chỗ §16 ghi nhận nó.
   * Test cuối cùng buộc danh sách này không mọc rêu theo chiều ngược lại: một mục
   * trỏ tới route §9 đã bị xoá, hay đã hiện thực, cũng là lỗi.
   */
  notImplemented: Record<string, string>;
}

const SERVICES: InternalService[] = [
  {
    name: "Service 2",
    src: "services/flag-service/src",
    heading: "Internal — chỉ Core Backend và PD Controller gọi",
    closes: (l) => l.trim() === "```",
    floor: { mounts: 2, routes: 14, documented: 14 },
    notImplemented: {},
  },
  {
    name: "Service 1",
    src: "services/core-backend/src",
    heading: "Internal — chỉ Service 2 và Service 3 gọi",
    closes: (l) => l.trim() === "",
    floor: { mounts: 1, routes: 2, documented: 3 },
    notImplemented: {
      "POST /internal/clusters/:param/token":
        "Service 3 chưa có executor SERVICE_LEVEL cần token cluster — §16 hàng 'Lát cắt Luồng 5: chỉ FLAG_LEVEL + CANARY'; metrics trong cluster đã đi qua S1 (D-P30)",
    },
  },
];

/** `:id`, `:ruleId`, `:sessionId`… là cùng một thứ với lint này */
const normalize = (path: string): string =>
  path.replace(/:[A-Za-z0-9_]+/g, ":param").replace(/\/$/, "");

const keyOf = (method: string, path: string): string =>
  `${method.toUpperCase()} ${normalize(path)}`;

// ------------------------------------------------------------- phía code

/**
 * Router nào được gắn dưới `/internal`.
 *
 * Hai hình dạng cùng tồn tại trong `app.ts` của S2 và cả hai đều có lý do đã ghi ở
 * đó: `app.use("/internal", oneRouter)` cho router cần mount TRƯỚC parser toàn cục,
 * và một lời gọi mang nhiều router cho phần còn lại. Đọc cả hai bằng một biểu thức
 * trên phần đối số, chứ không giả định số lượng.
 */
function mountedRouters(service: InternalService): string[] {
  const appText = readFileSync(join(ROOT, service.src, "app.ts"), "utf8");
  return [
    ...appText.matchAll(/app\.use\(\s*"\/internal"\s*,([\s\S]*?)\);/g),
  ].flatMap((m) =>
    [...(m[1] as string).matchAll(/\b(\w*Router)\b/g)].map(
      (r) => r[1] as string,
    ),
  );
}

interface CodeRoute {
  file: string;
  router: string;
  method: string;
  path: string;
}

function codeRoutes(service: InternalService): CodeRoute[] {
  const dir = join(ROOT, service.src, "internal");
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
        file: `${service.src}/internal/${entry}`,
        router: m[1] as string,
        method: m[2] as string,
        path: m[3] as string,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------- phía tài liệu

/**
 * Chỉ khối "Internal" của ĐÚNG service ở §9 — không grep toàn tài liệu: mỗi service có
 * khối riêng, gộp lại là đòi service này hiện thực route của service kia.
 */
function documentedRoutes(service: InternalService): string[] {
  const lines = readDesignDoc();
  const start = lines.findIndex((l) => l.startsWith(service.heading));
  if (start < 0) {
    throw new Error(`§9: không tìm thấy khối Internal của ${service.name}`);
  }
  const end = lines.findIndex((l, i) => i > start && service.closes(l));
  if (end < 0) {
    throw new Error(`§9: khối Internal của ${service.name} không đóng`);
  }

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

describe.each(SERVICES)(
  "§9 — mọi route /internal/* của $name đều có trong tài liệu",
  (service) => {
    const mounted = mountedRouters(service);
    const routes = codeRoutes(service);
    const documented = documentedRoutes(service);
    const inCode = new Set(routes.map((r) => keyOf(r.method, PREFIX + r.path)));

    it("đọc được cả hai phía — nếu không, mọi test dưới rỗng", () => {
      // Chốt chống rỗng, cả ba nguồn: mount, khai báo route, và khối §9.
      expect(mounted.length).toBeGreaterThanOrEqual(service.floor.mounts);
      expect(routes.length).toBeGreaterThanOrEqual(service.floor.routes);
      expect(documented.length).toBeGreaterThanOrEqual(
        service.floor.documented,
      );
    });

    it("mọi router có khai báo route đều được gắn dưới /internal", () => {
      /**
       * Nếu một controller mới ra đời mà không ai gắn nó, route của nó không tồn tại
       * trên dây — và phép so với §9 dưới đây sẽ xanh vì cả hai phía đều không có
       * nó. Chốt này giữ cho "phía code" là thứ chạy thật, không phải thứ được viết.
       */
      const orphans = [...new Set(routes.map((r) => r.router))]
        .filter((name) => !mounted.includes(name))
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
            `(khối Internal của ${service.name})`,
        )
        .sort();

      expect(missing).toEqual([]);
    });

    it("dòng ở §9 không có trong code thì phải được khai là chưa hiện thực", () => {
      const undeclared = documented
        .filter((k) => !inCode.has(k))
        .filter((k) => service.notImplemented[k] === undefined)
        .sort();

      expect(undeclared).toEqual([]);
    });

    it("danh sách chưa-hiện-thực không có mục mọc rêu", () => {
      // Mục trỏ tới route §9 đã bị xoá — hay đã hiện thực — là lời hứa về thứ không còn nợ
      const known = new Set(documented);
      const stale = Object.keys(service.notImplemented).filter(
        (k) => !known.has(k) || inCode.has(k),
      );

      expect(stale).toEqual([]);
    });
  },
);

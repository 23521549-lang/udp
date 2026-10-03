import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `POST …/environments/:envId/keys` cố ý KHÔNG đi qua `idempotent()`, và điều đó
 * phải được CANH chứ không chỉ được ghi.
 *
 * Lý do là một câu của §2.2: plaintext SDK key "chỉ hiện 1 lần lúc tạo, không lưu
 * DB". `idempotent()` lưu NGUYÊN thân response 2xx vào
 * `idempotency_keys.response_body` rồi phát lại trong 24 giờ — gắn nó vào route
 * này là ghi thẳng plaintext vào database, đúng thứ câu trên cấm. Không có lỗi nào
 * nổ ra: test chức năng vẫn xanh, response vẫn đúng, và bí mật nằm đó 24 giờ.
 *
 * Hình dạng của rủi ro là thứ khiến nó xứng đáng có lint: mọi POST tạo tài nguyên
 * KHÁC trong Service 1 đều NÊN có `idempotent()` (§9), nên "thêm middleware này
 * cho nhất quán" là việc rất dễ có người làm, với ý tốt. Một chú thích ở chuỗi
 * middleware không chặn được điều đó — chú thích chỉ được đọc bởi người đã dừng
 * lại để đọc.
 *
 * Phép kiểm có ĐỐI CHỨNG DƯƠNG ở test thứ hai: cùng bộ dò phải TÌM THẤY
 * `idempotent(` ở những route lẽ ra có nó. Không có vế đó thì test đầu xanh cả khi
 * bộ dò đã hỏng (đổi tên middleware, đổi cách gắn) và không còn nhìn gì nữa.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const S1 = join(ROOT, "services", "core-backend", "src");

const GUARD = "idempotent(";
/** Route tạo SDK key — đường dẫn viết bằng chuỗi trực tiếp, đúng để lint đọc được */
const KEYS_PATH = "/environments/:envId/keys";

interface Route {
  file: string;
  method: string;
  path: string;
  /** Từ sau đường dẫn tới dấu đóng của lời gọi: middleware VÀ thân handler */
  chain: string;
}

function tsFilesUnder(dir: string): string[] {
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

function routesOf(): Route[] {
  const out: Route[] = [];
  const pattern =
    /(\w*Router)\.(get|post|put|patch|delete)\(\s*"([^"]*)",([\s\S]*?)\n\);/g;

  for (const path of tsFilesUnder(S1)) {
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(pattern)) {
      out.push({
        file: path.replace(ROOT, "").replace(/\\/g, "/"),
        method: (m[2] as string).toUpperCase(),
        path: m[3] as string,
        chain: m[4] as string,
      });
    }
  }
  return out;
}

const routes = routesOf();
const keyRoutes = routes.filter((r) => r.path.startsWith(KEYS_PATH));

describe("route SDK key không bao giờ lưu plaintext qua idempotency (§2.2)", () => {
  it("tìm được cả ba route của SDK key — nếu không, test dưới rỗng", () => {
    // GET, POST và DELETE. Đường dẫn phải là chuỗi trực tiếp: ghép bằng biến thì
    // route thoát khỏi mọi lint đọc mã, kể cả I10 (`project-route-guard`).
    expect(keyRoutes.map((r) => r.method).sort()).toEqual([
      "DELETE",
      "GET",
      "POST",
    ]);
  });

  it("POST tạo khoá KHÔNG gắn idempotent()", () => {
    const offenders = keyRoutes
      .filter((r) => r.method === "POST")
      .filter((r) => r.chain.includes(GUARD))
      .map(
        (r) =>
          `${r.file}: POST ${r.path} gắn ${GUARD} — response mang plaintext SDK ` +
          `key và sẽ bị lưu vào idempotency_keys.response_body 24 giờ (§2.2)`,
      );

    expect(offenders).toEqual([]);
  });

  it("bộ dò idempotent() thật sự nhìn thấy — có route khác đang dùng nó", () => {
    // Đối chứng dương. `POST /projects/:id/members` và `POST /projects/:id/rollouts`
    // là hai route mà §9 nói PHẢI có `Idempotency-Key`; nếu bộ dò không thấy chúng
    // thì test trên không chứng minh điều gì.
    const withGuard = routes
      .filter((r) => r.chain.includes(GUARD))
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    expect(withGuard.length).toBeGreaterThanOrEqual(2);
    expect(withGuard).toContain("POST /rollouts");
    expect(withGuard).toContain("POST /members");
  });

  it("response tạo khoá đặt no-store để không có bản sao nào ở tầng cache", () => {
    // Cùng họ với phép kiểm trên: response duy nhất trong cả API mang một bí mật
    // dùng được ngay, nên chỗ lưu nó không chỉ là database.
    const post = keyRoutes.find((r) => r.method === "POST");
    expect(post, "không tìm thấy POST tạo khoá").toBeDefined();
    expect(post?.chain).toContain("no-store");
  });
});

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * [v4.11, Plan #55] Cặp đôi của I10 cho nhóm — mọi route của `teamRouter` mang `:teamId` đi qua `requireTeamRole`,
 * và mọi route của nó qua `requireAuth`.
 *
 * Cùng lý do với I10 (§12 T4): thiếu guard ở đúng một route là đủ để người ngoài đọc thành viên của nhóm, hay tự
 * thêm mình vào một nhóm đang có quyền trên project của người khác — tức là leo thang sang MỌI project nhóm đó
 * được cấp. Test chức năng không bao giờ lộ lỗi này, vì chúng gọi bằng đúng người có quyền.
 *
 * `/projects/:id/teams/:teamId` KHÔNG thuộc phép này: ở đó `:teamId` là khoá của grant, còn cửa vào là vai trên
 * project — I10 đã phủ.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const FILE = join(
  ROOT,
  "services",
  "core-backend",
  "src",
  "modules",
  "team",
  "team.controller.ts",
);
const APP = join(ROOT, "services", "core-backend", "src", "app.ts");

const text = readFileSync(FILE, "utf8");

interface Route {
  method: string;
  path: string;
  chain: string;
}

const routes: Route[] = [
  ...text.matchAll(
    /teamRouter\.(get|post|put|patch|delete)\(\s*"([^"]*)",([\s\S]*?)\n\);/g,
  ),
].map((m) => ({
  method: (m[1] as string).toUpperCase(),
  path: m[2] as string,
  chain: m[3] as string,
}));

const keyOf = (r: Route): string => `${r.method} ${r.path}`;

describe("team-route-guard — mọi route có :teamId qua requireTeamRole", () => {
  it("teamRouter được gắn ở /teams và đọc được route của nó — không phải 0", () => {
    expect(readFileSync(APP, "utf8")).toMatch(
      /app\.use\(`\$\{API_PREFIX\}\/teams`,\s*teamRouter\)/,
    );
    expect(routes.length).toBeGreaterThanOrEqual(10);
    expect(routes.filter((r) => r.path.includes(":teamId")).length).toBe(
      routes.length - 2,
    );
  });

  it("route có :teamId thì phải gắn requireTeamRole", () => {
    const missing = routes
      .filter((r) => r.path.includes(":teamId"))
      .filter((r) => !r.chain.includes("requireTeamRole("))
      .map((r) => `${keyOf(r)} thiếu requireTeamRole`);
    expect(missing).toEqual([]);
  });

  it("route KHÔNG có :teamId chỉ là danh sách và tạo nhóm của chính người gọi", () => {
    expect(
      routes
        .filter((r) => !r.path.includes(":teamId"))
        .map(keyOf)
        .sort(),
    ).toEqual(["GET /", "POST /"]);
  });

  it("mọi route của nhóm qua requireAuth, đứng TRƯỚC requireTeamRole", () => {
    const wrong = routes
      .filter((r) => {
        const auth = r.chain.indexOf("requireAuth");
        const guard = r.chain.indexOf("requireTeamRole(");
        return auth === -1 || (guard !== -1 && guard < auth);
      })
      .map(keyOf);
    expect(wrong).toEqual([]);
  });
});

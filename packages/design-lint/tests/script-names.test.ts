import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readRootManifest, readWorkspacePackages } from "./workspace.js";

/**
 * [Plan #63 QĐ-4] Tên script không được trùng một lệnh có sẵn của pnpm.
 *
 * Lệnh có sẵn THẮNG script cùng tên: `pnpm --filter @udp/deploy up` chạy `pnpm update` (`up` là bí danh), không chạy
 * script `up`. Lượt CI đầu tiên (run 37154337078) in đúng điều đó — bước `pnpm deploy:up` "xanh" sau 7,6 giây, không
 * cụm nào được dựng, E2E đỏ `ECONNREFUSED` — và ở máy dev cùng lệnh ấy sửa `package.json` lẫn lockfile.
 *
 * Hỏi CHÍNH pnpm đang ghim chứ không giữ một danh sách viết tay: danh sách lệnh đổi theo phiên bản, và pnpm 9 còn
 * chuyển một loạt tên sang npm (`version`, `view`…) mà `pnpm help` không liệt kê. Phép dò dùng **script đánh dấu**:
 * một thư mục tạm khai MỌI tên làm script `echo <dấu riêng>`, rồi `pnpm <tên> --help` — dấu xuất hiện ⇔ script
 * thắng. Vì tên nào cũng có script, pnpm không bao giờ rơi về `exec`. Bản nháp dò trong thư mục RỖNG theo mã thoát
 * thì rơi về `exec` và chạy chương trình cùng tên trên PATH (gốc repo có script `format`; trên Windows đó là trình
 * định dạng ổ đĩa), cho `exec` xanh giả và `node` đỏ giả.
 *
 * Bốn tên vòng đời mà pnpm cố ý chuyển về script cùng tên được miễn: `test`, `start`, `stop`, `restart`.
 */

const LIFECYCLE = new Set(["test", "start", "stop", "restart"]);
/** Tên đi qua shell (`pnpm` là `.cmd` trên Windows) — chỉ nhận những ký tự không trích dẫn được gì */
const SCRIPT_NAME = /^[a-z0-9][a-z0-9:_-]*$/;
/** Đối chứng dương: một lệnh có sẵn chắc chắn — dấu của nó KHÔNG được xuất hiện */
const TAKEN = "update";
/** Đối chứng âm: một tên chắc chắn trống — dấu của nó PHẢI xuất hiện, không thì phép dò mù */
const FREE = "udp-mark-probe";
const CONCURRENCY = 4;

const root = readRootManifest();
const names = [
  ...new Set(
    [root, ...readWorkspacePackages().map((p) => p.manifest)].flatMap((m) =>
      Object.keys(m.scripts ?? {}),
    ),
  ),
]
  .filter((name) => !name.startsWith("//") && !LIFECYCLE.has(name))
  .sort();
const probed = [...names, TAKEN, FREE];
/** Dấu kết thúc bằng `_` để dấu của tên thứ 1 không là chuỗi con của dấu tên thứ 10 */
const markOf = (name: string): string =>
  `UDP_MARK_${String(probed.indexOf(name))}_`;

const run = promisify(execFile);

async function pnpmIn(
  cwd: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string }> {
  try {
    // `shell: true` chỉ để tìm `pnpm.cmd` trên Windows (cùng lý do với `openfeature-provider/scripts/pack.ts`)
    const { stdout } = await run("pnpm", [...args], {
      cwd,
      shell: true,
      timeout: 60_000,
    });
    return { code: 0, stdout };
  } catch (err: unknown) {
    const { code, stdout } = err as { code?: unknown; stdout?: unknown };
    return {
      code: typeof code === "number" ? code : -1,
      stdout: typeof stdout === "string" ? stdout : "",
    };
  }
}

/** Script có thắng không: `pnpm <tên> --help` in ra dấu của chính tên đó */
async function scriptWins(dir: string, name: string): Promise<boolean> {
  const { stdout } = await pnpmIn(dir, [name, "--help"]);
  return stdout.includes(markOf(name));
}

describe("[Plan #63] tên script không bị lệnh có sẵn của pnpm che", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "udp-script-names-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "udp-script-name-probe",
        private: true,
        packageManager: root.packageManager,
        scripts: Object.fromEntries(
          probed.map((name) => [name, `echo ${markOf(name)}`]),
        ),
      }),
    );
  });

  afterAll(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("có tên để dò, và mọi tên đi qua shell được", () => {
    expect(names.length).toBeGreaterThan(20);
    expect(probed.filter((name) => !SCRIPT_NAME.test(name))).toEqual([]);
  });

  it(
    "phép dò dùng đúng pnpm ghim, và phân biệt được lệnh có sẵn với tên trống",
    { timeout: 120_000 },
    async () => {
      const pinned = /^pnpm@(\d+\.\d+\.\d+)$/.exec(
        root.packageManager ?? "",
      )?.[1];
      expect(pinned, "package.json gốc phải ghim packageManager").toBeDefined();
      const version = await pnpmIn(dir, ["--version"]);
      expect(
        version.stdout.trim(),
        "pnpm của phép dò phải là bản ghim trong packageManager — `corepack enable` cài đúng bản đó",
      ).toBe(pinned);
      expect(await scriptWins(dir, TAKEN), `${TAKEN} là lệnh có sẵn`).toBe(
        false,
      );
      expect(await scriptWins(dir, FREE), `${FREE} là tên trống`).toBe(true);
    },
  );

  it(
    "không script nào của workspace bị một lệnh có sẵn che",
    { timeout: 240_000 },
    async () => {
      const shadowed: string[] = [];
      for (let i = 0; i < names.length; i += CONCURRENCY) {
        const batch = names.slice(i, i + CONCURRENCY);
        const wins = await Promise.all(
          batch.map((name) => scriptWins(dir, name)),
        );
        batch.forEach((name, k) => {
          if (wins[k] !== true) shadowed.push(name);
        });
      }
      expect(shadowed).toEqual([]);
    },
  );
});

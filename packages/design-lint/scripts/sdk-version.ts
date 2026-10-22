import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectVersionOf } from "../src/toml-version.js";

/**
 * [Plan #62 62b-1] Version mà một lượt phát hành SDK sẽ đăng — và nó phải là MỘT số cho cả hai gói.
 *
 * Dùng ở job `gate` của `.github/workflows/publish.yml`: `--expect <số>` so với version của tag. Không viết lại
 * phép đọc TOML trong một tệp `.mjs` của workflow: `projectVersionOf` là nguồn sự thật duy nhất của phép đó, và
 * một bản thứ hai sẽ trôi khỏi bản đầu ở lần sửa đầu tiên mà không ai thấy (R8).
 *
 *   pnpm --filter @udp/design-lint exec tsx scripts/sdk-version.ts            # in version
 *   pnpm --filter @udp/design-lint exec tsx scripts/sdk-version.ts --expect 0.1.0
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const node = JSON.parse(
  readFileSync(
    join(ROOT, "packages", "openfeature-provider", "package.json"),
    "utf8",
  ),
) as { version?: string };
const python = projectVersionOf(
  readFileSync(join(ROOT, "sdks", "python", "pyproject.toml"), "utf8"),
);

if (node.version === undefined) {
  throw new Error("packages/openfeature-provider/package.json thiếu `version`");
}
if (node.version !== python) {
  throw new Error(
    `hai SDK lệch version: gói Node ${node.version}, gói Python ${python}`,
  );
}

const flag = process.argv.indexOf("--expect");
if (flag !== -1) {
  const want = process.argv[flag + 1];
  if (want === undefined || want === "") {
    throw new Error("thiếu giá trị cho --expect");
  }
  if (want !== node.version) {
    throw new Error(
      `version của tag là ${want} nhưng hai manifest ở ${node.version}`,
    );
  }
}

process.stdout.write(`${node.version}\n`);

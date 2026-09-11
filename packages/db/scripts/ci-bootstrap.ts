import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv, parse as parseDotenv } from "dotenv";
import {
  pointAt,
  runNode,
  step,
  withScratchDatabase,
} from "./helpers/scratch-database.js";

/**
 * Chuẩn bị một project Supabase RIÊNG cho CI, một lần.
 *
 *   pnpm db:ci-bootstrap -- --env-file=.env.ci
 *
 * `.env.ci` (bị .gitignore chặn) phải có sẵn hai chuỗi OWNER của project CI,
 * lấy từ Dashboard → Connect: `DATABASE_URL` (Transaction pooler, 6543) và
 * `DATABASE_URL_DIRECT` (Session pooler, 5432, thêm `?sslmode=require`). Script:
 *
 *   1. Dựng một database scratch trên project CI và áp toàn bộ migration. Mục
 *      đích không phải kiểm migration mà là để migration `service_roles` TẠO ba
 *      role `udp_s*` — role là cấp cluster nên tồn tại tiếp sau khi database
 *      scratch bị xoá.
 *   2. Cấp LOGIN cho `udp_s1` và `udp_s2` bằng chính `service-login.ts`, ghi ba
 *      chuỗi role vào `.env.ci` (không vào `.env` của dev).
 *   3. In lệnh nạp secret. Không nạp hộ: đó là thay đổi cấu hình kho mã trên
 *      GitHub, thuộc về người dùng.
 *
 * Vì sao project riêng thay vì Supabase dev: CI đặt được cùng vùng với runner
 * (round trip vài ms thay vì ~220ms Mỹ → Singapore, đúng hình học của triển khai
 * thật nơi S2 và PostgreSQL cùng vùng), mật khẩu của dev không bao giờ rời máy
 * dev, và hai ngân sách 60 kết nối tách nhau. Ba lý do của §13.5 (không Docker,
 * đúng PostgreSQL + Supavisor, có role của nền tảng cho I22) giữ nguyên vì cùng
 * nền tảng.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DB_PKG = resolve(here, "..");
const ROOT = resolve(here, "../../..");
loadDotenv({ path: resolve(ROOT, ".env") });

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const envFile = flag("env-file");
if (envFile === undefined) {
  console.error("Thiếu --env-file=<đường dẫn> (ví dụ --env-file=.env.ci).");
  process.exit(1);
}
const envPath = resolve(ROOT, envFile);
let envText: string;
try {
  envText = readFileSync(envPath, "utf8");
} catch {
  console.error(
    `Không đọc được ${envPath}. Tạo file đó với DATABASE_URL và DATABASE_URL_DIRECT ` +
      `của project CI trước (xem README, mục CI).`,
  );
  process.exit(1);
}
const ci = parseDotenv(envText);

const ciPooled = ci["DATABASE_URL"];
const ciDirect = ci["DATABASE_URL_DIRECT"];
if (ciPooled === undefined || ciDirect === undefined) {
  console.error(
    `${envFile} phải có DATABASE_URL (pooler 6543) và DATABASE_URL_DIRECT (pooler 5432) của project CI.`,
  );
  process.exit(1);
}

/**
 * Hai hàng rào trước khi đụng bất cứ thứ gì:
 *   - project CI phải KHÁC project dev. `service-login` xoay mật khẩu role ở cấp
 *     cluster; chạy nhầm lên dev là phá `.env` đang dùng.
 *   - chuỗi session phải mang `sslmode=require`, vì `pointAt` giữ query string
 *     và Prisma CLI chỉ mã hoá bắt buộc khi được bảo (xem `scratch-database.ts`).
 */
const devDirect = process.env["DATABASE_URL_DIRECT"];
const hostOf = (u: string): string => new URL(u).host;
if (devDirect !== undefined && hostOf(devDirect) === hostOf(ciDirect)) {
  const devUser = new URL(devDirect).username;
  const ciUser = new URL(ciDirect).username;
  if (devUser === ciUser) {
    console.error(
      `${envFile} trỏ vào ĐÚNG project của .env dev (${hostOf(ciDirect)}, ${ciUser}). ` +
        `Bootstrap chỉ dành cho một project Supabase riêng.`,
    );
    process.exit(1);
  }
}
if (new URL(ciDirect).searchParams.get("sslmode") !== "require") {
  console.error(
    `DATABASE_URL_DIRECT trong ${envFile} phải có ?sslmode=require — Prisma CLI ` +
      `chỉ bắt buộc mã hoá khi được bảo.`,
  );
  process.exit(1);
}

const scratch = `udp_scratch_bootstrap_${String(Date.now())}`;

try {
  await withScratchDatabase(ciDirect, scratch, async () => {
    step(
      "1/2 áp migration để tạo role udp_s* trên project CI",
      "prisma",
      ["migrate", "deploy"],
      DB_PKG,
      { ...process.env, DATABASE_URL_DIRECT: pointAt(ciDirect, scratch) },
    );
  });

  // Chuỗi kết nối đi qua argv của một tiến trình node KHÔNG shell — `runNode`
  // tồn tại vì đúng chỗ này. `service-login` đọc `.env` dev để lấy admin, nên
  // phải đè `DATABASE_URL_DIRECT` bằng owner của project CI trong env con
  // (dotenv không ghi đè biến đã có).
  for (const role of ["udp_s1", "udp_s2"]) {
    runNode(
      `2/2 cấp LOGIN cho ${role} trên project CI`,
      "scripts/service-login.ts",
      [
        role,
        `--template=${ciPooled}`,
        `--template-direct=${ciDirect}`,
        `--env-file=${envPath}`,
      ],
      DB_PKG,
      { ...process.env, DATABASE_URL_DIRECT: ciDirect, DATABASE_URL: ciPooled },
    );
  }
} catch (err: unknown) {
  console.error("\nBootstrap thất bại:", (err as Error).message);
  process.exit(1);
}

console.log(`
Project CI đã sẵn sàng. ${envFile} giờ có đủ năm chuỗi. Nạp secret bằng:

  gh secret set -f ${envFile}

rồi commit không được kèm ${envFile} (đã bị .gitignore chặn). Pooler có thể mất
một lúc mới nhận mật khẩu mới — 28P01 ở lượt CI đầu thì chạy lại.
`);

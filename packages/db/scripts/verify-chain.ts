import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { Client } from "pg";
import { DB_TLS_OPTIONS, sanitizeConnectionString } from "../src/adapter.js";

/**
 * Dựng lại TOÀN BỘ chuỗi migration từ số 0 và chứng minh nó chạy được.
 *
 *   pnpm db:verify-chain
 *
 * Vì sao cần: database đang dùng được migrate TĂNG DẦN qua nhiều tháng, nên nó
 * không chứng minh được điều mà một người chấm khóa luận cần — rằng chuỗi
 * migration trong kho mã dựng lại được hệ thống từ đầu. Một migration viết sai
 * thứ tự, hay một GRANT động đóng băng danh sách cột tại thời điểm nó chạy, sẽ
 * không bao giờ lộ ra trên database đã có sẵn.
 *
 * Vì sao dùng một database DÙNG-MỘT-LẦN trên chính Supabase, thay vì Docker:
 *   - Không đòi Docker, nên chạy được ở nơi không có nó.
 *   - Đúng phiên bản đang dùng (PostgreSQL 17.6), đúng Supavisor, đúng TLS —
 *     không phải một bản xấp xỉ.
 *   - Các role riêng của nền tảng (`anon`, `authenticated`, `service_role`) CÓ
 *     tồn tại ở đây, nên khẳng định "không role nào khác được cấp quyền" của
 *     I22 vẫn kiểm thật. Trên một container sạch, ba role đó không tồn tại và
 *     khẳng định ấy xanh vĩnh viễn mà chẳng kiểm gì.
 *   - Không phải hạ chuẩn TLS ở bất cứ đâu để chạy được.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DB_PKG = resolve(here, "..");
const ROOT = resolve(here, "../../..");
loadDotenv({ path: resolve(ROOT, ".env") });

const adminUrl = process.env["DATABASE_URL_DIRECT"];
if (!adminUrl) {
  console.error(
    "DATABASE_URL_DIRECT chưa được đặt — script này cần quyền owner.",
  );
  process.exit(1);
}

/**
 * KHÔNG chạy `db:service-login` ở đây, và đây là lý do.
 *
 * Role trong PostgreSQL là đối tượng cấp CLUSTER, không phải cấp database. Đã
 * đo: từ một database vừa tạo, cả ba role `udp_s*` đều nhìn thấy được và
 * `SET ROLE udp_s1` chạy bình thường. Nghĩa là một lần `ALTER ROLE udp_s1
 * WITH LOGIN PASSWORD` trong lượt kiểm này sẽ xoay mật khẩu của CHÍNH role mà
 * `.env` thật đang dùng — phá hỏng cấu hình đang chạy để đổi lấy một phép kiểm.
 *
 * Không mất gì: `seed.ts`, `tests/helpers/db.ts` và `design-lint/src/db-schema.ts`
 * đều nối bằng `DATABASE_URL_DIRECT` (quyền owner) rồi dùng `SET LOCAL ROLE` để
 * kiểm GRANT — mà quyền `SET ROLE` cũng là cấp cluster nên đã sẵn có.
 */
const scratch = `udp_verify_${String(Date.now())}`;
const base = sanitizeConnectionString(adminUrl);

const urlFor = (source: string): string => {
  const url = new URL(sanitizeConnectionString(source));
  url.pathname = `/${scratch}`;
  return url.toString();
};

const scratchDirect = urlFor(adminUrl);
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: scratchDirect,
  DATABASE_URL_DIRECT: scratchDirect,
  // Chỉ cần hợp lệ về cú pháp để `@udp/config` qua được bước validate; trỏ vào
  // chính database tạm để không lời gọi nhầm nào chạm tới database thật.
  DATABASE_URL_S1: urlFor(process.env["DATABASE_URL_S1"] ?? adminUrl),
  DATABASE_URL_S2: urlFor(process.env["DATABASE_URL_S2"] ?? adminUrl),
  DATABASE_URL_S2_DIRECT: urlFor(
    process.env["DATABASE_URL_S2_DIRECT"] ?? adminUrl,
  ),
  // Lượt kiểm chỉ chạy test của `@udp/db` và `design-lint`, không dựng Service 2 —
  // tắt tầng 3 để `@udp/config` không phụ thuộc kênh LISTEN của `.env` thật. Test
  // NOTIFY của `@udp/db` tự quyết bằng tham số `notify`, không bằng cờ này.
  CHANGEFEED_NOTIFY_ENABLED: "false",
};

const step = (
  label: string,
  cmd: string,
  args: string[],
  cwd: string,
): void => {
  console.log(`\n=== ${label} ===`);
  execFileSync(cmd, args, {
    cwd,
    env: childEnv,
    stdio: "inherit",
    shell: true,
  });
};

const admin = new Client({ connectionString: base, ssl: DB_TLS_OPTIONS });
await admin.connect();

console.log(`Database dùng một lần: ${scratch}`);
await admin.query(`CREATE DATABASE ${scratch}`);

let failed: unknown;
try {
  step(
    "1/4 áp toàn bộ migration lên database TRỐNG",
    "prisma",
    ["migrate", "deploy"],
    DB_PKG,
  );
  step("2/4 seed", "tsx", ["prisma/seed.ts"], DB_PKG);
  step("3/4 test @udp/db", "vitest", ["run"], DB_PKG);
  step(
    "4/4 test @udp/design-lint",
    "vitest",
    ["run"],
    resolve(ROOT, "packages/design-lint"),
  );
} catch (err: unknown) {
  failed = err;
} finally {
  /**
   * `WITH (FORCE)` chứ không phải `DROP DATABASE` trần: đã đo, một kết nối còn
   * treo từ bước trước là đủ để `DROP` thất bại và để lại database rác trên
   * Supabase của người dùng. Dọn dẹp nằm trong `finally` vì một lượt kiểm thất
   * bại càng cần được dọn — đó chính là lúc người ta quên.
   */
  await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  await admin.end();
  console.log(`\nĐã xoá ${scratch}.`);
}

if (failed !== undefined) {
  console.error("\nChuỗi migration KHÔNG dựng lại được từ đầu.");
  process.exit(1);
}

console.log("\nChuỗi migration dựng lại được từ database trống.");

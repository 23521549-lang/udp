import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { Client } from "pg";
import { DB_TLS_OPTIONS, sanitizeConnectionString } from "../src/adapter.js";

/**
 * Cấp quyền đăng nhập cho một service role và ghi chuỗi kết nối vào `.env`.
 *
 * Vì sao là SCRIPT chứ không phải migration: mật khẩu không được nằm trong git.
 * Migration là file được commit và chạy ở mọi môi trường, nên một
 * `ALTER ROLE … PASSWORD 'x'` trong đó là đưa credential vào lịch sử kho mã
 * vĩnh viễn.
 *
 *   pnpm db:service-login              # udp_s1, ghi thẳng vào .env
 *   pnpm db:service-login udp_s2       # role khác
 *   pnpm db:service-login -- --print   # in ra thay vì ghi (xem cảnh báo bên dưới)
 *
 * Chạy lại bao giờ cũng sinh mật khẩu MỚI và thu hồi mật khẩu cũ — đó cũng là
 * cách xoay credential khi cần.
 */

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "../../../.env");
loadDotenv({ path: envPath });

const VALID_ROLES = new Set(["udp_s1", "udp_s2", "udp_s3"]);
const role = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "udp_s1";

if (!VALID_ROLES.has(role)) {
  console.error(`Role không hợp lệ: ${role}. Chỉ nhận: ${[...VALID_ROLES].join(", ")}`);
  process.exit(1);
}

const adminUrl = process.env["DATABASE_URL_DIRECT"];
if (!adminUrl) {
  console.error("DATABASE_URL_DIRECT chưa được đặt — script này cần quyền owner để ALTER ROLE.");
  process.exit(1);
}

// base64url: không ký tự nào cần escape trong chuỗi kết nối hay trong SQL.
const password = randomBytes(24).toString("base64url");

const admin = new Client({
  connectionString: sanitizeConnectionString(adminUrl),
  ssl: DB_TLS_OPTIONS,
});
await admin.connect();

/**
 * ALTER ROLE là utility statement — Postgres KHÔNG nhận tham số ở đây, nên
 * mật khẩu buộc phải nội suy. Đã đo: truyền qua $1 cho lỗi cú pháp.
 *
 * An toàn nhờ hai điều, và cả hai đều được khẳng định chứ không giả định: tên
 * role đã qua danh sách trắng ở trên, và mật khẩu do chính script sinh bằng
 * base64url nên chỉ chứa [A-Za-z0-9_-]. Kiểm lại tập ký tự ngay trước khi nối —
 * nếu ai đó đổi cách sinh mật khẩu, chỗ này phải gãy chứ không được im lặng.
 */
if (!/^[A-Za-z0-9_-]+$/.test(password)) {
  throw new Error("Mật khẩu chứa ký tự ngoài base64url — không được nội suy vào SQL");
}
await admin.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}'`);
await admin.end();

/**
 * Pooler của Supabase định tuyến theo tenant bằng phần sau dấu chấm của username
 * (`<role>.<project-ref>`). Đã đo: `udp_s1.<ref>` nối được và `current_user`
 * đúng là `udp_s1`, còn `udp_s1` trần bị từ chối với "no tenant identifier".
 */
const url = new URL(sanitizeConnectionString(process.env["DATABASE_URL"] ?? adminUrl));
const ref = url.username.includes(".") ? url.username.split(".")[1] : undefined;
url.username = ref === undefined ? role : `${role}.${ref}`;
url.password = password;

const varName = `DATABASE_URL_${role.slice(-2).toUpperCase()}`;
const line = `${varName}="${url.toString()}"`;

/**
 * Mặc định GHI vào `.env`, không in ra.
 *
 * Mật khẩu in ra stdout sẽ nằm lại trong lịch sử terminal, trong log CI, và
 * trong bất cứ transcript nào ghi phiên làm việc. `--print` chỉ dành cho lúc
 * thật sự phải dán tay sang nơi khác.
 */
if (process.argv.includes("--print")) {
  console.log(`\nĐã cấp LOGIN cho ${role}. Dán dòng sau vào .env:\n`);
  console.log(`${line}\n`);
} else {
  const current = readFileSync(envPath, "utf8");
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const pattern = new RegExp(`^${varName}=.*$`, "m");

  const next = pattern.test(current)
    ? current.replace(pattern, line)
    : `${current.trimEnd()}${eol}${eol}${line}${eol}`;

  writeFileSync(envPath, next.replace(/\r?\n/g, eol), "utf8");
  console.log(`\nĐã cấp LOGIN cho ${role} và ghi ${varName} vào .env.`);
  console.log("Mật khẩu KHÔNG được in ra — chạy lại script này để xoay.\n");
}

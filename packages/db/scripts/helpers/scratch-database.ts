import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { DB_TLS_OPTIONS, sanitizeConnectionString } from "../../src/adapter.js";

/**
 * Database dùng-một-lần ("scratch") — nơi DUY NHẤT định nghĩa nó là gì, đặt tên
 * thế nào, dựng và xoá ra sao.
 *
 * Trước đây toàn bộ việc này nằm trong `verify-chain.ts`. Khi bộ test đầy đủ
 * cũng cần một database như thế (`test-scratch.ts`), và CI cần một lệnh xoá
 * riêng cho ca job bị huỷ giữa chừng (`scratch-drop.ts`), thì ba nơi tự dựng
 * lại "database tạm" sẽ trôi khỏi nhau đúng ở chỗ nguy hiểm nhất: một nơi quên
 * `WITH (FORCE)`, một nơi cho phép tên `postgres`. Tách ra đây để ba điểm vào
 * chỉ còn khác nhau ở việc chúng CHẠY GÌ trên database đó.
 *
 * Vì sao là database trên chính Supabase chứ không phải Docker: xem chú thích
 * đầu `verify-chain.ts` và §13.5 của thiết kế.
 */

/**
 * Tên hợp lệ của một database scratch.
 *
 * Tiền tố nói AI tạo ra nó (`udp_verify_` là `verify-chain`, `udp_scratch_` là
 * bộ test đầy đủ hoặc bootstrap). Đây đồng thời là hàng rào của `scratch-drop`:
 * một biến môi trường sai trong CI không bao giờ được biến thành
 * `DROP DATABASE postgres`. Tên vẫn đi qua `escapeIdentifier` khi ghép SQL —
 * pattern là ý định, escape là cơ chế; giữ cả hai.
 */
export const SCRATCH_NAME_PATTERN = /^udp_(?:verify|scratch)_[a-z0-9_]{1,50}$/;

export function assertScratchName(name: string): string {
  if (!SCRATCH_NAME_PATTERN.test(name)) {
    throw new Error(
      `Tên database scratch "${name}" không hợp lệ — phải khớp ${String(SCRATCH_NAME_PATTERN)}. ` +
        `Hàng rào này tồn tại để không lệnh nào xoá nhầm database thật.`,
    );
  }
  return name;
}

/**
 * Tên cho bộ test đầy đủ: CI đặt tất định qua `UDP_SCRATCH_DB_NAME`
 * (`udp_scratch_ci_<run_id>_<run_attempt>`) để bước dọn của nó biết đúng tên
 * cần xoá; cục bộ không đặt thì lấy theo thời điểm.
 *
 * `verify-chain` KHÔNG gọi hàm này mà đặt tên thẳng: một biến còn sót trong
 * shell không được phép đổi hành vi của một lệnh vốn không liên quan tới CI.
 */
export function scratchNameFromEnv(prefix: "udp_scratch"): string {
  const fromEnv = process.env["UDP_SCRATCH_DB_NAME"];
  return fromEnv === undefined || fromEnv === ""
    ? `${prefix}_${String(Date.now())}`
    : assertScratchName(fromEnv);
}

/**
 * Biến môi trường nào là chuỗi kết nối database.
 *
 * Khớp theo mẫu thay vì liệt kê năm tên, để ngày `DATABASE_URL_S3` ra đời nó tự
 * được trỏ sang database scratch. Một biến bị bỏ sót ở đây là một test chạy trên
 * database THẬT mà không ai biết — `assertScratchIdentity` là lưới thứ hai cho
 * đúng ca đó.
 */
export const CONNECTION_VAR_PATTERN = /^DATABASE_URL(?:_|$)/;

/**
 * Trỏ một chuỗi kết nối sang database `name`, GIỮ NGUYÊN phần còn lại.
 *
 * Giữ cả query string là có chủ đích: `DATABASE_URL_DIRECT` mang `sslmode=require`
 * cho Prisma CLI (xem `.env.example`). Bản đầu của `verify-chain` đưa chuỗi qua
 * `sanitizeConnectionString` trước khi đổi tên, tức gỡ mất `sslmode` và Prisma
 * rơi về `prefer` — một pooler chấp nhận kết nối không mã hoá (đã đo) thì
 * `prefer` là hạ cấp được. Mọi nơi mở kết nối bằng `pg` đều tự gỡ `sslmode`
 * qua `sanitizeConnectionString`, nên giữ ở đây không làm ai hỏng.
 */
export function pointAt(connectionString: string, name: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Role mà một chuỗi kết nối SẼ mang sau khi nối.
 *
 * Pooler của Supabase định tuyến bằng `<role>.<project-ref>` trong username
 * (xem `service-login.ts`), còn `current_user` chỉ là phần trước dấu chấm.
 */
export function expectedRoleOf(connectionString: string): string {
  const user = decodeURIComponent(new URL(connectionString).username);
  return user.includes(".") ? user.slice(0, user.indexOf(".")) : user;
}

/** Các cặp (tên biến, chuỗi kết nối) có trong `env` */
export function connectionStringsIn(
  env: NodeJS.ProcessEnv,
): [name: string, value: string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(env)) {
    if (CONNECTION_VAR_PATTERN.test(key) && value !== undefined && value !== "")
      out.push([key, value]);
  }
  return out;
}

/**
 * Env cho tiến trình con: mọi chuỗi kết nối trỏ sang database scratch, rồi
 * `overrides` đè lên trên. Không đụng biến nào khác.
 */
export function scratchEnv(
  base: NodeJS.ProcessEnv,
  name: string,
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of connectionStringsIn(base)) {
    out[key] = pointAt(value, name);
  }
  return { ...out, ...overrides };
}

/**
 * Che chuỗi kết nối DẪN XUẤT trong log của GitHub Actions.
 *
 * GitHub chỉ che đúng giá trị của secret. Chuỗi đã đổi pathname là một chuỗi
 * MỚI, mang nguyên mật khẩu, và không được che — Prisma in datasource khi
 * migrate hỏng, `boot-identity` in toàn bộ stderr của tiến trình con. Lệnh
 * `::add-mask::` đọc từ stdout, nên chỉ cần in trước khi chạy bất cứ bước nào.
 * Che thêm bản đã gỡ `sslmode` (thứ `pg` thật sự cầm) và riêng mật khẩu.
 *
 * Trả về số dòng đã in để test kiểm được mà không cần bắt stdout.
 */
export function maskForGitHub(
  env: NodeJS.ProcessEnv,
  emit: (line: string) => void = (line) => {
    console.log(line);
  },
): number {
  if (process.env["GITHUB_ACTIONS"] !== "true") return 0;
  const masked = new Set<string>();
  for (const [, value] of connectionStringsIn(env)) {
    masked.add(value);
    masked.add(sanitizeConnectionString(value));
    const password = decodeURIComponent(new URL(value).password);
    // Mật khẩu quá ngắn mà che thì log biến thành toàn dấu sao ở những chỗ
    // không liên quan; base64url 24 byte của `service-login` dài 32.
    if (password.length >= 12) masked.add(password);
  }
  for (const value of masked) emit(`::add-mask::${value}`);
  return masked.size;
}

/** Thời gian kết nối và thời gian một truy vấn quản trị được phép kéo dài */
const ADMIN_TIMEOUT_MS = 30_000;

function adminClient(connectionString: string): Client {
  return new Client({
    connectionString: sanitizeConnectionString(connectionString),
    ssl: DB_TLS_OPTIONS,
    connectionTimeoutMillis: ADMIN_TIMEOUT_MS,
    query_timeout: ADMIN_TIMEOUT_MS,
  });
}

/**
 * Chốt: MỌI chuỗi kết nối trong env con thật sự trỏ vào database scratch và
 * mang đúng role.
 *
 * §1.2 bắt service khẳng định `current_user` lúc boot, nhưng không gì khẳng định
 * `current_database`. Ở CI, thứ duy nhất đứng giữa bộ test và database THẬT là
 * `scratchEnv` — một biến mới không khớp `CONNECTION_VAR_PATTERN`, hay một test
 * tự dựng chuỗi, là test chạy trên dữ liệu dev mà không ai báo. Tốn vài giây
 * mỗi lượt để biến giả định đó thành bảo đảm.
 */
export async function assertScratchIdentity(
  env: NodeJS.ProcessEnv,
  name: string,
): Promise<void> {
  const problems: string[] = [];
  for (const [key, value] of connectionStringsIn(env)) {
    const client = adminClient(value);
    try {
      await client.connect();
      const rows = await client.query<{ role: string; db: string }>(
        "SELECT current_user AS role, current_database() AS db",
      );
      const row = rows.rows[0];
      const expected = expectedRoleOf(value);
      if (row === undefined) problems.push(`${key}: không đọc được danh tính`);
      else if (row.db !== name)
        problems.push(`${key}: đang ở database "${row.db}", phải là "${name}"`);
      else if (row.role !== expected)
        problems.push(`${key}: role "${row.role}", phải là "${expected}"`);
    } catch (err: unknown) {
      problems.push(`${key}: không nối được — ${(err as Error).message}`);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Env con KHÔNG trỏ đúng database scratch:\n  - ${problems.join("\n  - ")}`,
    );
  }
}

/**
 * Độ trễ một vòng đi về tới database (ms), trung vị của vài mẫu trên MỘT kết
 * nối đã mở. In ra ở đầu mỗi lượt để biết con số của CI khác con số của máy dev
 * bao nhiêu — bộ test tích hợp bị chi phối bởi số round trip nhân với con số này.
 */
export async function measureRoundTripMs(
  connectionString: string,
  samples = 5,
): Promise<number> {
  const client = adminClient(connectionString);
  await client.connect();
  try {
    await client.query("SELECT 1"); // làm nóng, không tính
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
      const t0 = process.hrtime.bigint();
      await client.query("SELECT 1");
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)] ?? Number.NaN;
  } finally {
    await client.end();
  }
}

/**
 * Xoá database scratch. Idempotent: không tồn tại thì báo `absent`, không ném —
 * bước dọn của CI chạy sau cả lượt thành công (database đã bị `finally` xoá).
 *
 * `WITH (FORCE)` là bắt buộc chứ không phải phòng xa: Supavisor GIỮ backend tới
 * database sau khi client đã đóng (đã đo: 3 client đóng xong vẫn còn 3 backend
 * idle sau 30 giây), và một backend còn treo là đủ để `DROP` trần thất bại.
 */
export async function dropScratchDatabase(
  adminUrl: string,
  name: string,
): Promise<"dropped" | "absent"> {
  assertScratchName(name);
  const admin = adminClient(adminUrl);
  await admin.connect();
  try {
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name],
    );
    if (exists.rowCount === 0) return "absent";
    await admin.query(
      `DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`,
    );
    return "dropped";
  } finally {
    await admin.end();
  }
}

/**
 * Dựng database scratch, chạy `body`, rồi LUÔN xoá.
 *
 * Kết nối tạo database được đóng ngay sau `CREATE`, và việc xoá dùng một kết
 * nối MỚI có hạn chờ: một kết nối ngồi không suốt 10 phút test rồi mới `DROP`
 * là một giả định về mạng của runner mà không ai kiểm được. Lỗi của `body` được
 * ném lại SAU khi dọn; nếu chính việc dọn hỏng thì in lỗi của `body` trước, để
 * không mất nguyên nhân gốc.
 *
 * Cả hai lỗi đều không được nuốt: một database còn sót trên Supabase của người
 * dùng là thứ họ phải biết.
 */
export async function withScratchDatabase(
  adminUrl: string,
  name: string,
  body: () => Promise<void>,
): Promise<void> {
  assertScratchName(name);
  const creator = adminClient(adminUrl);
  await creator.connect();
  try {
    await creator.query(`CREATE DATABASE ${creator.escapeIdentifier(name)}`);
  } finally {
    await creator.end();
  }
  console.log(`Database dùng một lần: ${name}`);

  let failure: unknown;
  try {
    await body();
  } catch (err: unknown) {
    failure = err;
  }

  try {
    const outcome = await dropScratchDatabase(adminUrl, name);
    console.log(
      outcome === "dropped"
        ? `\nĐã xoá ${name}.`
        : `\n${name} không còn tồn tại, không có gì để dọn.`,
    );
  } catch (dropErr: unknown) {
    if (failure !== undefined)
      console.error("Lượt chạy đã lỗi trước đó:", failure);
    throw dropErr;
  }
  if (failure !== undefined) throw failure;
}

/**
 * Chạy một lệnh con, nối thẳng stdio, ném khi mã thoát khác 0.
 *
 * `shell: true` để `pnpm`/`prisma`/`tsx` (là `.cmd` trên Windows) chạy được;
 * vì thế `args` ở đây chỉ được là những giá trị không có ký tự đặc biệt của
 * shell — chuỗi kết nối KHÔNG được đi qua đường này (có `&` trong query string).
 * Thứ cần chuỗi kết nối thì dùng `runNode`.
 */
export function step(
  label: string,
  cmd: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  console.log(`\n=== ${label} ===`);
  execFileSync(cmd, [...args], { cwd, env, stdio: "inherit", shell: true });
}

/**
 * Chạy một file TypeScript bằng chính Node đang chạy, KHÔNG qua shell.
 *
 * Dành cho lúc tham số là chuỗi kết nối: không shell thì không có gì để escape,
 * và không có ký tự `&` nào bị hiểu thành "chạy nền".
 */
export function runNode(
  label: string,
  script: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  console.log(`\n=== ${label} ===`);
  execFileSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd,
    env,
    stdio: "inherit",
  });
}
